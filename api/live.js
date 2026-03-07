// api/live.js — Vercel Serverless Function
const LOGIN_BASE = "https://main.idsecure.com.br:5000/api/v1";
const DATA_BASE  = "https://report.idsecure.com.br:5000/api/v1";
const EMAIL      = process.env.IDSECURE_EMAIL;
const PASSWORD   = process.env.IDSECURE_PASSWORD;

function setCors(res) {
  const allowed = process.env.ALLOWED_ORIGIN || "https://kontrast.com.br";
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function doLogin() {
  const r = await fetch(`${LOGIN_BASE}/operators/login`, {
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

    const { members, _rawSample } = await getRecentAccess(token);
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ members, _rawSample, fetchedAt: Date.now(), updatedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch members", detail: err.message });
  }
}

async function getRecentAccess(token) {
  const authHdr = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

  const r = await fetch(
    `${DATA_BASE}/accesslog/last?getPhotos=true&pageSize=500`,
    { headers: authHdr }
  );
  if (!r.ok) throw new Error(`iDSecure ${r.status}: ${await r.text()}`);

  const body = await r.json();
  const logs = Array.isArray(body) ? body
             : Array.isArray(body?.data) ? body.data
             : (body?.data?.data ?? []);

  if (!logs.length) return { members: [], _rawSample: null };

  // Debug: first raw entry with long strings (photos) truncated
  const _rawSample = Object.fromEntries(
    Object.entries(logs[0]).map(([k, v]) =>
      [k, typeof v === "string" && v.length > 200 ? `[${v.length} chars]` : v]
    )
  );

  // Deduplicate by personId — keep only the most recent entry per person
  const seen = new Map();
  for (const l of logs) {
    const pid = l.personId;
    if (!pid) continue;
    if (!seen.has(pid)) {
      seen.set(pid, l);
    }
  }

  const members = Array.from(seen.values()).map(l => ({
    id:        l.personId,
    name:      l.personName ?? "Desconhecido",
    photo:     l.personAvatar ? `data:image/jpeg;base64,${l.personAvatar}` : null,
    entryTime: l.time ?? null,
    area:      l.areaName ?? l.deviceName ?? "—",
  }));

  return { members, _rawSample };
}
