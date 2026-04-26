import { connect } from "cloudflare:sockets";
import { Duplex } from "node:stream";
import type { Client, ClientChannel } from "ssh2";
import SshClient from "ssh2/lib/client.js";
import {
  DESKTOP_BACKGROUND,
  FIT_JS,
  MOBILE_BACKGROUND,
  XTERM_CSS,
  XTERM_JS,
} from "./generated/vendor-assets";

const ClientCtor = SshClient as unknown as { new (): Client };

interface Env {
  ACCESS_TOKEN?: string;
  ALLOWED_HOSTS?: string;
  DEFAULT_HOST?: string;
  DEFAULT_PORT?: string;
  DEFAULT_USERNAME?: string;
}

type ConnectMessage = {
  type: "connect";
  host: string;
  port?: number | string;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
};

type ResizeMessage = {
  type: "resize";
  cols: number;
  rows: number;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      if (!isAuthorized(url, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      void handleSshSession(server, env);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/") {
      return htmlResponse(renderIndex(request, env));
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleSshSession(ws: WebSocket, env: Env): Promise<void> {
  let ssh: Client | undefined;
  let shell: ClientChannel | undefined;
  let started = false;

  const close = (reason?: string) => {
    if (reason) sendJson(ws, { type: "status", level: "error", message: reason });
    try {
      shell?.end();
    } catch {}
    try {
      ssh?.end();
    } catch {}
    try {
      ws.close();
    } catch {}
  };

  ws.addEventListener("message", async (event) => {
    try {
      const data = event.data;

      if (!started) {
        const message = parseJson<ConnectMessage>(data);
        if (!message || message.type !== "connect") {
          close("First WebSocket message must be a connect payload.");
          return;
        }

        started = true;
        await startSsh(message, env, ws, (client, stream) => {
          ssh = client;
          shell = stream;
        });
        return;
      }

      const resize = tryParseResize(data);
      if (resize) {
        shell?.setWindow?.(resize.rows, resize.cols, 0, 0);
        return;
      }

      if (typeof data === "string") {
        shell?.write(data);
      } else {
        shell?.write(Buffer.from(data as ArrayBuffer));
      }
    } catch (error) {
      close(error instanceof Error ? error.message : "Unknown session error.");
    }
  });

  ws.addEventListener("close", () => close());
  ws.addEventListener("error", () => close("WebSocket closed with an error."));
}

async function startSsh(
  message: ConnectMessage,
  env: Env,
  ws: WebSocket,
  setSession: (client: Client, shell: ClientChannel) => void,
): Promise<void> {
  const host = normalizeHost(message.host);
  const port = normalizePort(message.port ?? 22);
  const username = String(message.username || "").trim();

  if (!host) throw new Error("Host is required.");
  if (!username) throw new Error("Username is required.");
  if (!message.password && !message.privateKey) throw new Error("Password or private key is required.");
  if (!isAllowedHost(host, env)) throw new Error("Host is not in ALLOWED_HOSTS.");

  sendJson(ws, { type: "status", level: "info", message: `Connecting to ${host}:${port}...` });

  const socket = connect({ hostname: host, port });
  sendJson(ws, { type: "status", level: "info", message: "TCP socket created, starting SSH handshake..." });
  const sock = webSocketToNodeDuplex(socket);
  const client = new ClientCtor();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settleReject = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    client
      .on("ready", () => {
        sendJson(ws, { type: "status", level: "info", message: "SSH authenticated, opening shell..." });
        client.shell({ term: "xterm-256color", cols: 100, rows: 30 }, (error, stream) => {
          if (error) {
            settleReject(error);
            return;
          }

          stream.on("data", (chunk: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
          });
          stream.stderr.on("data", (chunk: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
          });
          stream.on("close", () => {
            sendJson(ws, { type: "status", level: "info", message: "SSH shell closed." });
            ws.close();
          });

          setSession(client, stream);
          sendJson(ws, { type: "status", level: "success", message: "SSH connected." });
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      })
      .on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.map(() => message.password ?? ""));
      })
      .on("error", (error) => {
        const err = error instanceof Error ? error : new Error("SSH error.");
        sendJson(ws, { type: "status", level: "error", message: `SSH error: ${err.message}` });
        settleReject(err);
      })
      .on("close", () => {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      });

    client.connect({
      sock,
      username,
      password: message.password || undefined,
      privateKey: message.privateKey || undefined,
      passphrase: message.passphrase || undefined,
      algorithms: {
        cipher: ["aes128-ctr", "aes192-ctr", "aes256-ctr"],
        hmac: ["hmac-sha2-256-etm@openssh.com", "hmac-sha2-512-etm@openssh.com", "hmac-sha2-256", "hmac-sha2-512"],
      },
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      tryKeyboard: Boolean(message.password),
    });
  });
}

function webSocketToNodeDuplex(socket: Socket): Duplex {
  const writer = socket.writable.getWriter();
  let destroyed = false;

  const duplex = new Duplex({
    write(chunk, _encoding, callback) {
      writer.write(toUint8Array(chunk)).then(() => callback()).catch((error) => callback(error));
    },
    final(callback) {
      writer.close().then(() => callback()).catch((error) => callback(error));
    },
    destroy(error, callback) {
      destroyed = true;
      socket.close();
      callback(error);
    },
    read() {},
  });

  (duplex as Duplex & { connecting: boolean; setNoDelay: () => void; setTimeout: () => void }).connecting = false;
  (duplex as Duplex & { setNoDelay: () => void }).setNoDelay = () => {};
  (duplex as Duplex & { setTimeout: () => void }).setTimeout = () => {};

  void (async () => {
    const reader = socket.readable.getReader();
    try {
      while (!destroyed) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) duplex.push(Buffer.from(value));
      }
      duplex.push(null);
    } catch (error) {
      duplex.destroy(error instanceof Error ? error : new Error("TCP socket read failed."));
    } finally {
      reader.releaseLock();
    }
  })();

  return duplex;
}

function toUint8Array(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  return Buffer.from(chunk as ArrayBufferLike);
}

function normalizeHost(host: string): string {
  return String(host || "").trim().replace(/^\[/, "").replace(/\]$/, "");
}

function normalizePort(port: number | string): number {
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("Port must be between 1 and 65535.");
  }
  return parsed;
}

function isAllowedHost(host: string, env: Env): boolean {
  const allowlist = String(env.ALLOWED_HOSTS || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return allowlist.length === 0 || allowlist.includes(host.toLowerCase());
}

function isAuthorized(url: URL, env: Env): boolean {
  const expected = String(env.ACCESS_TOKEN || "");
  return !expected || url.searchParams.get("token") === expected;
}

function parseJson<T>(data: unknown): T | null {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

function tryParseResize(data: unknown): ResizeMessage | null {
  if (typeof data !== "string" || !data.startsWith("{")) return null;
  const parsed = parseJson<ResizeMessage>(data);
  if (!parsed || parsed.type !== "resize") return null;
  if (!Number.isFinite(parsed.cols) || !Number.isFinite(parsed.rows)) return null;
  return parsed;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function isMobileRequest(request: Request): boolean {
  const chMobile = request.headers.get("sec-ch-ua-mobile");
  if (chMobile === "?1") return true;
  if (chMobile === "?0") return false;
  const ua = request.headers.get("user-agent") || "";
  return /Android|iPhone|iPod|IEMobile|Mobile|Windows Phone/i.test(ua);
}

function renderIndex(request: Request, env: Env): string {
  const isMobile = isMobileRequest(request);
  const background = isMobile ? MOBILE_BACKGROUND : DESKTOP_BACKGROUND;
  const defaults = {
    host: env.DEFAULT_HOST || "",
    port: env.DEFAULT_PORT || "22",
    username: env.DEFAULT_USERNAME || "",
    tokenRequired: Boolean(env.ACCESS_TOKEN),
    background,
    device: isMobile ? "mobile" : "desktop",
  };

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Web SSH Plus</title>
  <style>${escapeStyle(XTERM_CSS)}</style>
  <style>
    :root {
      color-scheme: dark;
      --bg: #000;
      --panel: rgba(10, 12, 15, 0.92);
      --panel-solid: #111319;
      --line: rgba(255,255,255,0.14);
      --text: #f7f8fb;
      --muted: #9ca3af;
      --accent: #22c55e;
      --danger: #ff5c5c;
      --shadow: rgba(0,0,0,0.45);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body.has-bg::before {
      content: "";
      position: fixed;
      inset: 0;
      background-image: var(--app-bg);
      background-size: cover;
      background-position: center;
      filter: brightness(0.72);
      z-index: -2;
    }
    body.has-bg::after {
      content: "";
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.35);
      z-index: -1;
    }
    button, input, textarea {
      font: inherit;
    }
    button {
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.08);
      color: var(--text);
      border-radius: 8px;
      min-height: 42px;
      padding: 0 13px;
      cursor: pointer;
    }
    button.primary {
      border-color: rgba(34,197,94,0.75);
      background: var(--accent);
      color: #041109;
      font-weight: 750;
    }
    button.danger { border-color: rgba(255,92,92,0.55); color: #ffd7d7; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .app {
      height: 100dvh;
      display: grid;
      grid-template-rows: auto 1fr;
      min-width: 0;
      min-height: 0;
    }
    .topbar {
      height: 52px;
      padding: max(8px, env(safe-area-inset-top)) 10px 8px;
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(0,0,0,0.5);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(10px);
    }
    .menu-btn {
      width: 44px;
      min-width: 44px;
      padding: 0;
      font-size: 20px;
      line-height: 1;
    }
    .session-title {
      min-width: 0;
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 700;
    }
    .top-status {
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 36vw;
      text-align: right;
      font-size: 12px;
    }
    .stage {
      min-height: 0;
      min-width: 0;
      position: relative;
    }
    .empty, .connect-screen {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      padding: 18px;
    }
    .connect-card {
      width: min(560px, 100%);
      max-height: calc(100dvh - 84px);
      overflow: auto;
      padding: 18px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      box-shadow: 0 20px 80px var(--shadow);
    }
    .connect-card h1 {
      margin: 0 0 14px;
      font-size: 20px;
    }
    .steps {
      display: grid;
      gap: 12px;
    }
    .field {
      display: grid;
      gap: 6px;
    }
    .field span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .field input, .field textarea {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(0,0,0,0.72);
      color: var(--text);
      padding: 10px 12px;
      outline: none;
    }
    .field textarea {
      min-height: 112px;
      resize: vertical;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    .field input:focus, .field textarea:focus { border-color: rgba(34,197,94,0.85); }
    .host-row {
      display: grid;
      grid-template-columns: 1fr 96px;
      gap: 10px;
    }
    .actions {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-top: 14px;
    }
    .actions .primary { flex: 1; }
    .hint {
      color: var(--muted);
      font-size: 12px;
      min-height: 18px;
      margin-top: 10px;
    }
    .terminal-stack {
      position: absolute;
      inset: 0;
      min-width: 0;
      min-height: 0;
    }
    .terminal-pane {
      position: absolute;
      inset: 0;
      display: none;
      padding: 8px;
      min-width: 0;
      min-height: 0;
      background: rgba(0,0,0,0.74);
    }
    .terminal-pane.active { display: block; }
    .terminal {
      width: 100%;
      height: 100%;
    }
    .drawer {
      position: fixed;
      inset: 0 auto 0 0;
      width: min(360px, 88vw);
      transform: translateX(-102%);
      transition: transform 160ms ease;
      background: var(--panel-solid);
      border-right: 1px solid var(--line);
      z-index: 10;
      display: grid;
      grid-template-rows: auto 1fr auto;
      box-shadow: 16px 0 60px var(--shadow);
    }
    .drawer.open { transform: translateX(0); }
    .drawer-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: max(12px, env(safe-area-inset-top)) 12px 12px;
      border-bottom: 1px solid var(--line);
    }
    .drawer-head strong { font-size: 15px; }
    .session-list {
      overflow: auto;
      padding: 8px;
    }
    .session-item {
      width: 100%;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: center;
      margin-bottom: 8px;
      text-align: left;
      min-height: 54px;
    }
    .session-item.active { border-color: rgba(34,197,94,0.75); }
    .session-main { min-width: 0; }
    .session-name {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 700;
    }
    .session-meta {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .session-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #6b7280;
    }
    .session-dot.connected { background: var(--accent); }
    .session-dot.error { background: var(--danger); }
    .drawer-foot {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      padding: 10px 12px max(12px, env(safe-area-inset-bottom));
      border-top: 1px solid var(--line);
    }
    .overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.32);
      opacity: 0;
      pointer-events: none;
      transition: opacity 160ms ease;
      z-index: 9;
    }
    .overlay.show {
      opacity: 1;
      pointer-events: auto;
    }
    @media (max-width: 720px) {
      .topbar {
        height: 50px;
        padding-left: max(8px, env(safe-area-inset-left));
        padding-right: max(8px, env(safe-area-inset-right));
      }
      .top-status { max-width: 30vw; }
      .terminal-pane { padding: 0; }
      .connect-screen { align-items: stretch; padding: 0; }
      .connect-card {
        width: 100%;
        height: 100%;
        max-height: none;
        border: 0;
        border-radius: 0;
        padding: 18px max(14px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left));
      }
      .connect-card h1 { font-size: 18px; }
      .host-row { grid-template-columns: 1fr 86px; }
      .drawer { width: min(340px, 92vw); }
      .xterm { padding: 6px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <button id="menuBtn" class="menu-btn" type="button" aria-label="Sessions">☰</button>
      <div id="sessionTitle" class="session-title">Web SSH Plus</div>
      <div id="topStatus" class="top-status">Ready</div>
    </header>
    <main class="stage">
      <div id="terminalStack" class="terminal-stack"></div>
      <section id="connectScreen" class="connect-screen">
        <form id="connectForm" class="connect-card" autocomplete="off">
          <h1>New SSH Session</h1>
          <div class="steps">
            <div class="host-row">
              <label class="field"><span>Host</span><input id="host" required placeholder="server.example.com"></label>
              <label class="field"><span>Port</span><input id="port" inputmode="numeric" required value="22"></label>
            </div>
            <label class="field"><span>Username</span><input id="username" required autocomplete="username"></label>
            <label class="field"><span>Password</span><input id="password" type="password" autocomplete="current-password"></label>
            <label class="field"><span>Private Key</span><textarea id="privateKey" spellcheck="false" placeholder="Optional"></textarea></label>
            <label class="field"><span>Key Passphrase</span><input id="passphrase" type="password" autocomplete="new-password"></label>
            <label id="tokenLabel" class="field"><span>Access Token</span><input id="token" type="password" autocomplete="new-password"></label>
          </div>
          <div class="actions">
            <button id="connectBtn" class="primary" type="submit">Connect</button>
            <button id="clearBtn" type="button">Clear</button>
          </div>
          <div id="formHint" class="hint"></div>
        </form>
      </section>
    </main>
  </div>
  <aside id="drawer" class="drawer" aria-label="SSH sessions">
    <div class="drawer-head">
      <strong>Connections</strong>
      <button id="closeDrawer" type="button" aria-label="Close">×</button>
    </div>
    <div id="sessionList" class="session-list"></div>
    <div class="drawer-foot">
      <button id="newSessionBtn" class="primary" type="button">New</button>
      <button id="closeSessionBtn" class="danger" type="button">Close</button>
    </div>
  </aside>
  <div id="overlay" class="overlay"></div>
  <script>${escapeScript(XTERM_JS)}</script>
  <script>${escapeScript(FIT_JS)}</script>
  <script>
    const defaults = ${JSON.stringify(defaults).replace(/</g, "\\u003c")};
    if (defaults.background) {
      document.body.classList.add("has-bg");
      document.body.style.setProperty("--app-bg", "url(" + defaults.background + ")");
    }

    const els = {
      menuBtn: document.getElementById("menuBtn"),
      drawer: document.getElementById("drawer"),
      overlay: document.getElementById("overlay"),
      closeDrawer: document.getElementById("closeDrawer"),
      sessionList: document.getElementById("sessionList"),
      sessionTitle: document.getElementById("sessionTitle"),
      topStatus: document.getElementById("topStatus"),
      terminalStack: document.getElementById("terminalStack"),
      connectScreen: document.getElementById("connectScreen"),
      connectForm: document.getElementById("connectForm"),
      host: document.getElementById("host"),
      port: document.getElementById("port"),
      username: document.getElementById("username"),
      password: document.getElementById("password"),
      privateKey: document.getElementById("privateKey"),
      passphrase: document.getElementById("passphrase"),
      token: document.getElementById("token"),
      tokenLabel: document.getElementById("tokenLabel"),
      connectBtn: document.getElementById("connectBtn"),
      clearBtn: document.getElementById("clearBtn"),
      newSessionBtn: document.getElementById("newSessionBtn"),
      closeSessionBtn: document.getElementById("closeSessionBtn"),
      formHint: document.getElementById("formHint"),
    };

    els.host.value = defaults.host;
    els.port.value = defaults.port;
    els.username.value = defaults.username;
    els.token.value = new URLSearchParams(location.search).get("token") || "";
    els.tokenLabel.style.display = defaults.tokenRequired ? "grid" : "none";

    let nextId = 1;
    let activeId = null;
    const sessions = new Map();

    function setDrawer(open) {
      els.drawer.classList.toggle("open", open);
      els.overlay.classList.toggle("show", open);
    }

    function setFormMode(active) {
      els.connectScreen.style.display = active ? "grid" : "none";
      if (active) {
        activeId = null;
        els.sessionTitle.textContent = "New SSH Session";
        els.topStatus.textContent = "Ready";
      }
      renderSessions();
    }

    function statusText(session) {
      if (!session) return "Ready";
      return session.status || "Connecting";
    }

    function activateSession(id) {
      activeId = id;
      setFormMode(false);
      for (const session of sessions.values()) {
        session.pane.classList.toggle("active", session.id === id);
      }
      const session = sessions.get(id);
      if (session) {
        els.sessionTitle.textContent = session.name;
        els.topStatus.textContent = statusText(session);
        setTimeout(() => {
          session.fit.fit();
          sendResize(session);
          session.term.focus();
        }, 30);
      }
      renderSessions();
      setDrawer(false);
    }

    function renderSessions() {
      els.sessionList.textContent = "";
      if (sessions.size === 0) {
        const empty = document.createElement("div");
        empty.className = "hint";
        empty.textContent = "No active sessions";
        els.sessionList.appendChild(empty);
      }
      for (const session of sessions.values()) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "session-item" + (session.id === activeId ? " active" : "");
        item.innerHTML = '<span class="session-main"><span class="session-name"></span><span class="session-meta"></span></span><span class="session-dot"></span>';
        item.querySelector(".session-name").textContent = session.name;
        item.querySelector(".session-meta").textContent = session.status || session.host;
        const dot = item.querySelector(".session-dot");
        dot.classList.toggle("connected", session.connected);
        dot.classList.toggle("error", session.error);
        item.addEventListener("click", () => activateSession(session.id));
        els.sessionList.appendChild(item);
      }
    }

    function updateSessionStatus(session, message, level) {
      session.status = message;
      session.connected = level === "success" || session.connected;
      session.error = level === "error";
      if (activeId === session.id) els.topStatus.textContent = message;
      renderSessions();
    }

    function makeWsUrl() {
      const wsUrl = new URL("/ws", location.href);
      wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      if (els.token.value) wsUrl.searchParams.set("token", els.token.value);
      return wsUrl;
    }

    function createSession(config) {
      const id = nextId++;
      const name = config.username + "@" + config.host + ":" + config.port;
      const pane = document.createElement("section");
      pane.className = "terminal-pane";
      pane.innerHTML = '<div class="terminal"></div>';
      els.terminalStack.appendChild(pane);

      const term = new Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily: 'Consolas, "Liberation Mono", Menlo, monospace',
        fontSize: matchMedia("(max-width: 720px)").matches ? 13 : 14,
        scrollback: 8000,
        theme: { background: "#000000", foreground: "#ffffff", cursor: "#22c55e" }
      });
      const fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(pane.querySelector(".terminal"));

      const session = {
        id, name, host: config.host, status: "Connecting", connected: false, error: false,
        pane, term, fit, socket: null, input: null,
      };
      sessions.set(id, session);
      activateSession(id);
      connectSession(session, config);
    }

    function connectSession(session, config) {
      const socket = new WebSocket(makeWsUrl());
      socket.binaryType = "arraybuffer";
      session.socket = socket;

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "connect", ...config }));
        session.input = session.term.onData((data) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(data);
        });
        setTimeout(() => {
          session.fit.fit();
          sendResize(session);
        }, 40);
      });

      socket.addEventListener("message", async (event) => {
        if (typeof event.data === "string" && event.data.startsWith("{")) {
          try {
            const payload = JSON.parse(event.data);
            if (payload.type === "status") {
              updateSessionStatus(session, payload.message, payload.level);
              if (payload.level === "success") session.term.focus();
              return;
            }
          } catch {}
        }
        if (typeof event.data === "string") session.term.write(event.data);
        else session.term.write(new Uint8Array(event.data));
      });

      socket.addEventListener("close", () => {
        session.input?.dispose();
        session.connected = false;
        updateSessionStatus(session, session.error ? session.status : "Disconnected", session.error ? "error" : "info");
      });

      socket.addEventListener("error", () => {
        updateSessionStatus(session, "Connection failed", "error");
      });
    }

    function closeSession(id) {
      const session = sessions.get(id);
      if (!session) return;
      try { session.socket?.close(); } catch {}
      session.input?.dispose();
      session.term.dispose();
      session.pane.remove();
      sessions.delete(id);
      if (activeId === id) {
        const next = sessions.keys().next();
        if (next.done) setFormMode(true);
        else activateSession(next.value);
      }
      renderSessions();
    }

    function sendResize(session) {
      if (!session || session.socket?.readyState !== WebSocket.OPEN) return;
      session.socket.send(JSON.stringify({ type: "resize", cols: session.term.cols, rows: session.term.rows }));
    }

    els.connectForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const config = {
        host: els.host.value.trim(),
        port: els.port.value.trim() || "22",
        username: els.username.value.trim(),
        password: els.password.value,
        privateKey: els.privateKey.value,
        passphrase: els.passphrase.value,
      };
      if (!config.host || !config.username || (!config.password && !config.privateKey)) {
        els.formHint.textContent = "Host, username, and password or private key are required.";
        return;
      }
      els.formHint.textContent = "";
      createSession(config);
    });

    els.clearBtn.addEventListener("click", () => {
      els.host.value = defaults.host;
      els.port.value = defaults.port;
      els.username.value = defaults.username;
      els.password.value = "";
      els.privateKey.value = "";
      els.passphrase.value = "";
      els.formHint.textContent = "";
    });
    els.menuBtn.addEventListener("click", () => setDrawer(true));
    els.closeDrawer.addEventListener("click", () => setDrawer(false));
    els.overlay.addEventListener("click", () => setDrawer(false));
    els.newSessionBtn.addEventListener("click", () => { setDrawer(false); setFormMode(true); });
    els.closeSessionBtn.addEventListener("click", () => activeId ? closeSession(activeId) : setDrawer(false));
    addEventListener("resize", () => {
      const session = sessions.get(activeId);
      if (session) setTimeout(() => { session.fit.fit(); sendResize(session); }, 60);
    });

    setFormMode(true);
  </script>
</body>
</html>`;
}

function escapeStyle(value: string): string {
  return value.replace(/<\/style/gi, "<\\/style");
}

function escapeScript(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}
