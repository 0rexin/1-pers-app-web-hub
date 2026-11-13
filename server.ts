// fannyhub — one Bun server, no dependencies. Binds 127.0.0.1 only; Tailscale Serve is the way in.
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";

const HOME = homedir();
const env = (k: string, d: string) => process.env[k] || d;
const HERE = import.meta.dir;
const PORT = +env("PORT", "4747");
const BRAIN = resolve(env("FANNYHUB_BRAIN", join(HERE, "brain")));
const OKAPI = resolve(env("OKAPI_HOME", join(HOME, "Okapi")));
const DEV = resolve(env("FANNYHUB_DEV", join(HOME, "Developer")));
const SESSIONS = resolve(env("CLAUDE_PROJECTS", join(HOME, ".claude/projects")));
const ROOTS: Record<string, string> = { brain: BRAIN, okapi: OKAPI };
const LIVE_MS = 90_000;

// ---------- small helpers ----------
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (status: number, error: string) => json({ error }, status);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… +${s.length - n} chars` : s);
const stat = (p: string) => { try { return statSync(p); } catch { return null; } };
const ls = (p: string) => { try { return readdirSync(p, { withFileTypes: true }); } catch { return []; } };
const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };

function readRange(file: string, from: number, to: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, to - from));
  const fd = openSync(file, "r");
  try { return buf.subarray(0, readSync(fd, buf, 0, buf.length, from)); } finally { closeSync(fd); }
}

function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const ago = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
const slug = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

// ---------- claude flow: session logs ----------
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const metaCache = new Map<string, { m: number; title: string; cwd: string }>();
const lastMatch = (s: string, re: RegExp) => {
  let hit: string | null = null;
  for (const m of s.matchAll(re)) hit = m[1];
  if (hit === null) return "";
  try { return JSON.parse(`"${hit}"`) as string; } catch { return hit; }
};

function sessionMeta(file: string, m: number, size: number) {
  const c = metaCache.get(file);
  if (c && c.m === m) return c;
  const tail = readRange(file, Math.max(0, size - 300_000), size).toString("utf8");
  const meta = {
    m,
    title: lastMatch(tail, /"type":"ai-title","aiTitle":"((?:[^"\\]|\\.)*)"/g),
    cwd: lastMatch(tail, /"cwd":"((?:[^"\\]|\\.)*)"/g),
  };
  metaCache.set(file, meta);
  return meta;
}

function sessions() {
  const all: { key: string; id: string; file: string; m: number; size: number }[] = [];
  for (const d of ls(SESSIONS)) {
    if (!d.isDirectory()) continue;
    for (const f of ls(join(SESSIONS, d.name))) {
      if (!f.name.endsWith(".jsonl")) continue;
      const file = join(SESSIONS, d.name, f.name);
      const st = stat(file);
      if (st) all.push({ key: d.name, id: f.name.slice(0, -6), file, m: st.mtimeMs, size: st.size });
    }
  }
  all.sort((a, b) => b.m - a.m);
  const now = Date.now();
  return all.slice(0, 40).map((s) => {
    const meta = sessionMeta(s.file, s.m, s.size);
    return { key: s.key, id: s.id, m: s.m, live: now - s.m < LIVE_MS, title: meta.title, cwd: meta.cwd.replace(HOME, "~") };
  });
}

const stripNoise = (s: string) =>
  s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "").trim();

function toolLine(input: any): string {
  if (!input || typeof input !== "object") return String(input ?? "");
  if (typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.prompt === "string") return input.prompt;
  return JSON.stringify(input);
}
function resultText(c: any): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b?.type === "text" ? b.text : `[${b?.type}]`)).join("\n");
  return c == null ? "" : JSON.stringify(c);
}

function toEvents(o: any) {
  if ((o?.type !== "user" && o?.type !== "assistant") || o.isMeta) return [];
  const who = o.type === "user" ? "you" : "claude";
  const base = { ts: o.timestamp, sub: !!o.isSidechain };
  const c = o.message?.content;
  const out: any[] = [];
  const say = (text: string) => { const x = stripNoise(text); if (x) out.push({ ...base, k: who, x: clip(x, 8000) }); };
  if (typeof c === "string") say(c);
  else for (const b of Array.isArray(c) ? c : []) {
    if (b.type === "text" && typeof b.text === "string") say(b.text);
    else if (b.type === "tool_use") out.push({ ...base, k: "tool", n: b.name, x: clip(toolLine(b.input), 2000) });
    else if (b.type === "tool_result") out.push({ ...base, k: "result", err: !!b.is_error, x: clip(resultText(b.content), 2000) });
  }
  return out;
}

function sessionChunk(key: string, id: string, fromParam: string | null) {
  if (!NAME.test(key) || !NAME.test(id)) return fail(400, "bad session");
  const file = join(SESSIONS, key, `${id}.jsonl`);
  const st = stat(file);
  if (!st) return fail(404, "no such session");
  let from = fromParam === null ? -1 : Number(fromParam);
  let fresh = false;
  if (!Number.isInteger(from) || from < 0 || from > st.size) { from = Math.max(0, st.size - 400_000); fresh = true; }
  const buf = readRange(file, from, Math.min(st.size, from + 2_000_000));
  let start = 0;
  if (fresh && from > 0) start = buf.indexOf(10) + 1; // drop the partial first line
  const end = buf.lastIndexOf(10) + 1; // only whole lines
  const events: any[] = [];
  if (end > start) {
    for (const line of buf.subarray(start, end).toString("utf8").split("\n")) {
      if (!line) continue;
      try { events.push(...toEvents(JSON.parse(line))); } catch {}
    }
  }
  const meta = sessionMeta(file, st.mtimeMs, st.size);
  return json({
    events, next: from + Math.max(end, start), fresh, title: meta.title, cwd: meta.cwd.replace(HOME, "~"),
    live: Date.now() - st.mtimeMs < LIVE_MS, m: st.mtimeMs, more: st.size > from + 2_000_000,
  });
}

// ---------- builds: what is changing in ~/Developer ----------
const SKIP = new Set(["node_modules", "dist", "build", "target", "brain", "local", "__pycache__", "DerivedData"]);
let buildsCache = { at: 0, data: [] as any[] };

function recentFiles(root: string) {
  const top: { p: string; m: number }[] = [];
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < 4000) {
    const dir = stack.pop()!;
    for (const e of ls(dir)) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;
      seen++;
      const st = stat(full);
      if (!st) continue;
      if (top.length < 5 || st.mtimeMs > top[top.length - 1].m) {
        top.push({ p: full.slice(root.length + 1), m: st.mtimeMs });
        top.sort((a, b) => b.m - a.m);
        top.length = Math.min(top.length, 5);
      }
    }
  }
  return top;
}

function git(dir: string, ...args: string[]) {
  try {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trimEnd() : null;
  } catch { return null; }
}

function builds() {
  if (Date.now() - buildsCache.at < 4000) return buildsCache.data;
  const data: any[] = [];
  for (const kind of ["projects", "sandbox"]) {
    for (const d of ls(join(DEV, kind))) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      const path = join(DEV, kind, d.name);
      const files = recentFiles(path);
      const last = files[0]?.m ?? stat(path)?.mtimeMs ?? 0;
      let g: any = null;
      if (existsSync(join(path, ".git"))) {
        const status = git(path, "status", "-sb", "--porcelain")?.split("\n") ?? [];
        const [subject, when] = (git(path, "log", "-1", "--format=%s%x09%ct") ?? "\t").split("\t");
        g = {
          branch: (status[0] ?? "").replace(/^## /, "").replace(/\.\.\..*$/, ""),
          dirty: Math.max(0, status.length - 1), subject, when: +when * 1000 || 0,
        };
      }
      data.push({ name: d.name, kind, last, live: Date.now() - last < LIVE_MS, files, git: g });
    }
  }
  data.sort((a, b) => b.last - a.last);
  buildsCache = { at: Date.now(), data };
  return data;
}

// ---------- brain + okapi files ----------
const TEXT = new Set([".md", ".txt"]);
const OKAPI_FILE = /^(notes|lists)\/[^/]+\.md$/;

/** Resolve a user path inside a root, or null. Lexical check here; symlink check in `inside`. */
function safe(rootName: string, p: string): string | null {
  const root = ROOTS[rootName];
  if (!root || typeof p !== "string" || !p || p.includes("\0") || p.length > 300) return null;
  const full = resolve(root, p);
  if (!full.startsWith(root + sep)) return null;
  const rel = full.slice(root.length + 1);
  if (rel.split(sep).some((part) => part.startsWith("."))) return null;
  if (!TEXT.has(extname(full))) return null;
  if (rootName === "okapi" && !OKAPI_FILE.test(rel)) return null;
  return full;
}
/** The nearest existing ancestor must really live inside the root — no symlink escapes. */
function inside(rootName: string, full: string) {
  const root = ROOTS[rootName];
  let dir = dirname(full);
  while (!existsSync(dir) && dir.length > root.length) dir = dirname(dir);
  if (!existsSync(root)) return true; // nothing under the root exists yet, so nothing to escape through
  const real = realpathSync(dir), realRoot = realpathSync(root);
  return real === realRoot || real.startsWith(realRoot + sep);
}

function listFiles() {
  const out: { root: string; p: string; m: number; s: number }[] = [];
  const walk = (rootName: string, start: string) => {
    const root = ROOTS[rootName];
    const stack = [join(root, start)];
    while (stack.length && out.length < 5000) {
      const dir = stack.pop()!;
      for (const e of ls(dir)) {
        if (e.name.startsWith(".")) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile() && TEXT.has(extname(e.name))) {
          const st = stat(full);
          if (st) out.push({ root: rootName, p: full.slice(root.length + 1), m: st.mtimeMs, s: st.size });
        }
      }
    }
  };
  walk("brain", "");
  walk("okapi", "notes");
  walk("okapi", "lists");
  return out.sort((a, b) => b.m - a.m);
}

function search(q: string) {
  const needle = q.toLowerCase();
  const hits: any[] = [];
  for (const f of listFiles()) {
    if (hits.length >= 60) break;
    const text = read(join(ROOTS[f.root], f.p));
    if (text === null) continue;
    if (f.p.toLowerCase().includes(needle)) hits.push({ root: f.root, p: f.p, n: 0, line: "" });
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < 60; i++)
      if (lines[i].toLowerCase().includes(needle)) hits.push({ root: f.root, p: f.p, n: i + 1, line: lines[i].trim().slice(0, 160) });
  }
  return hits;
}

// The brain is its own local git repo (never the public one): every save is a commit.
let commits: Promise<unknown> = Promise.resolve();
function commitBrain(what: string) {
  if (!existsSync(join(BRAIN, ".git"))) return;
  commits = commits.then(async () => {
    await Bun.spawn(["git", "-C", BRAIN, "add", "-A"], { stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "-C", BRAIN, "commit", "-qm", `hub: ${what}`], { stdout: "ignore", stderr: "ignore" }).exited;
  }).catch(() => {});
}

function saveFile(rootName: string, p: string, text: unknown) {
  const full = safe(rootName, p);
  if (!full || typeof text !== "string" || text.length > 2_000_000) return fail(400, "bad path or text");
  if (!inside(rootName, full)) return fail(400, "path escapes the root");
  writeAtomic(full, text);
  if (rootName === "brain") commitBrain(p);
  return json({ ok: true, root: rootName, p: full.slice(ROOTS[rootName].length + 1), m: Date.now() });
}

function scribble(text: unknown) {
  if (typeof text !== "string" || !text.trim()) return fail(400, "empty");
  const first = text.trim().split("\n")[0].replace(/^#+\s*/, "");
  const base = `inbox/${ago()}${slug(first) ? "-" + slug(first) : ""}`;
  let p = `${base}.md`;
  for (let i = 2; existsSync(join(BRAIN, p)); i++) p = `${base}-${i}.md`;
  return saveFile("brain", p, text.trimEnd() + "\n");
}

// ---------- okapi: the web UI's bridge, per okapi/CONTRACT.md §4–§6 ----------
const OKAPI_DEFAULTS = {
  theme: "green", font: "serif", accent: "", sound: true, holdKey: 61, holdDelayMs: 250, maxSeconds: 300, debug: false,
  transcribe: { baseURL: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", language: "" },
  ai: { baseURL: "https://openrouter.ai/api/v1", model: "" },
  codeWord: { phrase: "okapi", locale: "sv-SE", silence: 2.0, voiceDB: -45 },
};
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
function merge(a: Record<string, any>, b: Record<string, any>) {
  const out: Record<string, any> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? { ...a[k], ...v } : v;
  return out;
}
function okapiSettings() {
  let saved: unknown = null;
  try { saved = JSON.parse(read(join(OKAPI, "settings.json")) ?? "null"); } catch {}
  return merge(OKAPI_DEFAULTS, isObj(saved) ? saved : {});
}
function okapiInit() {
  const history: any[] = [];
  for (const line of (read(join(OKAPI, "history.jsonl")) ?? "").split("\n").slice(-201)) {
    if (!line) continue;
    try { history.push(JSON.parse(line)); } catch {}
  }
  const files: Record<string, string> = {};
  for (const h of history.slice(-200)) {
    if (typeof h?.file !== "string" || h.file in files) continue;
    const full = safe("okapi", h.file);
    const text = full && inside("okapi", full) ? read(full) : null;
    if (text !== null) files[h.file] = text;
  }
  return { type: "init", settings: okapiSettings(), history: history.slice(-200), files, trusted: false, aiOn: false };
}
function okapiBridge(msg: any) {
  const reply = (...messages: unknown[]) => json({ messages });
  switch (msg?.type) {
    case "ready": return reply(okapiInit());
    case "append":
      if (!isObj(msg.entry)) return fail(400, "bad entry");
      mkdirSync(OKAPI, { recursive: true });
      appendFileSync(join(OKAPI, "history.jsonl"), JSON.stringify(msg.entry) + "\n");
      return reply();
    case "write": {
      const r = saveFile("okapi", msg.path, msg.text);
      return r.status === 200 ? reply() : r;
    }
    case "settings":
      if (!isObj(msg.settings)) return fail(400, "bad settings");
      writeAtomic(join(OKAPI, "settings.json"), JSON.stringify(merge(okapiSettings(), msg.settings), null, 2) + "\n");
      return reply(okapiInit());
    case "ask": return reply({ type: "aiError", text: "Ask runs on the Mac — the hub holds no AI key." });
    default: return reply(); // resize, focus, close, quit, open, paste, copy: nothing to do server-side
  }
}

function okapiUiDir(): string | null {
  if (process.env.OKAPI_UI) return existsSync(join(process.env.OKAPI_UI, "index.html")) ? resolve(process.env.OKAPI_UI) : null;
  for (const d of ls(join(DEV, "projects"))) {
    const ui = join(DEV, "projects", d.name, "okapi", "ui");
    if (d.isDirectory() && existsSync(join(ui, "index.html"))) return ui;
  }
  return null;
}
function okapiPage(rest: string) {
  const ui = okapiUiDir();
  if (!ui) return new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<body style="margin:0;padding:24px;background:#141514;color:#9aa39c;font:15px/1.5 -apple-system,system-ui,sans-serif">
<b style="color:#e6e8e3">Okapi's web UI is not built yet.</b><br>
It appears here by itself once <code>okapi/ui/index.html</code> exists. Okapi's notes and lists already show under Brain.`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  const rel = decodeURIComponent(rest) || "index.html";
  const full = resolve(ui, rel);
  if (!full.startsWith(ui + sep) || rel.split("/").some((part) => part.startsWith("."))) return fail(400, "bad path");
  if (!stat(full)?.isFile()) return fail(404, "not found");
  if (rel !== "index.html") return new Response(Bun.file(full), { headers: { "cache-control": "no-store" } });
  // The page must find the bridge before its own scripts run.
  const shim = `<script src="/okapi-shim.js"></script>`;
  const html = readFileSync(full, "utf8");
  const at = html.search(/<script[\s>]/i);
  return new Response(at < 0 ? html + shim : html.slice(0, at) + shim + html.slice(at), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// ---------- http ----------
// Only names a rebinding attacker cannot own: loopback, tailnet IPs, bare MagicDNS names, *.ts.net.
const HOST_OK = /^(localhost|127\.0\.0\.1|100\.\d+\.\d+\.\d+|[a-z0-9-]+|[a-z0-9.-]+\.ts\.net)$/i;
const hostOf = (h: string | null) => (h ?? "").replace(/:\d+$/, "");

function guard(req: Request): Response | null {
  const host = hostOf(req.headers.get("host"));
  if (!HOST_OK.test(host)) return fail(403, "unknown host");
  if (req.method === "GET" || req.method === "HEAD") return null;
  // A custom header cannot be sent cross-site without a preflight, which is never granted.
  if (req.headers.get("x-hub") !== "1") return fail(403, "missing x-hub header");
  const origin = req.headers.get("origin");
  if (origin) { try { if (new URL(origin).hostname !== host) return fail(403, "cross-origin"); } catch { return fail(403, "bad origin"); } }
  return null;
}

const page = (name: string, type: string) =>
  new Response(Bun.file(join(HERE, "public", name)), { headers: { "content-type": type, "cache-control": "no-store" } });

async function route(req: Request): Promise<Response> {
  const blocked = guard(req);
  if (blocked) return blocked;
  const url = new URL(req.url);
  const path = url.pathname, q = url.searchParams, get = req.method === "GET";
  const body = async () => { try { return await req.json(); } catch { return null; } };

  if (get && path === "/") return page("index.html", "text/html; charset=utf-8");
  if (get && path === "/okapi-shim.js") return page("okapi-shim.js", "text/javascript; charset=utf-8");
  if (get && path === "/icon.png") return page("icon.png", "image/png");
  if (get && path === "/okapi") return Response.redirect("/okapi/", 302);
  if (get && path.startsWith("/okapi/")) return okapiPage(path.slice(7));

  if (get && path === "/api/sessions") return json(sessions());
  if (get && path === "/api/session") return sessionChunk(q.get("key") ?? "", q.get("id") ?? "", q.get("from"));
  if (get && path === "/api/builds") return json(builds());
  if (get && path === "/api/files") return json(listFiles());
  if (get && path === "/api/search") return json((q.get("q") ?? "").trim().length < 2 ? [] : search(q.get("q")!.trim()));
  if (path === "/api/file") {
    const root = q.get("root") ?? "", p = q.get("p") ?? "";
    if (get) {
      const full = safe(root, p);
      const text = full && inside(root, full) ? read(full) : null;
      return text === null ? fail(404, "no such file") : json({ root, p, text });
    }
    if (req.method === "PUT") return saveFile(root, p, (await body())?.text);
  }
  if (req.method === "POST" && path === "/api/scribble") return scribble((await body())?.text);
  if (req.method === "POST" && path === "/api/okapi") return okapiBridge(await body());
  return fail(404, "not found");
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch: (req) => route(req).catch((e) => { console.error(e); return fail(500, "server error"); }),
});
console.log(`fannyhub on http://127.0.0.1:${server.port}  brain=${BRAIN}`);
