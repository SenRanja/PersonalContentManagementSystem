import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import archiver from "archiver";
import cookieParser from "cookie-parser";
import express from "express";
import multer from "multer";
import si from "systeminformation";
import { WebSocketServer, WebSocket } from "ws";
import db, { filesRoot, tempRoot } from "./db.js";
import {
  attachUser,
  createSession,
  destroySession,
  getUserFromCookieHeader,
  hashPassword,
  requireAdmin,
  requireUser,
  verifyPassword,
} from "./auth.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = express();
const server = http.createServer(app);
const notificationSockets = new WebSocketServer({ noServer: true });
const shellSockets = new WebSocketServer({ noServer: true });
const notificationLimit = 1024 * 1024;
const port = Number(process.env.PORT || 8080);

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(attachUser);

const upload = multer({
  dest: tempRoot,
  limits: { fileSize: 1024 * 1024 * 1024, files: 50 },
});

function publicUser(user) {
  return user ? { id: user.id, username: user.username, isAdmin: Boolean(user.isAdmin), isOwner: isSystemOwner(user) } : null;
}

function isSystemOwner(user) {
  return Boolean(user?.isOwner);
}

function requireOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  if (!isSystemOwner(req.user)) return res.status(403).json({ error: "Only the owner can manage administrator access" });
  next();
}

function validCredentials(username, password) {
  return typeof username === "string" && /^[\w.-]{3,32}$/.test(username) && typeof password === "string" && password.length >= 8 && password.length <= 128;
}

function resolveFilePath(relativePath = "") {
  const normalized = normalizeFilePath(relativePath);
  const resolved = path.resolve(filesRoot, normalized);
  if (resolved !== filesRoot && !resolved.startsWith(`${filesRoot}${path.sep}`)) throw new Error("Invalid path");
  return resolved;
}

function normalizeFilePath(relativePath = "") {
  const normalized = String(relativePath).replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return "";
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) throw httpError(400, "Invalid path");
  return normalized;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function areaForPath(relativePath) {
  const areaPath = normalizeFilePath(relativePath).split("/")[0];
  if (!areaPath) return null;
  return db.prepare("SELECT path, owner_user_id AS ownerUserId FROM file_areas WHERE path = ?").get(areaPath) || null;
}

function accessForPath(user, relativePath) {
  const normalized = normalizeFilePath(relativePath);
  if (!normalized) return { normalized, area: null, isOwner: isSystemOwner(user), canWrite: isSystemOwner(user) };
  const area = areaForPath(normalized);
  if (!area) return { normalized, area: null, isOwner: isSystemOwner(user), canWrite: isSystemOwner(user) };
  const ownsArea = area.ownerUserId === user.id || isSystemOwner(user);
  const granted = ownsArea || Boolean(db.prepare("SELECT 1 FROM file_grants WHERE area_path = ? AND user_id = ?").get(area.path, user.id));
  return { normalized, area, isOwner: ownsArea, canWrite: granted };
}

function requireFileAccess(user, relativePath) {
  const access = accessForPath(user, relativePath);
  const targetPath = resolveFilePath(access.normalized);
  const isPublicRootFile = !access.area && !access.normalized.includes("/") && fs.existsSync(targetPath) && fs.statSync(targetPath).isFile();
  if (!access.canWrite && !isPublicRootFile) throw httpError(403, "You do not have access to this folder");
  return access;
}

function personalPrefix(user, date = new Date()) {
  const datePart = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `${user.username}-${datePart}`;
}

function ensurePersonalArea(user, requestedName = "") {
  const prefix = personalPrefix(user);
  const areaName = requestedName ? `${prefix}-${cleanName(requestedName)}` : prefix;
  fs.mkdirSync(resolveFilePath(areaName), { recursive: true });
  db.prepare("INSERT OR IGNORE INTO file_areas (path, owner_user_id) VALUES (?, ?)").run(areaName, user.id);
  return areaName;
}

function isProtectedPath(relativePath, areaPath) {
  return db.prepare("SELECT path FROM file_protections WHERE area_path = ?").all(areaPath)
    .some((item) => relativePath === item.path || relativePath.startsWith(`${item.path}/`));
}

function assertCanDelete(user, relativePath) {
  const access = requireFileAccess(user, relativePath);
  if (!access.area) {
    if (!isSystemOwner(user)) throw httpError(403, "Public root files cannot be deleted");
    return access;
  }
  if (!access.isOwner && isProtectedPath(access.normalized, access.area.path)) {
    throw httpError(403, "This content is protected from deletion by its owner");
  }
  return access;
}

function cleanName(name) {
  const value = path.basename(String(name || "").trim());
  if (!value || value === "." || value === ".." || value.includes("\0")) throw new Error("Invalid name");
  return value;
}

function emitNotification(notification) {
  const payload = JSON.stringify({ type: "notification", data: notification });
  for (const socket of notificationSockets.clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

const saveNotification = db.transaction((content) => {
  const byteSize = Buffer.byteLength(content, "utf8");
  const result = db.prepare("INSERT INTO notifications (content, byte_size) VALUES (?, ?)").run(content, byteSize);
  while (db.prepare("SELECT COALESCE(SUM(byte_size), 0) AS total FROM notifications").get().total > notificationLimit) {
    db.prepare("DELETE FROM notifications WHERE id = (SELECT id FROM notifications ORDER BY id LIMIT 1)").run();
  }
  return db.prepare("SELECT id, content, created_at AS createdAt FROM notifications WHERE id = ?").get(result.lastInsertRowid);
});

app.get("/api/setup/status", (req, res) => {
  const initialized = db.prepare("SELECT EXISTS(SELECT 1 FROM users) AS value").get().value === 1;
  res.json({ initialized, user: publicUser(req.user) });
});

app.post("/api/setup", async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!validCredentials(username, password)) return res.status(400).json({ error: "Username must be 3-32 characters and password at least 8 characters" });
    const passwordHash = await hashPassword(password);
    const createFirstAdmin = db.transaction(() => {
      if (db.prepare("SELECT COUNT(*) AS count FROM users").get().count !== 0) throw new Error("System is already initialized");
      return db.prepare("INSERT INTO users (username, password_hash, is_admin, is_owner) VALUES (?, ?, 1, 1)").run(username, passwordHash).lastInsertRowid;
    });
    const userId = createFirstAdmin();
    createSession(req, res, userId);
    res.status(201).json({ user: { id: userId, username, isAdmin: true, isOwner: true } });
  } catch (error) {
    if (error.message === "System is already initialized") return res.status(409).json({ error: error.message });
    next(error);
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT id, username, password_hash AS passwordHash, is_admin AS isAdmin, is_owner AS isOwner FROM users WHERE username = ?").get(username);
  if (!user || !(await verifyPassword(String(password || ""), user.passwordHash))) return res.status(401).json({ error: "Invalid username or password" });
  createSession(req, res, user.id);
  res.json({ user: publicUser(user) });
});

app.post("/api/logout", requireUser, (req, res) => {
  destroySession(req, res);
  res.status(204).end();
});

app.get("/api/me", requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

app.post("/api/me/password", requireUser, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: "New password must be 8-128 characters" });
    }
    const user = db.prepare("SELECT password_hash AS passwordHash FROM users WHERE id = ?").get(req.user.id);
    if (!user || !(await verifyPassword(String(currentPassword || ""), user.passwordHash))) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(newPassword), req.user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
      .run(req.user.id, crypto.createHash("sha256").update(req.sessionToken).digest("hex"));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/users", requireUser, (_req, res) => {
  const users = db.prepare("SELECT id, username, is_admin AS isAdmin, is_owner AS isOwner, created_at AS createdAt FROM users ORDER BY id").all();
  res.json({ users: users.map(publicUser) });
});

app.post("/api/users", requireAdmin, async (req, res, next) => {
  try {
    const { username, password, isAdmin = false } = req.body;
    if (!validCredentials(username, password)) return res.status(400).json({ error: "Username must be 3-32 characters and password at least 8 characters" });
    if (isAdmin && !isSystemOwner(req.user)) return res.status(403).json({ error: "Only the owner can grant administrator access" });
    const result = db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)")
      .run(username, await hashPassword(password), isAdmin ? 1 : 0);
    res.status(201).json({ user: { id: result.lastInsertRowid, username, isAdmin: Boolean(isAdmin) } });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "Username already exists" });
    next(error);
  }
});

app.patch("/api/users/:id", requireOwner, (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare("SELECT is_owner AS isOwner FROM users WHERE id = ?").get(id);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.isOwner && req.body.isAdmin === false) return res.status(400).json({ error: "Owner administrator access cannot be revoked" });
  const result = db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(req.body.isAdmin ? 1 : 0, id);
  if (!result.changes) return res.status(404).json({ error: "User not found" });
  res.json({ ok: true });
});

app.get("/api/notifications", requireUser, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
  const notifications = db.prepare("SELECT id, content, created_at AS createdAt FROM notifications ORDER BY id DESC LIMIT ?").all(limit).reverse();
  res.json({ notifications });
});

app.post("/api/notification", express.text({ type: ["text/*", "application/octet-stream"], limit: "1mb" }), (req, res) => {
  const content = String(typeof req.body === "string" ? req.body : req.body?.message ?? req.body?.text ?? "").trim();
  if (!content) return res.status(400).json({ error: "Message cannot be empty" });
  if (Buffer.byteLength(content, "utf8") > notificationLimit) return res.status(413).json({ error: "A message cannot exceed 1 MB" });
  const notification = saveNotification(content);
  if (notification) emitNotification(notification);
  res.status(201).json({ notification });
});

app.get("/api/files", requireUser, (req, res, next) => {
  try {
    const relativePath = normalizeFilePath(req.query.path);
    if (relativePath) requireFileAccess(req.user, relativePath);
    const directory = resolveFilePath(relativePath);
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return res.status(404).json({ error: "Folder not found" });
    const entries = fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const entryRelativePath = [relativePath, entry.name].filter(Boolean).join("/");
      const access = accessForPath(req.user, entryRelativePath);
      if (!relativePath && entry.isDirectory() && !access.canWrite) return [];
      const stat = fs.statSync(path.join(directory, entry.name));
      const protectedFromDelete = Boolean(access.area && isProtectedPath(entryRelativePath, access.area.path));
      return [{
        name: entry.name,
        isDirectory: entry.isDirectory(),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        protected: protectedFromDelete,
        canDelete: access.isOwner || (access.canWrite && !protectedFromDelete),
        canRename: access.isOwner || (access.canWrite && !protectedFromDelete),
        canProtect: Boolean((access.area && access.isOwner) || (isSystemOwner(req.user) && (relativePath || entry.isDirectory()))),
        canShare: Boolean(!relativePath && entry.isDirectory() && ((access.area && access.isOwner) || isSystemOwner(req.user))),
      }];
    }).sort((left, right) => Number(right.isDirectory) - Number(left.isDirectory) || left.name.localeCompare(right.name, "zh-CN"));
    res.json({ path: relativePath, entries });
  } catch (error) {
    next(error);
  }
});

app.post("/api/files/folder", requireUser, (req, res, next) => {
  try {
    const relativePath = normalizeFilePath(req.body.path);
    if (!relativePath) {
      const areaPath = ensurePersonalArea(req.user, req.body.name);
      return res.status(201).json({ ok: true, path: areaPath });
    }
    requireFileAccess(req.user, relativePath);
    const directory = path.join(resolveFilePath(relativePath), cleanName(req.body.name));
    fs.mkdirSync(directory);
    res.status(201).json({ ok: true });
  } catch (error) {
    if (error.code === "EEXIST") return res.status(409).json({ error: "Name already exists" });
    next(error);
  }
});

app.post("/api/files/upload", requireUser, upload.array("files", 50), (req, res, next) => {
  try {
    let relativePath = normalizeFilePath(req.body.path);
    if (!relativePath && !isSystemOwner(req.user)) relativePath = ensurePersonalArea(req.user);
    else if (relativePath) requireFileAccess(req.user, relativePath);
    const directory = resolveFilePath(relativePath);
    if (!fs.statSync(directory).isDirectory()) throw new Error("Destination is not a folder");
    for (const file of req.files) fs.renameSync(file.path, path.join(directory, cleanName(file.originalname)));
    res.status(201).json({ uploaded: req.files.length, path: relativePath });
  } catch (error) {
    for (const file of req.files || []) if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    next(error);
  }
});

app.get("/api/files/download", requireUser, (req, res, next) => {
  try {
    const relativePath = normalizeFilePath(req.query.path);
    requireFileAccess(req.user, relativePath);
    const filePath = resolveFilePath(relativePath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return res.status(404).json({ error: "File not found" });
    res.download(filePath, path.basename(filePath));
  } catch (error) {
    next(error);
  }
});

app.post("/api/files/archive", requireUser, (req, res, next) => {
  try {
    const requestedPaths = Array.isArray(req.body.paths) ? req.body.paths.slice(0, 100) : [];
    if (!requestedPaths.length) return res.status(400).json({ error: "Select content to download" });
    const entries = requestedPaths.map((requestedPath) => {
      const relativePath = normalizeFilePath(requestedPath);
      requireFileAccess(req.user, relativePath);
      const entryPath = resolveFilePath(relativePath);
      if (!fs.existsSync(entryPath)) throw new Error(`Content not found: ${requestedPath}`);
      return { entryPath, name: path.basename(entryPath), stat: fs.statSync(entryPath) };
    });
    res.attachment("pcms-files.zip");
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", next);
    archive.pipe(res);
    for (const entry of entries) {
      if (entry.stat.isDirectory()) archive.directory(entry.entryPath, entry.name);
      else archive.file(entry.entryPath, { name: entry.name });
    }
    archive.finalize();
  } catch (error) {
    next(error);
  }
});

app.delete("/api/files", requireUser, (req, res, next) => {
  try {
    const relativePath = normalizeFilePath(req.body.path);
    if (!relativePath) throw httpError(400, "The storage root cannot be deleted");
    const access = assertCanDelete(req.user, relativePath);
    const targetPath = resolveFilePath(relativePath);
    if (!fs.existsSync(targetPath)) return res.status(404).json({ error: "Content not found" });
    fs.rmSync(targetPath, { recursive: true });
    if (access.area?.path === relativePath) db.prepare("DELETE FROM file_areas WHERE path = ?").run(relativePath);
    else db.prepare("DELETE FROM file_protections WHERE path = ? OR path LIKE ?").run(relativePath, `${relativePath}/%`);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.patch("/api/files", requireUser, (req, res, next) => {
  try {
    const relativePath = normalizeFilePath(req.body.path);
    if (!relativePath) throw httpError(400, "The storage root cannot be renamed");
    const access = assertCanDelete(req.user, relativePath);
    let nextName = cleanName(req.body.name);
    if (access.area?.path === relativePath && !isSystemOwner(req.user)) {
      const prefix = relativePath.match(/^.+?-\d{8}/)?.[0] || personalPrefix(req.user);
      if (!nextName.startsWith(prefix)) nextName = `${prefix}-${nextName}`;
    }
    const parent = relativePath.split("/").slice(0, -1).join("/");
    const nextRelativePath = [parent, nextName].filter(Boolean).join("/");
    const sourcePath = resolveFilePath(relativePath);
    const destinationPath = resolveFilePath(nextRelativePath);
    if (!fs.existsSync(sourcePath)) return res.status(404).json({ error: "Content not found" });
    if (fs.existsSync(destinationPath)) return res.status(409).json({ error: "Name already exists" });
    fs.renameSync(sourcePath, destinationPath);
    try {
      db.transaction(() => {
        if (access.area?.path === relativePath) {
          db.prepare("INSERT INTO file_areas (path, owner_user_id) VALUES (?, ?)").run(nextRelativePath, access.area.ownerUserId);
          db.prepare("UPDATE file_grants SET area_path = ? WHERE area_path = ?").run(nextRelativePath, relativePath);
          const protections = db.prepare("SELECT path FROM file_protections WHERE area_path = ?").all(relativePath);
          db.prepare("DELETE FROM file_protections WHERE area_path = ?").run(relativePath);
          for (const item of protections) db.prepare("INSERT INTO file_protections (path, area_path) VALUES (?, ?)")
            .run(`${nextRelativePath}${item.path.slice(relativePath.length)}`, nextRelativePath);
          db.prepare("DELETE FROM file_areas WHERE path = ?").run(relativePath);
        } else if (access.area) {
          const protections = db.prepare("SELECT path FROM file_protections WHERE area_path = ? AND (path = ? OR path LIKE ?)").all(access.area.path, relativePath, `${relativePath}/%`);
          for (const item of protections) db.prepare("UPDATE file_protections SET path = ? WHERE path = ?")
            .run(`${nextRelativePath}${item.path.slice(relativePath.length)}`, item.path);
        }
      })();
    } catch (error) {
      fs.renameSync(destinationPath, sourcePath);
      throw error;
    }
    res.json({ ok: true, path: nextRelativePath });
  } catch (error) {
    next(error);
  }
});

app.put("/api/files/protection", requireUser, (req, res, next) => {
  try {
    const relativePath = normalizeFilePath(req.body.path);
    let access = requireFileAccess(req.user, relativePath);
    if (!access.area && isSystemOwner(req.user)) {
      const areaPath = relativePath.split("/")[0];
      db.prepare("INSERT OR IGNORE INTO file_areas (path, owner_user_id) VALUES (?, ?)").run(areaPath, req.user.id);
      access = accessForPath(req.user, relativePath);
    }
    if (!access.area || !access.isOwner) throw httpError(403, "Only the folder owner can change deletion protection");
    if (req.body.protected) db.prepare("INSERT OR IGNORE INTO file_protections (path, area_path) VALUES (?, ?)").run(relativePath, access.area.path);
    else db.prepare("DELETE FROM file_protections WHERE path = ?").run(relativePath);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.put("/api/files/grants", requireUser, (req, res, next) => {
  try {
    const relativePath = normalizeFilePath(req.body.path);
    if (!relativePath || relativePath.includes("/")) throw httpError(400, "Only top-level folders can be shared");
    if (!fs.existsSync(resolveFilePath(relativePath)) || !fs.statSync(resolveFilePath(relativePath)).isDirectory()) throw httpError(404, "Folder not found");
    let area = areaForPath(relativePath);
    if (!area && isSystemOwner(req.user)) {
      db.prepare("INSERT INTO file_areas (path, owner_user_id) VALUES (?, ?)").run(relativePath, req.user.id);
      area = areaForPath(relativePath);
    }
    if (!area || (area.ownerUserId !== req.user.id && !isSystemOwner(req.user))) throw httpError(403, "Only the folder owner can manage access");
    const userIds = [...new Set((Array.isArray(req.body.userIds) ? req.body.userIds : []).map(Number))]
      .filter((userId) => Number.isInteger(userId) && userId !== area.ownerUserId);
    db.transaction(() => {
      db.prepare("DELETE FROM file_grants WHERE area_path = ?").run(area.path);
      const insert = db.prepare("INSERT INTO file_grants (area_path, user_id) SELECT ?, id FROM users WHERE id = ?");
      for (const userId of userIds) insert.run(area.path, userId);
    })();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/files/grants", requireUser, (req, res, next) => {
  try {
    const relativePath = normalizeFilePath(req.query.path);
    const area = areaForPath(relativePath);
    if (!area && isSystemOwner(req.user)) return res.json({ userIds: [] });
    if (!area || (area.ownerUserId !== req.user.id && !isSystemOwner(req.user))) throw httpError(403, "Only the folder owner can view access");
    const userIds = db.prepare("SELECT user_id AS userId FROM file_grants WHERE area_path = ?").all(area.path).map((item) => item.userId);
    res.json({ userIds });
  } catch (error) {
    next(error);
  }
});

app.get("/api/system/metrics", requireAdmin, async (_req, res, next) => {
  try {
    const [load, memory, disks, time] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize(), si.time()]);
    res.json({
      cpu: load.currentLoad,
      memory: { used: memory.active, total: memory.total },
      disks: disks.map((disk) => ({ mount: disk.mount, used: disk.used, total: disk.size, percent: disk.use })),
      uptime: time.uptime,
      healthy: true,
    });
  } catch (error) {
    next(error);
  }
});

server.on("upgrade", (req, socket, head) => {
  const user = getUserFromCookieHeader(req.headers.cookie);
  const url = new URL(req.url, "http://localhost");
  if (!user) return socket.destroy();
  if (url.pathname === "/ws/notifications") return notificationSockets.handleUpgrade(req, socket, head, (ws) => notificationSockets.emit("connection", ws, req));
  if (url.pathname === "/ws/shell" && user.isAdmin) return shellSockets.handleUpgrade(req, socket, head, (ws) => shellSockets.emit("connection", ws, req));
  socket.destroy();
});

notificationSockets.on("connection", (socket) => socket.send(JSON.stringify({ type: "connected" })));

shellSockets.on("connection", (socket) => {
  const shell = process.env.SHELL || "/bin/sh";
  const child = spawn(shell, ["-i"], { cwd: process.env.HOME || projectRoot, env: { ...process.env, TERM: "xterm-256color" } });
  const send = (data) => socket.readyState === WebSocket.OPEN && socket.send(data.toString());
  child.stdout.on("data", send);
  child.stderr.on("data", send);
  child.on("close", (code) => {
    send(`\r\n[Process exited: ${code}]\r\n`);
    socket.close();
  });
  socket.on("message", (data) => child.stdin.write(data.toString()));
  socket.on("close", () => child.kill());
});

const distRoot = path.join(projectRoot, "dist");
if (fs.existsSync(distRoot)) app.use(express.static(distRoot));
app.use((req, res, next) => {
  if (req.method === "GET" && fs.existsSync(path.join(distRoot, "index.html"))) return res.sendFile(path.join(distRoot, "index.html"));
  next();
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.status ? error.message : "Internal server error" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`PCMS running at http://0.0.0.0:${port}`);
});