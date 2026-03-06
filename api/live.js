// api/live.js — Vercel Serverless Function
// Uses iDSecure REST API v1: https://main.idsecure.com.br:5000/api/v1

const BASE = "https://main.idsecure.com.br:5000/api/v1";
const EMAIL = process.env.IDSECURE_EMAIL;
const PASSWORD = process.env.IDSECURE_PASSWORD;

// ─── CORS ────────────────────────────────────────────────────────────────────
function setCors(res) {
  const allowed = process.env.ALLOWED_ORIGIN || "https://kontrast.com.br";
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const token = await login();
    const members = await getMembersInHouse(token);
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ members, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: "Failed to fetch members", detail: err.message });
  }
}

// ─── Step 1: Login and get JWT ────────────────────────────────────────────────
async function login() {
  const res = await fetch(`${BASE}/operators/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Login failed ${res.status}: ${text}`);
  }
  const data = await res.json();
  const token = data?.data?.token ?? data.token ?? data.accessToken ?? data.jwt;
  if (!token) throw new Error(`No token in login response: ${JSON.stringify(data)}`);
  return token;
}

// ─── Step 2: Fetch access logs from last 3 hours ──────────────────────────────
async function getMembersInHouse(token) {
  // API expects Unix timestamps in seconds (as float/double)
  const dtEnd   = Date.now() / 1000;
  const dtStart = dtEnd - (3 * 60 * 60);

  const params = new URLSearchParams({
    pageSize:    "500",
    pageNumber:  "1",
    sortField:   "Time",
    sortOrder:   "desc",
    dtStart:     dtStart.toFixed(0),
    dtEnd:       dtEnd.toFixed(0),
    getPhotos:   "true",
    ignoreCount: "true",
  });

  const res = await apiFetch(token, `/accesslog/logs?${params}`);

  // Response is wrapped: { success, data: { records: [...], ... } } or similar
  const raw = res?.data ?? res;
  const logs = Array.isArray(raw)
    ? raw
    : (raw?.records ?? raw?.logs ?? raw?.items ?? raw?.list ?? []);

  if (logs.length === 0) return [];

  // Deduplicate: one entry per person, most recent only
  const latestByPerson = new Map();
  for (const log of logs) {
    const pid = log.personId ?? log.person_id ?? log.id_person ?? log.userId;
    if (pid && !latestByPerson.has(pid)) {
      latestByPerson.set(pid, log);
    }
  }

  const members = [...latestByPerson.entries()].map(([pid, log]) => {
    // Photo may come inline as base64 when getPhotos=true
    let photo = null;
    const b64 = log.photo ?? log.image ?? log.personPhoto ?? log.picture;
    if (b64) photo = `data:image/jpeg;base64,${b64}`;

    return {
      id: pid,
      name: log.personName ?? log.person_name ?? log.name ?? log.userName ?? "Unknown",
      photo,
      entryTime: log.time ?? log.dateTime ?? log.date_time ?? log.timestamp ?? log.createdAt,
      door: log.deviceName ?? log.device_name ?? log.doorName ?? log.door_name ?? log.readerName ?? `Porta ${pid}`,
    };
  });

  return members.sort((a, b) => new Date(b.entryTime) - new Date(a.entryTime));
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function apiFetch(token, path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`iDSecure ${res.status} on ${path}: ${text}`);
  }
  return res.json();
}
