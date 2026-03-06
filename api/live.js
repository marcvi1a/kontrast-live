// api/live.js — Vercel Serverless Function
// Uses iDSecure REST API v1: https://main.idsecure.com.br:5000/api/v1

const BASE = "https://main.idsecure.com.br:5000/api/v1";
const EMAIL    = process.env.IDSECURE_EMAIL;
const PASSWORD = process.env.IDSECURE_PASSWORD;

function setCors(res) {
  const allowed = process.env.ALLOWED_ORIGIN || "https://kontrast.com.br";
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch { return null; }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── ?debug=1 → show full login response + JWT claims, no log fetch ──────────
  if (req.query.debug === "1") {
    try {
      const loginRaw = await loginRaw();
      return res.status(200).json({
        loginBody: loginRaw,
        jwtClaims: decodeJwt(loginRaw?.data?.token),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── ?probe=1 → try hitting the logs endpoint and return raw response ─────────
  if (req.query.probe === "1") {
    try {
      const loginData = await loginRaw();
      const token    = loginData?.data?.token;
      const tenantId = String(loginData?.data?.tenantId ?? "");

      const dtEnd   = Math.floor(Date.now() / 1000);
      const dtStart = dtEnd - (3 * 60 * 60);
      const params  = new URLSearchParams({
        pageSize: "5", pageNumber: "1",
        sortField: "Time", sortOrder: "desc",
        dtStart: String(dtStart), dtEnd: String(dtEnd),
        getPhotos: "false", ignoreCount: "true",
      });

      // Try multiple auth styles and report all results
      const attempts = [
        { label: "Bearer only",             headers: { Authorization: `Bearer ${token}` } },
        { label: "Bearer + TenantId hdr",   headers: { Authorization: `Bearer ${token}`, TenantId: tenantId } },
        { label: "Token scheme",            headers: { Authorization: `Token ${token}` } },
        { label: "Bearer + token as param", url: `/accesslog/logs?${params}&token=${token}` },
      ];

      const results = await Promise.all(attempts.map(async (a) => {
        const url = `${BASE}${a.url ?? `/accesslog/logs?${params}`}`;
        const r = await fetch(url, { headers: { "Content-Type": "application/json", ...(a.headers ?? {}) } });
        const body = await r.text();
        return { label: a.label, status: r.status, body: body.slice(0, 300) };
      }));

      return res.status(200).json({ tenantId, results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Normal path ──────────────────────────────────────────────────────────────
  try {
    const loginData = await loginRaw();
    const token    = loginData?.data?.token;
    const tenantId = String(loginData?.data?.tenantId ?? "");
    if (!token) throw new Error(`No token: ${JSON.stringify(loginData)}`);

    const members = await getMembersInHouse(token, tenantId);
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ members, updatedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch members", detail: err.message });
  }
}

// Returns the raw login body (not just token) so callers can inspect it
async function loginRaw() {
  const res = await fetch(`${BASE}/operators/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Login failed ${res.status}: ${text}`);
  }
  return res.json();
}

async function getMembersInHouse(token, tenantId) {
  const dtEnd   = Math.floor(Date.now() / 1000);
  const dtStart = dtEnd - (3 * 60 * 60);

  const params = new URLSearchParams({
    pageSize: "500", pageNumber: "1",
    sortField: "Time", sortOrder: "desc",
    dtStart: String(dtStart), dtEnd: String(dtEnd),
    getPhotos: "true", ignoreCount: "true",
  });

  const url = `${BASE}/accesslog/logs?${params}`;
  const r = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      ...(tenantId ? { "TenantId": tenantId, "X-TenantId": tenantId } : {}),
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`iDSecure ${r.status} on /accesslog/logs (tenantId=${tenantId}): ${text}`);
  }

  const body = await r.json();
  const logs = Array.isArray(body) ? body : (body?.data ?? []);
  if (logs.length === 0) return [];

  const DENIED = ["AccessDenied","InvalidCard","InvalidDevice","Blocked",
                  "InvalidSchedule","AntiPassback","ExceptionList"];
  const granted = logs.filter(l => !DENIED.includes(l.event));

  const latest = new Map();
  for (const l of granted) {
    if (l.personId && l.personId !== 0 && !latest.has(l.personId)) latest.set(l.personId, l);
  }

  return [...latest.values()]
    .map(l => ({
      id:        l.personId,
      name:      l.personName ?? "Unknown",
      photo:     l.personAvatar ? `data:image/jpeg;base64,${l.personAvatar}` : null,
      entryTime: l.time,
      door:      l.deviceName ?? l.areaName ?? "—",
    }))
    .sort((a, b) => new Date(b.entryTime) - new Date(a.entryTime));
}
