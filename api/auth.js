// api/auth.js — Vercel Serverless Function (Login)
import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET;
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD;
const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const ALLOWED_ORIGINS = [
  "https://live.kontrast.com.br",
  "https://kontrast-live.vercel.app",
];

function setCors(req, res) {
  const origin = req.headers.origin ?? req.headers.referer ?? "";
  const allowed = ALLOWED_ORIGINS.find(o => origin.startsWith(o)) ?? ALLOWED_ORIGINS[0];
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
}

// ── Token helpers (also used by live.js) ──────────────────────────────────────

export function createToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  if (!token || !JWT_SECRET) return null;
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(data).digest("base64url");
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email, password } = req.body ?? {};

    if (!password) {
      return res.status(400).json({ error: "Password is required" });
    }

    if (password !== LOGIN_PASSWORD) {
      return res.status(401).json({ error: "Invalid password" });
    }

    const token = createToken({
      email: email || "anonymous",
      exp: Date.now() + TOKEN_EXPIRY_MS,
    });

    return res.status(200).json({ token });
  } catch (err) {
    return res.status(500).json({ error: "Login failed", detail: err.message });
  }
}
