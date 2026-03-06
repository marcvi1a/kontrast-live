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
  // iDSecure wraps response: { success, message, data: { token, ... } }
  const token = data?.data?.token ?? data.token ?? data.accessToken ?? data.jwt;
  if (!token) throw new Error(`No token in login response: ${JSON.stringify(data)}`);
  return token;
}

// ─── Step 2: Fetch access logs from last 3 hours ──────────────────────────────
async function getMembersInHouse(token) {
  // iDSecure expects "YYYY-MM-DD HH:MM:SS" without timezone suffix
  const fmt = (d) => d.toISOString().replace("T", " ").substring(0, 19);
  const startDate = fmt(new Date(Date.now() - 3 * 60 * 60 * 1000));
  const endDate   = fmt(new Date());

  const qs = `startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&page=1&pageSize=500`;

  // Try /accesslog/logs first, fall back to /accesslog/persons
  let logs = [];
  try {
    const res = await apiFetch(token, `/accesslog/logs?${qs}`);
    logs = Array.isArray(res) ? res : (res.logs ?? res.data ?? res.records ?? res.items ?? []);
  } catch (err) {
    console.warn("accesslog/logs failed, trying accesslog/persons:", err.message);
    const res = await apiFetch(token, `/accesslog/persons?${qs}`);
    logs = Array.isArray(res) ? res : (res.logs ?? res.data ?? res.records ?? res.items ?? []);
  }

  if (logs.length === 0) return [];

  // Filter: only granted/access-allowed events — exclude explicit denials
  const granted = logs.filter(log => {
    const evt = log.event ?? log.eventType ?? log.type ?? "";
    const denied = ["denied", "blocked", "refused", "negado", 0, "0"];
    return !denied.includes(evt) && !denied.includes(String(evt).toLowerCase());
  });

  // Deduplicate: one card per person, most recent entry only
  const latestByPerson = new Map();
  for (const log of granted) {
    const pid = log.personId ?? log.person_id ?? log.id_person ?? log.userId ?? log.user_id;
    if (pid && !latestByPerson.has(pid)) {
      latestByPerson.set(pid, log);
    }
  }

  // Build member objects
  const members = await Promise.all(
    [...latestByPerson.entries()].map(async ([pid, log]) => {
      const photo = await getPhoto(token, pid);
      return {
        id: pid,
        name: log.personName ?? log.person_name ?? log.name ?? log.userName ?? "Unknown",
        photo,
        entryTime: log.dateTime ?? log.date_time ?? log.timestamp ?? log.createdAt ?? log.date,
        door: log.doorName ?? log.door_name ?? log.readerName ?? log.reader_name ?? log.portal ?? `Porta ${pid}`,
      };
    })
  );

  return members.sort((a, b) => new Date(b.entryTime) - new Date(a.entryTime));
}

// ─── Photo fetch ──────────────────────────────────────────────────────────────
async function getPhoto(token, personId) {
  try {
    const res = await apiFetch(token, `/persons/${personId}/photo`);
    if (res?.base64 || res?.image || res?.photo) {
      const b64 = res.base64 ?? res.image ?? res.photo;
      return `data:image/jpeg;base64,${b64}`;
    }
    if (res?.url) return res.url;
  } catch {
    // No photo — fallback avatar shown in frontend
  }
  return null;
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
