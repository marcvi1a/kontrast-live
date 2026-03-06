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

  // ?probe=1 — test all candidate endpoints
  if (req.query.probe === "1") {
    try {
      const loginData = await doLogin();
      const token = loginData?.data?.token;
      const auth = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
      const now = Math.floor(Date.now() / 1000);

      const tests = [
        { label: "accesslog/last",
          url: `${BASE}/accesslog/last` },
        { label: "accesslog/last?pageSize=3",
          url: `${BASE}/accesslog/last?pageSize=3&pageNumber=1` },
        { label: "accesslog/logs (no params)",
          url: `${BASE}/accesslog/logs?pageSize=3&pageNumber=1&sortField=Time&sortOrder=desc&ignoreCount=true` },
        { label: "accesslog/logs (with dates)",
          url: `${BASE}/accesslog/logs?pageSize=3&pageNumber=1&sortField=Time&sortOrder=desc&dtStart=${now-14400}&dtEnd=${now}&ignoreCount=true` },
        { label: "accesslog/persons",
          url: `${BASE}/accesslog/persons?pageSize=3&pageNumber=1&sortField=Name&sortOrder=asc` },
        { label: "accesslog/visitors",
          url: `${BASE}/accesslog/visitors?pageSize=3&pageNumber=1` },
        { label: "dashboard/last",
          url: `${BASE}/dashboard/last` },
        { label: "dashboard/last?pageSize=3",
          url: `${BASE}/dashboard/last?pageSize=3&pageNumber=1` },
        { label: "reports/actualLocation (current)",
          url: `${BASE}/reports/actualLocation?pageSize=3&pageNumber=1&sortField=EnteredAt&sortOrder=desc` },
      ];

      const results = await Promise.all(tests.map(async (t) => {
        try {
          const r = await fetch(t.url, { headers: auth });
          const txt = await r.text();
          let parsed = null;
          try { parsed = JSON.parse(txt); } catch {}
          // Show keys of first record if available
          const firstRecord = parsed?.data?.data?.[0] ?? parsed?.data?.[0] ?? (Array.isArray(parsed) ? parsed[0] : null);
          return {
            label: t.label,
            status: r.status,
            keys: firstRecord ? Object.keys(firstRecord) : null,
            sample: firstRecord ?? txt.slice(0, 300),
          };
        } catch (err) {
          return { label: t.label, status: "error", sample: err.message };
        }
      }));

      return res.status(200).json({ results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    const loginData = await doLogin();
    const token = loginData?.data?.token;
    if (!token) throw new Error(`No token: ${JSON.stringify(loginData)}`);

    const members = await getMembersInHouse(token);
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ members, fetchedAt: Date.now(), updatedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch members", detail: err.message });
  }
}

async function getMembersInHouse(token) {
  const authHdr = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

  const r = await fetch(
    `${BASE}/reports/actualLocation?pageSize=500&pageNumber=1&sortField=EnteredAt&sortOrder=desc`,
    { headers: authHdr }
  );
  if (!r.ok) throw new Error(`iDSecure ${r.status}: ${await r.text()}`);

  const body = await r.json();
  const locs = Array.isArray(body) ? body
             : Array.isArray(body?.data) ? body.data
             : (body?.data?.data ?? []);

  if (!locs.length) return [];

  // Return all members with reasonable totalTime (cap at 24h to exclude ghost records)
  // Client-side JS applies the user's selected time filter
  const MAX_MINUTES = 24 * 60;
  const filtered = locs.filter(l =>
    l.personId &&
    l.personName &&
    typeof l.totalTime === "number" &&
    l.totalTime <= MAX_MINUTES
  );

  return filtered.map(l => ({
    id:        l.personId,
    name:      l.personName,
    photo:     null,
    entryTime: null,          // API does not return actual entry timestamp
    area:      l.areaName ?? "—",
    role:      l.professionalRole ?? null,
    totalTime: l.totalTime,   // minutes inside — used by client for filtering and display
  }));
}
