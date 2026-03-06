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

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); }
  catch { return null; }
}

// ── Login — returns full response + raw Set-Cookie headers ───────────────────
async function doLogin() {
  const r = await fetch(`${BASE}/operators/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`Login failed ${r.status}: ${await r.text()}`);
  const body    = await r.json();
  const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  return { body, cookies };
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // ?debug=1 — show full login body + cookies + decoded JWT
  if (req.query.debug === "1") {
    try {
      const { body, cookies } = await doLogin();
      return res.status(200).json({
        loginBody:  body,
        cookies,
        jwtClaims:  decodeJwt(body?.data?.token),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ?probe=1 — test auth variants including cookie forwarding
  if (req.query.probe === "1") {
    try {
      const { body, cookies } = await doLogin();
      const token    = body?.data?.token;
      const tenantId = String(body?.data?.tenantId ?? "");
      const cookieHdr = cookies.join("; ");

      const now    = Math.floor(Date.now() / 1000);
      const params = new URLSearchParams({
        pageSize: "5", pageNumber: "1", sortField: "Time", sortOrder: "desc",
        dtStart: String(now - 10800), dtEnd: String(now),
        getPhotos: "false", ignoreCount: "true",
      });
      const logsUrl = `${BASE}/accesslog/logs?${params}`;

      const variants = [
        { label: "Bearer only",
          hdrs: { "Authorization": `Bearer ${token}` } },
        { label: "Bearer + Cookie from login",
          hdrs: { "Authorization": `Bearer ${token}`, "Cookie": cookieHdr } },
        { label: "Bearer + TenantId + Cookie",
          hdrs: { "Authorization": `Bearer ${token}`, "TenantId": tenantId, "Cookie": cookieHdr } },
        { label: "Cookie only (no Bearer)",
          hdrs: { "Cookie": cookieHdr } },
        // Try /accesslog/last which might have different auth requirements
        { label: "Bearer → /accesslog/last",
          url:  `${BASE}/accesslog/last`,
          hdrs: { "Authorization": `Bearer ${token}` } },
        // Try /dashboard/logs which the JWT mentions DASHBOARD permission
        { label: "Bearer → /dashboard/logs",
          url:  `${BASE}/dashboard/logs?pageSize=5&pageNumber=1&sortField=Time&sortOrder=desc`,
          hdrs: { "Authorization": `Bearer ${token}` } },
        // Try /reports/actualLocation — current status of who is inside
        { label: "Bearer → /reports/actualLocation",
          url:  `${BASE}/reports/actualLocation?pageSize=5&pageNumber=1`,
          hdrs: { "Authorization": `Bearer ${token}` } },
      ];

      const results = await Promise.all(variants.map(async (v) => {
        const url = v.url ?? logsUrl;
        const r   = await fetch(url, {
          headers: { "Content-Type": "application/json", ...v.hdrs },
        });
        const txt = await r.text();
        return { label: v.label, status: r.status, body: txt.slice(0, 500) };
      }));

      return res.status(200).json({ tenantId, cookies, results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Normal path
  try {
    const { body } = await doLogin();
    const token    = body?.data?.token;
    const tenantId = String(body?.data?.tenantId ?? "");
    if (!token) throw new Error(`No token: ${JSON.stringify(body)}`);

    const members = await getMembersInHouse(token, tenantId);
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ members, updatedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch members", detail: err.message });
  }
}

// ── Fetch access logs ─────────────────────────────────────────────────────────
async function getMembersInHouse(token, tenantId) {
  const now    = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    pageSize: "500", pageNumber: "1", sortField: "Time", sortOrder: "desc",
    dtStart: String(now - 10800), dtEnd: String(now),
    getPhotos: "true", ignoreCount: "true",
  });

  const r = await fetch(`${BASE}/accesslog/logs?${params}`, {
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${token}`,
      ...(tenantId ? { "TenantId": tenantId } : {}),
    },
  });
  if (!r.ok) {
    throw new Error(`iDSecure ${r.status} on /accesslog/logs (tenantId=${tenantId}): ${await r.text()}`);
  }

  const body = await r.json();
  const logs = Array.isArray(body) ? body : (body?.data ?? []);
  if (!logs.length) return [];

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
