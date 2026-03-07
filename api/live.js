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

    // Debug: inspect /persons/{id} response structure
    const debugId = new URL(req.url, "http://localhost").searchParams.get("debugPerson");
    if (debugId) {
      const r = await fetch(`${LOGIN_BASE}/persons/${debugId}`, {
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const body = await r.json();
      // Return keys and types (not full photo data) for debugging
      const summary = {};
      const data = body?.data ?? body;
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "string" && v.length > 200) {
          summary[k] = `[string, ${v.length} chars, starts: ${v.substring(0, 80)}...]`;
        } else {
          summary[k] = v;
        }
      }
      return res.status(200).json({ debugPersonId: debugId, keys: Object.keys(data), summary });
    }

    const [members, memberIds, instrutorIds] = await Promise.all([
      getRecentAccess(token),
      getPersonIdsByGroup(token, MEMBER_GROUP_ID),
      getPersonIdsByGroups(token, INSTRUTOR_GROUP_IDS),
    ]);

    // Tag each entry with isMember / isInstrutor
    for (const m of members) {
      m.isMember = memberIds.has(m.id);
      m.isInstrutor = instrutorIds.has(m.id);
    }

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ members, fetchedAt: Date.now(), updatedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch members", detail: err.message });
  }
}

const MEMBER_GROUP_ID = 1002;       // "Kontrast | Membros"
const INSTRUTOR_GROUP_IDS = [1013, 1012]; // "Kontrast | Instrutores" + "Kontrast | Instrutores – Sábado Sound Healing"

async function getPersonIdsByGroup(token, groupId) {
  const ids = new Set();
  let page = 1;
  const pageSize = 200;

  while (true) {
    const url = `${LOGIN_BASE}/accessExceptionRules/persons?groupId=${groupId}&PageSize=${pageSize}&PageNumber=${page}&Status=1&SortField=Name&SortOrder=asc`;
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

async function getPersonIdsByGroups(token, groupIds) {
  const results = await Promise.all(groupIds.map(id => getPersonIdsByGroup(token, id)));
  const merged = new Set();
  for (const s of results) {
    for (const id of s) merged.add(id);
  }
  return merged;
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

async function fetchPersonPhoto(token, personId) {
  try {
    const r = await fetch(`${LOGIN_BASE}/persons/${personId}`, {
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (!r.ok) return null;
    const body = await r.json();
    const photo = body?.data?.photo ?? body?.photo ?? null;
    if (!photo) return null;
    return photo.startsWith("data:") ? photo : `data:image/jpeg;base64,${photo}`;
  } catch {
    return null;
  }
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

  // Collect unique person IDs that are missing photos
  const uniquePersonIds = new Set();
  for (const l of fullLogs) {
    if (l.personId) uniquePersonIds.add(l.personId);
  }
  const missingPhotoIds = [...uniquePersonIds].filter(id => !photoMap.has(id));

  // Fetch missing photos from /persons/{id} endpoint (in parallel, batched)
  if (missingPhotoIds.length > 0) {
    const BATCH_SIZE = 10;
    for (let i = 0; i < missingPhotoIds.length; i += BATCH_SIZE) {
      const batch = missingPhotoIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (id) => ({ id, photo: await fetchPersonPhoto(token, id) }))
      );
      for (const { id, photo } of results) {
        if (photo) photoMap.set(id, photo);
      }
    }
  }

  // Send ALL entries — client deduplicates per filter period
  // Attach photo by personId when available
  return fullLogs
    .filter(l => l.personId)
    .map(l => ({
      id:        l.personId,
      name:      l.personName ?? "Desconhecido",
      photo:     photoMap.get(l.personId) ?? null,
      entryTime: l.time ?? null,
      deviceId:  l.deviceId ?? null,
      area:      l.deviceName ?? l.areaName ?? "—",
    }));
}
