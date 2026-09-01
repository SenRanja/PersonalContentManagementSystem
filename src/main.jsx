import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  Activity,
  Bell,
  Check,
  ChevronLeft,
  Copy,
  Download,
  File,
  Folder,
  FolderPlus,
  HardDrive,
  LogOut,
  MessageSquareText,
  Maximize2,
  Minimize2,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  TerminalSquare,
  Upload,
  UserPlus,
  Users,
} from "lucide-react";
import "./styles.css";

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body instanceof FormData ? options.headers : { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

function AuthScreen({ initialized, onAuthenticated }) {
  const [mode, setMode] = useState(initialized ? "login" : "setup");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const result = await api(mode === "setup" ? "/api/setup" : "/api/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      onAuthenticated(result.user);
    } catch (submitError) {
      setError(submitError.message);
      if (mode === "setup" && submitError.message.includes("initialized")) setMode("login");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-form" onSubmit={submit}>
          <h1>PCMS</h1>
          <h2>{mode === "setup" ? "Setup" : "Sign in"}</h2>
          <label>Username<input autoFocus required minLength={3} maxLength={32} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
          <label>Password<input required minLength={8} maxLength={128} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "setup" ? "new-password" : "current-password"} /></label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={submitting}>{submitting ? "Working..." : mode === "setup" ? "Create admin" : "Sign in"}</button>
      </form>
    </main>
  );
}

function NotificationsPanel() {
  const [notifications, setNotifications] = useState([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [fontSize, setFontSize] = useState(15);
  const listRef = useRef(null);
  const endpoint = `${window.location.origin}/api/notification`;

  useEffect(() => {
    api("/api/notifications").then((result) => setNotifications(result.notifications)).catch(() => {});
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws/notifications`);
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "notification") setNotifications((current) => [...current, message.data]);
    };
    return () => socket.close();
  }, []);

  useEffect(() => {
    if (autoScroll && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [notifications, autoScroll]);

  async function copyEndpoint() {
    await navigator.clipboard.writeText(endpoint);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section className="workspace-panel notification-panel">
      <header className="panel-header">
        <div><p className="section-kicker">MESSAGE STREAM</p><h2>Notifications</h2></div>
        <div className="notification-tools">
          <div className="font-controls" aria-label="Message font size"><button onClick={() => setFontSize((size) => Math.max(11, size - 1))} title="Decrease font size">A-</button><span>{fontSize}px</span><button onClick={() => setFontSize((size) => Math.min(28, size + 1))} title="Increase font size">A+</button></div>
          <label className="switch-control"><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} /><span />Auto-scroll</label>
        </div>
      </header>
      <div className="endpoint-bar">
        <MessageSquareText size={18} />
        <code>{endpoint}</code>
        <button className="icon-button" onClick={copyEndpoint} title="Copy endpoint">{copied ? <Check size={18} /> : <Copy size={18} />}</button>
      </div>
      <div className="message-stream" ref={listRef} style={{ "--message-font-size": `${fontSize}px` }}>
        {!notifications.length && <div className="empty-state"><Bell size={30} /><p>Waiting for messages</p></div>}
        {notifications.map((notification) => (
          <article className="message-row" key={notification.id}>
            <time>{new Date(`${notification.createdAt}Z`).toLocaleString("en-GB", { hour12: false })}</time>
            <p>{notification.content}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function FilePanel({ isAdmin }) {
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState([]);
  const [selected, setSelected] = useState([]);
  const [folderName, setFolderName] = useState("");
  const [showFolder, setShowFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  async function loadFiles(pathValue = currentPath) {
    const result = await api(`/api/files?path=${encodeURIComponent(pathValue)}`);
    setEntries(result.entries);
    setCurrentPath(pathValue);
    setSelected([]);
  }

  useEffect(() => { loadFiles("").catch(() => {}); }, []);

  function entryPath(name) {
    return [currentPath, name].filter(Boolean).join("/");
  }

  async function createFolder(event) {
    event.preventDefault();
    await api("/api/files/folder", { method: "POST", body: JSON.stringify({ path: currentPath, name: folderName }) });
    setFolderName("");
    setShowFolder(false);
    await loadFiles();
  }

  async function uploadFiles(event) {
    if (!event.target.files.length) return;
    setBusy(true);
    const body = new FormData();
    body.append("path", currentPath);
    for (const file of event.target.files) body.append("files", file);
    try {
      await api("/api/files/upload", { method: "POST", body });
      await loadFiles();
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }

  async function downloadSelected() {
    if (selected.length === 1) {
      window.location.assign(`/api/files/download?path=${encodeURIComponent(entryPath(selected[0]))}`);
      return;
    }
    const response = await fetch("/api/files/archive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: selected.map(entryPath) }) });
    if (!response.ok) return;
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "pcms-files.zip";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const parentPath = currentPath.split("/").slice(0, -1).join("/");
  return (
    <section className="workspace-panel">
      <header className="panel-header">
        <div><p className="section-kicker">FILE STORAGE</p><h2>Files</h2></div>
        <div className="header-actions">
          {!!selected.length && <button className="secondary-button" onClick={downloadSelected}><Download size={17} />Download {selected.length}</button>}
          {isAdmin && <button className="icon-button bordered" onClick={() => setShowFolder((value) => !value)} title="New folder"><FolderPlus size={19} /></button>}
          {isAdmin && <button className="primary-button compact" disabled={busy} onClick={() => inputRef.current.click()}><Upload size={17} />{busy ? "Uploading" : "Upload"}</button>}
          <input ref={inputRef} hidden multiple type="file" onChange={uploadFiles} />
        </div>
      </header>
      <div className="path-bar">
        <button className="icon-button" disabled={!currentPath} onClick={() => loadFiles(parentPath)} title="Parent folder"><ChevronLeft size={19} /></button>
        <Folder size={17} /><span>/ {currentPath || "Root"}</span>
        <button className="icon-button path-refresh" onClick={() => loadFiles()} title="Refresh"><RefreshCw size={17} /></button>
      </div>
      {showFolder && <form className="inline-form" onSubmit={createFolder}><input required autoFocus placeholder="Folder name" value={folderName} onChange={(event) => setFolderName(event.target.value)} /><button className="primary-button compact">Create</button></form>}
      <div className="file-table" role="table">
        <div className="file-row file-heading" role="row"><span /><span>Name</span><span>Size</span><span>Modified</span></div>
        {!entries.length && <div className="empty-state"><HardDrive size={30} /><p>This folder is empty</p></div>}
        {entries.map((entry) => (
          <div className="file-row" role="row" key={entry.name}>
            <input type="checkbox" aria-label={`Select ${entry.name}`} checked={selected.includes(entry.name)} onChange={() => setSelected((items) => items.includes(entry.name) ? items.filter((item) => item !== entry.name) : [...items, entry.name])} />
            <button className="file-name" onClick={() => entry.isDirectory ? loadFiles(entryPath(entry.name)) : window.location.assign(`/api/files/download?path=${encodeURIComponent(entryPath(entry.name))}`)}>{entry.isDirectory ? <Folder size={19} /> : <File size={19} />}<span>{entry.name}</span></button>
            <span>{entry.isDirectory ? "-" : formatBytes(entry.size)}</span>
            <time>{new Date(entry.modifiedAt).toLocaleString("en-GB", { hour12: false })}</time>
          </div>
        ))}
      </div>
    </section>
  );
}

function ResourceStatus({ label, value }) {
  const level = value >= 90 ? "critical" : value >= 70 ? "warning" : "healthy";
  return <div className="resource-status"><span className={`status-light ${level}`} /><span>{label}</span><strong>{value.toFixed(1)}%</strong></div>;
}

function ShellTerminal() {
  const terminalHost = useRef(null);
  useEffect(() => {
    const terminal = new Terminal({ cursorBlink: true, convertEol: true, fontSize: 14, fontFamily: "'DejaVu Sans Mono', monospace", theme: { background: "#171a19", foreground: "#e9ece5", cursor: "#f0795c", selectionBackground: "#547468" } });
    terminal.open(terminalHost.current);
    terminal.write("Connecting to system shell...\r\n");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws/shell`);
    socket.onopen = () => terminal.write("\x1b[32mConnected\x1b[0m\r\n");
    socket.onmessage = (event) => terminal.write(event.data);
    socket.onclose = () => terminal.write("\r\n\x1b[31mConnection closed\x1b[0m");
    const input = terminal.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(data));
    const observer = new ResizeObserver(() => {
      const width = terminalHost.current?.clientWidth || 0;
      const height = terminalHost.current?.clientHeight || 0;
      if (width && height) terminal.resize(Math.max(20, Math.floor(width / 8.5)), Math.max(5, Math.floor(height / 18)));
    });
    observer.observe(terminalHost.current);
    return () => { observer.disconnect(); input.dispose(); socket.close(); terminal.dispose(); };
  }, []);
  return <div className="terminal-host" ref={terminalHost} />;
}

function SystemPanel() {
  const [metrics, setMetrics] = useState(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    let active = true;
    async function refresh() {
      try { const result = await api("/api/system/metrics"); if (active) setMetrics(result); } catch { /* session errors are handled by the next navigation */ }
    }
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  return (
    <section className="workspace-panel system-panel">
      <header className="panel-header"><div><p className="section-kicker">SYSTEM</p><h2>System</h2></div></header>
      <div className={`shell-block ${focused ? "focused" : ""}`}>
        <div className="shell-heading"><h3><TerminalSquare size={18} />Shell</h3><button className="icon-button" onClick={() => setFocused((value) => !value)} title={focused ? "Exit focus" : "Focus view"}>{focused ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button></div>
        <ShellTerminal />
      </div>
      <div className="metrics-block">
        <div className="metrics-heading"><h3><Activity size={18} />Resources</h3>{metrics && <span className="uptime">Up {formatUptime(metrics.uptime)}</span>}</div>
        {!metrics ? <p className="muted">Loading...</p> : <div className="resource-list">
          <ResourceStatus label="CPU" value={metrics.cpu} />
          <ResourceStatus label="Memory" value={metrics.memory.used / metrics.memory.total * 100} />
          {metrics.disks.map((disk) => <ResourceStatus key={disk.mount} label={`Disk ${disk.mount}`} value={disk.percent} />)}
        </div>}
      </div>
    </section>
  );
}

function PasswordDialog({ onClose }) {
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setError("");
    if (form.newPassword !== form.confirmPassword) return setError("New passwords do not match");
    try {
      await api("/api/me/password", { method: "POST", body: JSON.stringify(form) });
      setMessage("Password updated");
      setForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
    } catch (submitError) { setError(submitError.message); }
  }
  return <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form className="password-dialog" onSubmit={submit}>
      <div className="dialog-heading"><KeyRound size={20} /><h2>Change password</h2><button type="button" className="text-button" onClick={onClose}>Close</button></div>
      <label>Current password<input autoFocus required type="password" value={form.currentPassword} onChange={(event) => setForm({ ...form, currentPassword: event.target.value })} /></label>
      <label>New password<input required minLength={8} maxLength={128} type="password" value={form.newPassword} onChange={(event) => setForm({ ...form, newPassword: event.target.value })} /></label>
      <label>Confirm password<input required minLength={8} maxLength={128} type="password" value={form.confirmPassword} onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} /></label>
      {error && <p className="form-error">{error}</p>}{message && <p className="form-success">{message}</p>}
      <button className="primary-button">Update password</button>
    </form>
  </div>;
}

function UsersPanel({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ username: "", password: "", isAdmin: false });
  const [error, setError] = useState("");
  async function loadUsers() { setUsers((await api("/api/users")).users); }
  useEffect(() => { loadUsers().catch(() => {}); }, []);
  async function createUser(event) {
    event.preventDefault();
    setError("");
    try {
      await api("/api/users", { method: "POST", body: JSON.stringify(form) });
      setForm({ username: "", password: "", isAdmin: false });
      await loadUsers();
    } catch (createError) { setError(createError.message); }
  }
  async function setAdmin(user, isAdmin) {
    await api(`/api/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ isAdmin }) });
    await loadUsers();
  }
  return (
    <section className="workspace-panel">
      <header className="panel-header"><div><p className="section-kicker">ACCESS CONTROL</p><h2>Users</h2></div></header>
      <div className="users-layout">
        <div className="user-list">
          <div className="user-row user-heading"><span>Account</span><span>Role</span><span>Admin</span></div>
          {users.map((user) => <div className="user-row" key={user.id}><strong>{user.username}{user.id === currentUser.id && <small>Current</small>}</strong><span>{user.isAdmin ? "Administrator" : "User"}</span><label className="toggle"><input type="checkbox" checked={user.isAdmin} disabled={user.id === currentUser.id} onChange={(event) => setAdmin(user, event.target.checked)} /><span /></label></div>)}
        </div>
        <form className="create-user-form" onSubmit={createUser}>
          <UserPlus size={22} /><h3>Create account</h3>
          <label>Username<input required minLength={3} maxLength={32} value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></label>
          <label>Initial password<input required minLength={8} maxLength={128} type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
          <label className="checkbox-line"><input type="checkbox" checked={form.isAdmin} onChange={(event) => setForm({ ...form, isAdmin: event.target.checked })} />Grant administrator access</label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button">Create user</button>
        </form>
      </div>
    </section>
  );
}

function Dashboard({ user, onLogout }) {
  const navigation = [
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "files", label: "Files", icon: Folder },
    ...(user.isAdmin ? [{ id: "system", label: "System", icon: Activity }, { id: "users", label: "Users", icon: Users }] : []),
  ];
  const [active, setActive] = useState("notifications");
  const [showPassword, setShowPassword] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("pcms-sidebar-collapsed") === "true");
  function toggleSidebar() {
    setSidebarCollapsed((collapsed) => {
      localStorage.setItem("pcms-sidebar-collapsed", String(!collapsed));
      return !collapsed;
    });
  }
  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-brand"><strong>PCMS</strong><button className="icon-button collapse-button" onClick={toggleSidebar} title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}>{sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button></div>
        <nav>{navigation.map((item) => <button className={active === item.id ? "active" : ""} title={item.label} key={item.id} onClick={() => setActive(item.id)}><item.icon size={19} /><span>{item.label}</span></button>)}<button className="mobile-profile" onClick={() => setShowPassword(true)}><KeyRound size={19} /><span>Password</span></button></nav>
        <div className="account"><button className="profile-button" onClick={() => setShowPassword(true)}><strong>{user.username}</strong><span>{user.isAdmin ? "Administrator" : "User"}</span></button><button className="icon-button" onClick={onLogout} title="Sign out"><LogOut size={18} /></button></div>
      </aside>
      <main className="workspace">
        {active === "notifications" && <NotificationsPanel />}
        {active === "files" && <FilePanel isAdmin={user.isAdmin} />}
        {active === "system" && user.isAdmin && <SystemPanel />}
        {active === "users" && user.isAdmin && <UsersPanel currentUser={user} />}
      </main>
      {showPassword && <PasswordDialog onClose={() => setShowPassword(false)} />}
    </div>
  );
}

function App() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    api("/api/setup/status").then((result) => {
      if (!result.initialized && location.pathname !== "/admin") history.replaceState(null, "", "/admin");
      setStatus(result);
    }).catch(() => setStatus({ initialized: true, user: null }));
  }, []);
  if (!status) return <div className="loading-screen">PCMS</div>;
  if (!status.user) return <AuthScreen initialized={status.initialized} onAuthenticated={(user) => setStatus({ initialized: true, user })} />;
  return <Dashboard user={status.user} onLogout={async () => { await api("/api/logout", { method: "POST" }); setStatus({ initialized: true, user: null }); }} />;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  return `${days}d ${hours}h`;
}

createRoot(document.getElementById("root")).render(<App />);