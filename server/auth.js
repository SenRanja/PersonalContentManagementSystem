import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import db from "./db.js";

const SESSION_COOKIE = "pcms_session";
const SESSION_DAYS = 30;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: req.secure,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(hashToken(token), userId, expiresAt);
  res.cookie(SESSION_COOKIE, token, cookieOptions(req));
}

export function destroySession(req, res) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function getUserFromToken(token) {
  if (!token) return null;
  return db.prepare(`
    SELECT users.id, users.username, users.is_admin AS isAdmin
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > datetime('now')
  `).get(hashToken(token)) || null;
}

export function getUserFromCookieHeader(cookieHeader = "") {
  const token = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return getUserFromToken(token ? decodeURIComponent(token.slice(SESSION_COOKIE.length + 1)) : null);
}

export function attachUser(req, _res, next) {
  req.user = getUserFromToken(req.cookies?.[SESSION_COOKIE]);
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  if (!req.user.isAdmin) return res.status(403).json({ error: "Administrator access required" });
  next();
}