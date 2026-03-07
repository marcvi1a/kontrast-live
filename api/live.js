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

    const members = await getRecentAccess(token);
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ members, fetchedAt: Date.now(), updatedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch members", detail: err.message });
  }
}

function parseLogs(body) {
  const raw = Array.isArray(body) ? body
            : Array.isArray(body?.data) ? body.data
            : (body?.data?.data ?? []);
  return raw;
}

function deduplicateByPerson(logs) {
  const seen = new Map();
  for (const l of logs) {
    const pid = l.personId;
    if (!pid) continue;
    if (!seen.has(pid)) {
      seen.set(pid, l);
    }
  }
  return seen;
}

async function getRecentAccess(token) {
  const authHdr = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

  // 1) Full list without photos (supports high Quantity)
  const fullReq = fetch(
    `${DATA_BASE}/accesslog/last?getPhotos=false&Quantity=1000`,
    { headers: authHdr }
  );

  // 2) Recent entries with photos (limited Quantity to avoid payload issues)
  const photoReq = fetch(
    `${DATA_BASE}/accesslog/last?getPhotos=true&Quantity=100`,
    { headers: authHdr }
  );

  const [fullRes, photoRes] = await Promise.all([fullReq, photoReq]);

  if (!fullRes.ok) throw new Error(`iDSecure full ${fullRes.status}: ${await fullRes.text()}`);
  const fullLogs = parseLogs(await fullRes.json());

  // Build photo map from the photo response (keyed by personId)
  const photoMap = new Map();
  if (photoRes.ok) {
    const photoLogs = parseLogs(await photoRes.json());
    for (const l of photoLogs) {
      if (l.personId && l.personAvatar && !photoMap.has(l.personId)) {
        const avatar = l.personAvatar;
        photoMap.set(l.personId, avatar.startsWith("data:") ? avatar : `data:image/jpeg;base64,${avatar}`);
      }
    }
  }

  if (!fullLogs.length) return [];

  // Deduplicate — keep only the most recent entry per person
  const seen = deduplicateByPerson(fullLogs);

  // "Yesterday or sooner" = start of yesterday onwards
  const startOfYesterday = new Date();
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  startOfYesterday.setHours(0, 0, 0, 0);
  const yesterdayCutoff = startOfYesterday.getTime();

  return Array.from(seen.values()).map(l => {
    const entryTime = l.time ?? null;
    const entryMs = entryTime ? new Date(entryTime).getTime() : 0;
    // Only attach photo if the entry is from yesterday or sooner (today)
    const photo = (entryMs >= yesterdayCutoff) ? (photoMap.get(l.personId) ?? null) : null;

    return {
      id:        l.personId,
      name:      l.personName ?? "Desconhecido",
      photo,
      entryTime,
      area:      l.areaName ?? l.deviceName ?? "—",
    };
  });
}
