// api/live.js — Vercel Serverless Function
const BASE     = "https://main.idsecure.com.br:5000/api/v1";
const EMAIL    = process.env.IDSECURE_EMAIL;
const PASSWORD = process.env.IDSECURE_PASSWORD;

function setCors(res) {
  const allowed = process.env.ALLOWED_ORIGIN || "https://live.kontrast.com.br";
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

  // ?raw=1 — inspect actual field names from actualLocation
  if (req.query.raw === "1") {
    try {
      const loginData = await doLogin();
      const token = loginData?.data?.token;
      const r = await fetch(
        `${BASE}/reports/actualLocation?pageSize=3&pageNumber=1&sortField=EnteredAt&sortOrder=desc`,
        { headers: { "Authorization": `Bearer ${token}` } }
      );
      const body = await r.json();
      // Return the raw first record so we can see all field names
      const record = body?.data?.data?.[0] ?? body?.data?.[0] ?? body?.[0] ?? body;
      return res.status(200).json({ raw_keys: Object.keys(record ?? {}), sample: record });
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
    return res.status(200).json({ members, updatedAt: new Date().toISOString() });
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
    entryTime: new Date(Date.now() - l.totalTime * 60 * 1000).toISOString(),
    area:      l.areaName ?? "—",
    role:      l.professionalRole ?? null,
    totalTime: l.totalTime,
  }));
}
