// api/live.js — Vercel Serverless Function
// Uses /reports/actualLocation — who is currently inside right now
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
    return res.status(200).json({ members, updatedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch members", detail: err.message });
  }
}

async function getMembersInHouse(token) {
  // /reports/actualLocation returns who is physically inside right now
  const params = new URLSearchParams({
    pageSize:   "500",
    pageNumber: "1",
    sortField:  "EnteredAt",
    sortOrder:  "desc",
  });

  const r = await fetch(`${BASE}/reports/actualLocation?${params}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
    },
  });
  if (!r.ok) throw new Error(`iDSecure ${r.status} on /reports/actualLocation: ${await r.text()}`);

  const body = await r.json();
  const locs = Array.isArray(body) ? body
             : Array.isArray(body?.data) ? body.data
             : (body?.data?.data ?? []);

  // Filter to real people only (personType 1 = Person, exclude visitors/operators if needed)
  return locs
    .filter(l => l.personId && l.personName)
    .map(l => ({
      id:        l.personId,
      name:      l.personName,
      photo:     l.personAvatar ? `data:image/jpeg;base64,${l.personAvatar}` : null,
      entryTime: l.enteredAt ?? null,
      area:      l.areaName ?? "—",
      role:      l.professionalRole ?? null,
      company:   l.companyDescription || null,
      totalTime: l.totalTime ?? null,   // minutes inside
    }));
}
