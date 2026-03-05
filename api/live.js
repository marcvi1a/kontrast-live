// api/live.js — Vercel Serverless Function
// Proxies Control iD / iDSecure access logs and returns members in the last 3 hours

const IDSECURE_BASE = process.env.IDSECURE_BASE_URL; // e.g. https://main.idsecure.com.br:5000
const IDSECURE_TOKEN = process.env.IDSECURE_API_TOKEN; // Bearer token from iDSecure

// ─── CORS helper ────────────────────────────────────────────────────────────
function setCors(res) {
  // Allow only your Shopify domain in production
  const allowed = process.env.ALLOWED_ORIGIN || "https://kontrast.com.br";
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ─── Main handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const members = await getMembersInHouse();
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ members, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("Error fetching members:", err);
    return res.status(500).json({ error: "Failed to fetch members", detail: err.message });
  }
}

// ─── Core logic ──────────────────────────────────────────────────────────────
async function getMembersInHouse() {
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

  // 1. Fetch access log events from the last 3 hours
  //    iDSecure uses the same REST pattern as Control iD:
  //    POST /load_objects with object name + filter conditions
  const logsResponse = await fetchIDSecure("/load_objects", {
    object: "access_logs",
    where: {
      conditions: [
        {
          // Only granted (door-opened) events
          "access_logs.event": { condition: "=", value: 7 },
        },
        {
          "access_logs.date_time": {
            condition: ">=",
            value: threeHoursAgo,
          },
        },
      ],
      operator: "and",
    },
    order: [{ "access_logs.date_time": "desc" }],
    limit: 500,
  });

  const logs = logsResponse?.access_logs ?? [];

  if (logs.length === 0) return [];

  // 2. Deduplicate: keep only the LAST entry per user (most recent door event)
  const latestByUser = new Map();
  for (const log of logs) {
    const uid = log.id_person;
    if (uid && !latestByUser.has(uid)) {
      latestByUser.set(uid, log);
    }
  }

  // 3. Fetch user details + photos for each unique member
  const userIds = [...latestByUser.keys()];
  const members = await Promise.all(
    userIds.map(async (uid) => {
      const log = latestByUser.get(uid);
      try {
        const person = await getPersonById(uid);
        const photoUrl = await getPersonPhotoUrl(uid);
        return {
          id: uid,
          name: person?.name ?? "Unknown",
          photo: photoUrl,
          entryTime: log.date_time,
          door: log.door_name ?? log.portal_name ?? `Door ${log.id_portal}`,
        };
      } catch {
        return {
          id: uid,
          name: log.person_name ?? "Unknown",
          photo: null,
          entryTime: log.date_time,
          door: log.door_name ?? `Door ${log.id_portal}`,
        };
      }
    })
  );

  // Sort by most recent entry first
  return members.sort((a, b) => new Date(b.entryTime) - new Date(a.entryTime));
}

async function getPersonById(personId) {
  const result = await fetchIDSecure("/load_objects", {
    object: "persons",
    where: {
      conditions: [{ "persons.id": { condition: "=", value: personId } }],
    },
    limit: 1,
  });
  return result?.persons?.[0] ?? null;
}

async function getPersonPhotoUrl(personId) {
  // iDSecure / Control iD exposes photos via a dedicated endpoint
  // Returns a signed URL or base64 depending on version
  try {
    const result = await fetchIDSecure(`/get_user_image?id=${personId}`, null, "GET");
    if (result?.image) {
      // Some versions return base64 directly
      return `data:image/jpeg;base64,${result.image}`;
    }
    // Others return a URL path — build absolute URL
    if (result?.url) {
      return `${IDSECURE_BASE}${result.url}`;
    }
  } catch {
    // Photo not available — will show fallback avatar
  }
  return null;
}

// ─── iDSecure HTTP helper ────────────────────────────────────────────────────
async function fetchIDSecure(path, body, method = "POST") {
  const url = `${IDSECURE_BASE}${path}`;
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${IDSECURE_TOKEN}`,
    },
  };
  if (body && method !== "GET") {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`iDSecure API error ${response.status}: ${text}`);
  }
  return response.json();
}
