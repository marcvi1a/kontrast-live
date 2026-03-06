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
  const token = data?.data?.token;
  if (!token) throw new Error(`No token in login response: ${JSON.stringify(data)}`);
  return token;
}

// ─── Step 2: Fetch access logs from last 3 hours ──────────────────────────────
async function getMembersInHouse(token) {
  // Unix timestamps in seconds
  const dtEnd   = Math.floor(Date.now() / 1000);
  const dtStart = dtEnd - (3 * 60 * 60);

  // Granted access events in iDSecure: "Access" is the standard event string
  // We pass the events filter to only get granted entries (event type 1 = Access)
  const params = new URLSearchParams({
    pageSize:    "500",
    pageNumber:  "1",
    sortField:   "Time",
    sortOrder:   "desc",
    dtStart:     String(dtStart),
    dtEnd:       String(dtEnd),
    getPhotos:   "true",
    ignoreCount: "true",
  });

  const res = await apiFetch(token, `/accesslog/logs?${params}`);

  // Response schema: { data: [ { personId, personName, time, deviceName, event, personAvatar, ... } ] }
  const logs = Array.isArray(res) ? res : (res?.data ?? []);

  if (logs.length === 0) return [];

  // Filter: keep only granted access events, exclude denials
  const DENIED_EVENTS = ["AccessDenied", "InvalidCard", "InvalidDevice", "Blocked",
                         "InvalidSchedule", "AntiPassback", "ExceptionList"];
  const granted = logs.filter(log => !DENIED_EVENTS.includes(log.event));

  // Deduplicate: one card per person, most recent entry only
  const latestByPerson = new Map();
  for (const log of granted) {
    const pid = log.personId;
    if (pid && pid !== 0 && !latestByPerson.has(pid)) {
      latestByPerson.set(pid, log);
    }
  }

  const members = [...latestByPerson.values()].map(log => {
    // personAvatar comes as base64 string when getPhotos=true
    const photo = log.personAvatar
      ? `data:image/jpeg;base64,${log.personAvatar}`
      : null;

    return {
      id:        log.personId,
      name:      log.personName ?? "Unknown",
      photo,
      entryTime: log.time,
      door:      log.deviceName ?? log.areaName ?? "—",
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
      Authorization:  `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`iDSecure ${res.status} on ${path}: ${text}`);
  }
  return res.json();
}
