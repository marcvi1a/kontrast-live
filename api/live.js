// api/live.js — Vercel Serverless Function
// Uses iDSecure REST API v1: https://main.idsecure.com.br:5000/api/v1

const BASE = "https://main.idsecure.com.br:5000/api/v1";
const EMAIL    = process.env.IDSECURE_EMAIL;
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
    const { token, tenantId } = await login();
    const members = await getMembersInHouse(token, tenantId);
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ members, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: "Failed to fetch members", detail: err.message });
  }
}

// ─── Step 1: Login ────────────────────────────────────────────────────────────
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
  const token    = data?.data?.token;
  const tenantId = String(data?.data?.tenantId ?? "");
  if (!token) throw new Error(`No token in login response: ${JSON.stringify(data)}`);
  return { token, tenantId };
}

// ─── Step 2: Fetch access logs ────────────────────────────────────────────────
async function getMembersInHouse(token, tenantId) {
  const dtEnd   = Math.floor(Date.now() / 1000);
  const dtStart = dtEnd - (3 * 60 * 60);

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

  const res = await apiFetch(token, tenantId, `/accesslog/logs?${params}`);
  const logs = Array.isArray(res) ? res : (res?.data ?? []);

  if (logs.length === 0) return [];

  const DENIED_EVENTS = ["AccessDenied", "InvalidCard", "InvalidDevice", "Blocked",
                         "InvalidSchedule", "AntiPassback", "ExceptionList"];
  const granted = logs.filter(log => !DENIED_EVENTS.includes(log.event));

  const latestByPerson = new Map();
  for (const log of granted) {
    const pid = log.personId;
    if (pid && pid !== 0 && !latestByPerson.has(pid)) {
      latestByPerson.set(pid, log);
    }
  }

  const members = [...latestByPerson.values()].map(log => ({
    id:        log.personId,
    name:      log.personName ?? "Unknown",
    photo:     log.personAvatar ? `data:image/jpeg;base64,${log.personAvatar}` : null,
    entryTime: log.time,
    door:      log.deviceName ?? log.areaName ?? "—",
  }));

  return members.sort((a, b) => new Date(b.entryTime) - new Date(a.entryTime));
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function apiFetch(token, tenantId, path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      "Content-Type":   "application/json",
      "Authorization":  `Bearer ${token}`,
      // Try all common tenant header variants
      ...(tenantId && {
        "TenantId":        tenantId,
        "X-TenantId":      tenantId,
        "Tenant":          tenantId,
        "X-Tenant-Id":     tenantId,
      }),
    },
  });

  // If still 401, include tenantId as a debug hint in the error
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`iDSecure ${res.status} on ${path} (tenantId=${tenantId}): ${text}`);
  }
  return res.json();
}
