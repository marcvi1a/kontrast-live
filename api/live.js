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

    const [members, memberIds] = await Promise.all([
      getRecentAccess(token),
      getMemberGroupIds(token),
    ]);

    // Tag each entry with isMember based on group 1002
    for (const m of members) {
      m.isMember = memberIds.has(m.id);
    }

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ members, fetchedAt: Date.now(), updatedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch members", detail: err.message });
  }
}

const MEMBER_GROUP_ID = 1002; // "Kontrast | Membros"

async function getMemberGroupIds(token) {
  const ids = new Set();
  let page = 1;
  const pageSize = 200;

  while (true) {
    const url = `${LOGIN_BASE}/accessExceptionRules/persons?groupId=${MEMBER_GROUP_ID}&PageSize=${pageSize}&PageNumber=${page}&Status=1&SortField=Name&SortOrder=asc`;
    const r = await fetch(url, {
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (!r.ok) break;
    const body = await r.json();
    const persons = body?.data?.data ?? [];
    if (persons.length === 0) break;
    for (const p of persons) {
      if (p.id) ids.add(p.id);
    }
    const totalPages = body?.data?.pages ?? 1;
    if (page >= totalPages) break;
    page++;
  }

  return ids;
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
    `${DATA_BASE}/accesslog/last?getPhotos=false&Quantity=9999`,
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

  // Send ALL entries — client deduplicates per filter period
  // Attach photo by personId when available
  return fullLogs
    .filter(l => l.personId)
    .map(l => ({
      id:        l.personId,
      name:      l.personName ?? "Desconhecido",
      photo:     photoMap.get(l.personId) ?? null,
      entryTime: l.time ?? null,
      area:      l.areaName ?? l.deviceName ?? "—",
    }));
}
