// api/live.js — Vercel Serverless Function
const BASE     = "https://main.idsecure.com.br:5000/api/v1";
const EMAIL    = process.env.IDSECURE_EMAIL;
const PASSWORD = process.env.IDSECURE_PASSWORD;

function setCors(res) {
  const allowed = process.env.ALLOWED_ORIGIN || "https://kontrast.com.br";
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function doLogin() {
  const r = await fetch(`${BASE}/operators/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`Login failed ${r.status}: ${await r.text()}`);
  return r.json();
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // ?probe=1 — test multiple endpoints to find which ones work
  if (req.query.probe === "1") {
    try {
      const loginData = await doLogin();
      const token = loginData?.data?.token;

      const now = Math.floor(Date.now() / 1000);
      const authHdr = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

      const tests = [
        // actualLocation — who is currently inside (perfect for our use case)
        { label: "actualLocation (pageSize+pageNumber only)",
          url: `${BASE}/reports/actualLocation?pageSize=5&pageNumber=1` },
        { label: "actualLocation + sortField=personName",
          url: `${BASE}/reports/actualLocation?pageSize=5&pageNumber=1&sortField=personName&sortOrder=asc` },
        { label: "actualLocation + sortField=name",
          url: `${BASE}/reports/actualLocation?pageSize=5&pageNumber=1&sortField=name&sortOrder=asc` },
        // accesslog with different endpoints
        { label: "accesslog/last (no params)",
          url: `${BASE}/accesslog/last` },
        { label: "dashboard/last (no params)",
          url: `${BASE}/dashboard/last` },
        { label: "dashboard/lastdayaccess",
          url: `${BASE}/dashboard/lastdayaccess?pageSize=5&pageNumber=1&sortField=Time&sortOrder=desc` },
        // persons endpoint to verify auth works at all
        { label: "persons list",
          url: `${BASE}/persons?pageSize=5&pageNumber=1` },
        // accesslog/logs with sortField=time (lowercase)
        { label: "accesslog/logs sortField=time (lowercase)",
          url: `${BASE}/accesslog/logs?pageSize=5&pageNumber=1&sortField=time&sortOrder=desc&dtStart=${now-10800}&dtEnd=${now}&ignoreCount=true` },
      ];

      const results = await Promise.all(tests.map(async (t) => {
        const r = await fetch(t.url, { headers: authHdr });
        const txt = await r.text();
        return { label: t.label, status: r.status, body: txt.slice(0, 300) };
      }));

      return res.status(200).json({ results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Normal path — uses actualLocation
  try {
    const loginData = await doLogin();
    const token = loginData?.data?.token;
    if (!token) throw new Error(`No token: ${JSON.stringify(loginData)}`);

    const members = await getMembersInHouse(token);
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ members, updatedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch members", detail: err.message });
  }
}

async function getMembersInHouse(token) {
  // /reports/actualLocation — shows who is currently inside
  const params = new URLSearchParams({
    pageSize: "500", pageNumber: "1",
    sortField: "personName", sortOrder: "asc",
  });

  const r = await fetch(`${BASE}/reports/actualLocation?${params}`, {
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`iDSecure ${r.status} on /reports/actualLocation: ${await r.text()}`);

  const body = await r.json();
  const locs = Array.isArray(body) ? body : (body?.data ?? []);
  if (!locs.length) return [];

  return locs.map(l => ({
    id:        l.personId,
    name:      l.personName ?? l.person?.name ?? "Unknown",
    photo:     l.personAvatar ? `data:image/jpeg;base64,${l.personAvatar}` : null,
    entryTime: l.enteredAt ?? l.time ?? null,
    door:      l.areaName ?? l.area?.name ?? "—",
  }));
}
