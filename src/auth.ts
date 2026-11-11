import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CONFIG_DIR, CONFIG_PATH, loadConfig, type AuthMode } from "./config.js";
import { localeFor, t } from "./i18n.js";

export const PORT = Number(process.env.TRELLO_AUTH_PORT ?? 8765);
const TIMEOUT_MS = 3 * 60_000;
const API = "https://api.trello.com/1";

export class AuthError extends Error {}
export type Log = (msg: string) => void;

let apiKey = loadConfig().apiKey;
let token = loadConfig().token;
let pending: Promise<string> | undefined;

// Progress journal, shown by trello_status and returned by trello_connect.
const journal: string[] = [];
export const recentLog = () => journal.slice(-30);
function makeLog(extra?: Log): Log {
  return (msg) => {
    const line = `[${new Date().toLocaleTimeString(localeFor())}] ${msg}`;
    journal.push(line);
    console.error(line);
    try { extra?.(msg); } catch {}
  };
}

export const credentials = () => ({ apiKey: apiKey!, token: token! });
export const isConnected = () => !!(apiKey && token);
export const hasApiKey = () => !!apiKey;
export const currentMode = (): AuthMode | undefined => loadConfig().authMode;

function save() {
  let file = {};
  try { file = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch {}
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...file, apiKey, token }, null, 2));
  chmodSync(CONFIG_PATH, 0o600);
}

export function forgetToken() {
  token = undefined;
  try { save(); } catch {}
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(cmd, [url], () => {});
}

const CHROMIUM_BROWSERS = ["Google Chrome", "Brave Browser", "Microsoft Edge", "Arc", "Chromium", "Vivaldi"];

/**
 * Close the browser tab(s) that this server opened for the callback (macOS only, via AppleScript;
 * only runs in browsers that are already running and only touches tabs on our own localhost port).
 * On other platforms the callback page tries window.close() itself.
 */
async function closeConnectionTabs(log: Log): Promise<void> {
  if (process.platform !== "darwin") {
    log(t("tabsOther"));
    return;
  }
  const prefix = `http://localhost:${PORT}/`;
  const scripts: [string, string][] = [
    ...CHROMIUM_BROWSERS.map((app): [string, string] => [app, `if application "${app}" is running then
tell application "${app}"
  repeat with w in windows
    repeat with i from (count of tabs of w) to 1 by -1
      if URL of tab i of w starts with "${prefix}" then close tab i of w
    end repeat
  end repeat
end tell
end if`]),
    ["Safari", `if application "Safari" is running then
tell application "Safari"
  repeat with w in windows
    repeat with i from (count of tabs of w) to 1 by -1
      if URL of tab i of w starts with "${prefix}" then close tab i of w
    end repeat
  end repeat
end tell
end if`],
  ];
  const closed: string[] = [];
  await Promise.all(scripts.map(([app, script]) => new Promise<void>((resolve) => {
    // Not installed / not running / automation permission denied: ignore, this is best-effort cleanup.
    execFile("osascript", ["-e", script], { timeout: 5000 }, (err) => { if (!err) closed.push(app); resolve(); });
  })));
  log(t("tabsMac", { port: PORT, closed: closed.length > 0 }));
}

function authUrl(withReturn: boolean): string {
  const u = new URL("https://trello.com/1/authorize");
  const q: Record<string, string> = {
    key: apiKey!, name: "Trello MCP", scope: "read,write", expiration: "never", response_type: "token",
  };
  if (withReturn) {
    q.callback_method = "fragment";
    q.return_url = `http://localhost:${PORT}/callback`;
  }
  u.search = new URLSearchParams(q).toString();
  return u.toString();
}

/** Check a token against Trello and return the username. */
async function verify(key: string, tok: string): Promise<string> {
  const res = await fetch(`${API}/members/me?fields=username&key=${key}&token=${encodeURIComponent(tok)}`);
  if (!res.ok) throw new AuthError(t("tokenRejected", { status: res.status, body: await res.text() }));
  return ((await res.json()) as { username: string }).username;
}

export function apiKeyInstructions(): string {
  return t("apiKeyMissing", { port: PORT, cfg: CONFIG_PATH });
}

export function manualInstructions(): string {
  if (!apiKey) return apiKeyInstructions();
  return t("manualInstructions", { url: authUrl(false), cfg: CONFIG_PATH });
}

function waitForBrowser(log: Log): Promise<string> {
  return new Promise((resolve, reject) => {
    let server: Server;
    const done = (fn: () => void) => { clearTimeout(timer); server.close(); pending = undefined; fn(); };
    const timer = setTimeout(
      () => done(() => reject(new AuthError(t("timeout")))),
      TIMEOUT_MS
    );
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      if (url.pathname === "/token") {
        const received = url.searchParams.get("t");
        res.end("ok");
        if (received) { log(t("step4")); done(() => resolve(received)); }
      } else {
        // Trello puts the token in the URL fragment (invisible to servers): forward it.
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<body style="font-family:sans-serif;text-align:center;margin-top:20vh"><h2>${t("pageConnecting")}</h2><script>
          const t=new URLSearchParams(location.hash.slice(1)).get("token");
          fetch("/token?t="+encodeURIComponent(t||"")).then(()=>{document.body.innerHTML=${JSON.stringify(`<h2>${t("pageDone")}</h2>`)};setTimeout(()=>window.close(),800);});
        </script></body>`);
      }
    });
    server.on("error", (e) => done(() => reject(new AuthError(t("portBusy", { port: PORT, msg: e.message })))));
    server.listen(PORT, "127.0.0.1", () => {
      log(t("step2", { port: PORT }));
      const url = authUrl(true);
      log(t("step3open", { url }));
      openBrowser(url);
      log(t("step3wait"));
    });
  });
}

/** Automatic flow: browser consent, token captured locally, verified, saved. */
export async function connectAuto(extra?: Log): Promise<string> {
  const log = makeLog(extra);
  log(t("autoStart"));
  if (!apiKey) throw new AuthError(apiKeyInstructions());
  log(t("step1"));
  pending ??= waitForBrowser(log);
  const tok = await pending;
  log(t("step5"));
  const user = await verify(apiKey, tok);
  token = tok;
  save();
  log(t("step6", { user, cfg: CONFIG_PATH }));
  await new Promise((r) => setTimeout(r, 1200)); // let the user see the success page
  await closeConnectionTabs(log);
  return user;
}

/** Manual flow, second stage: user pasted a token. */
export async function connectManual(tok: string, extra?: Log): Promise<string> {
  const log = makeLog(extra);
  if (!apiKey) throw new AuthError(apiKeyInstructions());
  log(t("manualVerifying"));
  const user = await verify(apiKey, tok.trim());
  token = tok.trim();
  save();
  log(t("manualDone", { user, cfg: CONFIG_PATH }));
  return user;
}

export function choiceMessage(): string {
  return t("choice", { cfg: CONFIG_PATH });
}

/** Called before every Trello API call. */
export async function ensureAuth(): Promise<void> {
  if (isConnected()) return;
  const mode = currentMode();
  if (mode === "auto") { await connectAuto(); return; }
  if (mode === "manual") throw new AuthError(manualInstructions());
  throw new AuthError(apiKey ? choiceMessage() : apiKeyInstructions());
}
