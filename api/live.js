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

  if (req.query.probe === "1") {
    try {
      const loginData = await doLogin();
      const token = loginData?.data?.token;
      const auth = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
      const now = Math.floor(Date.now() / 1000);

      const tests = [
        // /accesslog/persons — the suggestion
        { label: "accesslog/persons (no params)",
          url: `${BASE}/accesslog/persons` },
        { label: "accesslog/persons pageSize+pageNumber",
          url: `${BASE}/accesslog/persons?pageSize=5&pageNumber=1` },
        { label: "accesslog/persons + sortField=Name",
          url: `${BASE}/accesslog/persons?pageSize=5&pageNumber=1&sortField=Name&sortOrder=asc` },
        { label: "accesslog/persons + sortField=name",
          url: `${BASE}/accesslog/persons?pageSize=5&pageNumber=1&sortField=name&sortOrder=asc` },

        // actualLocation with correct sort fields from Swagger
        { label: "actualLocation sortField=PersonName",
          url: `${BASE}/reports/actualLocation?pageSize=5&pageNumber=1&sortField=PersonName&sortOrder=asc` },
        { label: "actualLocation sortField=EnteredAt",
          url: `${BASE}/reports/actualLocation?pageSize=5&pageNumber=1&sortField=EnteredAt&sortOrder=desc` },
        { label: "actualLocation sortField=Id",
          url: `${BASE}/reports/actualLocation?pageSize=5&pageNumber=1&sortField=Id&sortOrder=asc` },

        // persons with correct sortField
        { label: "persons sortField=Name",
          url: `${BASE}/persons?pageSize=5&pageNumber=1&sortField=Name&sortOrder=asc` },

        // Try accesslog/logs with no date range (maybe dtStart/dtEnd is the issue)
        { label: "accesslog/logs no date range",
          url: `${BASE}/accesslog/logs?pageSize=5&pageNumber=1&sortField=Time&sortOrder=desc&ignoreCount=true` },
      ];

      const results = await Promise.all(tests.map(async (t) => {
        const r = await fetch(t.url, { headers: auth });
        const txt = await r.text();
        return { label: t.label, status: r.status, body: txt.slice(0, 400) };
      }));

      return res.status(200).json({ results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Normal path
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
  // Placeholder — will be updated once we find which endpoint works
  const r = await fetch(`${BASE}/reports/actualLocation?pageSize=500&pageNumber=1&sortField=PersonName&sortOrder=asc`, {
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`iDSecure ${r.status}: ${await r.text()}`);
  const body = await r.json();
  const locs = Array.isArray(body) ? body : (body?.data ?? []);
  return locs.map(l => ({
    id:        l.personId,
    name:      l.personName ?? "Unknown",
    photo:     null,
    entryTime: l.enteredAt ?? null,
    door:      l.areaName ?? "—",
  }));
}
