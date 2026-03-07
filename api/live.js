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

  // Cap at 24h to exclude ghost records; client applies the user's selected time filter
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
    entryTime: null,        // API does not return actual entry timestamp
    area:      l.areaName ?? "—",
    role:      l.professionalRole ?? null,
    totalTime: l.totalTime, // minutes inside — used by client for filtering and display
  }));
}
