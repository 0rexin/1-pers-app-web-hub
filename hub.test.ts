// Black-box: boots the real server against throwaway folders on a spare port.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "fannyhub-"));
const dirs = { brain: join(tmp, "brain"), okapi: join(tmp, "Okapi"), dev: join(tmp, "Developer"), sessions: join(tmp, "sessions"), ui: join(tmp, "ui") };
const PORT = 47470 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${PORT}`;
const log = join(dirs.sessions, "-tmp-proj", "abc-123.jsonl");
const line = (o: unknown) => JSON.stringify(o) + "\n";
let proc: ReturnType<typeof Bun.spawn>;

const hub = (path: string, body?: unknown, method = "POST", headers: Record<string, string> = { "x-hub": "1" }) =>
  fetch(base + path, body === undefined ? { headers } : { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeAll(async () => {
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  mkdirSync(join(dirs.dev, "projects", "alpha", "src"), { recursive: true });
  mkdirSync(join(dirs.dev, "projects", "alpha", "node_modules"), { recursive: true });
  writeFileSync(join(dirs.dev, "projects", "alpha", "src", "main.ts"), "x");
  writeFileSync(join(dirs.dev, "projects", "alpha", "node_modules", "junk.js"), "x");
  writeFileSync(join(dirs.ui, "index.html"), "<!doctype html><head><title>o</title><script src=app.js></script></head>");
  writeFileSync(join(dirs.ui, "app.js"), "1");
  writeFileSync(join(tmp, "secret.md"), "outside");
  mkdirSync(join(dirs.sessions, "-tmp-proj"), { recursive: true });
  writeFileSync(log,
    line({ type: "ai-title", aiTitle: "Build the \"thing\"" }) +
    line({ type: "user", timestamp: "t1", cwd: "/tmp/proj", message: { content: "<system-reminder>hidden</system-reminder>hello hub" } }) +
    line({ type: "user", isMeta: true, message: { content: "meta noise" } }) +
    line({ type: "assistant", timestamp: "t2", message: { content: [
      { type: "thinking", thinking: "" }, { type: "text", text: "on it" },
      { type: "tool_use", name: "Bash", input: { command: "ls -la" } }] } }) +
    line({ type: "user", timestamp: "t3", message: { content: [{ type: "tool_result", is_error: true, content: [{ type: "text", text: "boom" }] }] } }));
  proc = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
    env: { ...process.env, PORT: String(PORT), FANNYHUB_BRAIN: dirs.brain, OKAPI_HOME: dirs.okapi, FANNYHUB_DEV: dirs.dev, CLAUDE_PROJECTS: dirs.sessions, OKAPI_UI: dirs.ui },
    stdout: "ignore", stderr: "inherit",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/")).ok) return; } catch {}
    await Bun.sleep(50);
  }
  throw new Error("server did not start");
});
afterAll(() => { proc?.kill(); rmSync(tmp, { recursive: true, force: true }); });

test("serves the page", async () => {
  const r = await fetch(base + "/");
  expect(r.headers.get("content-type")).toContain("text/html");
  expect(await r.text()).toContain("fannyhub");
});

test("rejects foreign hosts, headerless writes and cross-origin writes", async () => {
  expect((await fetch(base + "/api/files", { headers: { host: "evil.example.com" } })).status).toBe(403);
  expect((await fetch(base + "/api/files", { headers: { host: "macbook.tail0000.ts.net" } })).status).toBe(200);
  expect((await fetch(base + "/api/files", { headers: { host: "macbook" } })).status).toBe(200);
  expect((await hub("/api/scribble", { text: "x" }, "POST", {})).status).toBe(403);
  expect((await hub("/api/scribble", { text: "x" }, "POST", { "x-hub": "1", origin: "https://evil.example.com" })).status).toBe(403);
  expect(existsSync(join(dirs.brain, "inbox"))).toBe(false);
});

test("scribble lands in the inbox, twice without clobbering", async () => {
  const a = await (await hub("/api/scribble", { text: "# Köp mjölk!\nand bread" })).json();
  const b = await (await hub("/api/scribble", { text: "# Köp mjölk!\nagain" })).json();
  expect(a.p).toMatch(/^inbox\/\d{4}-\d\d-\d\d-\d{4}-kop-mjolk\.md$/);
  expect(b.p).not.toBe(a.p);
  expect(readFileSync(join(dirs.brain, a.p), "utf8")).toBe("# Köp mjölk!\nand bread\n");
  expect(readdirSync(join(dirs.brain, "inbox")).length).toBe(2);
  expect((await hub("/api/scribble", { text: "   " })).status).toBe(400);
});

test("files: write, read back, list, search", async () => {
  const put = await hub("/api/file?root=brain&p=" + encodeURIComponent("notes/idé.md"), { text: "# Idé\nzebra crossing\n" }, "PUT");
  expect(put.status).toBe(200);
  const got = await (await hub("/api/file?root=brain&p=" + encodeURIComponent("notes/idé.md"))).json();
  expect(got.text).toBe("# Idé\nzebra crossing\n");
  const list = await (await hub("/api/files")).json();
  expect(list.some((f: any) => f.root === "brain" && f.p === "notes/idé.md")).toBe(true);
  const hits = await (await hub("/api/search?q=ZEBRA")).json();
  expect(hits).toEqual([{ root: "brain", p: "notes/idé.md", n: 2, line: "zebra crossing" }]);
});

test("files: nothing outside the roots, no dotfiles, text only", async () => {
  symlinkSync(tmp, join(dirs.brain, "escape"));
  const bad = ["../secret.md", "/etc/hosts.md", "notes/../../secret.md", ".git/config.md", "notes/x.sh", "escape/secret.md", "notes/.hidden.md", ""];
  for (const p of bad) {
    expect([p, (await hub("/api/file?root=brain&p=" + encodeURIComponent(p), { text: "pwned" }, "PUT")).status]).toEqual([p, 400]);
    expect([p, (await hub("/api/file?root=brain&p=" + encodeURIComponent(p))).status]).toEqual([p, 404]);
  }
  expect((await hub("/api/file?root=nope&p=a.md", { text: "x" }, "PUT")).status).toBe(400);
  expect((await hub("/api/file?root=okapi&p=settings.md", { text: "x" }, "PUT")).status).toBe(400);
  expect(readFileSync(join(tmp, "secret.md"), "utf8")).toBe("outside");
});

test("okapi bridge follows the contract", async () => {
  const send = async (msg: unknown) => (await hub("/api/okapi", msg)).json();
  let init = (await send({ type: "ready" })).messages[0];
  expect(init.type).toBe("init");
  expect(init.settings.theme).toBe("green");
  expect(init.history).toEqual([]);
  expect(init.aiOn).toBe(false);

  await send({ type: "write", path: "notes/2026-11-13-0700-test.md", text: "# Test\n" });
  await send({ type: "append", entry: { t: "2026-11-13T07:00:00Z", k: "note", x: "# Test\n", file: "notes/2026-11-13-0700-test.md" } });
  await send({ type: "append", entry: { t: "2026-11-13T07:01:00Z", k: "note", x: "sneaky", file: "../secret.md" } });
  expect((await hub("/api/okapi", { type: "write", path: "../x.md", text: "no" })).status).toBe(400);
  expect((await hub("/api/okapi", { type: "write", path: "notes/a/b.md", text: "no" })).status).toBe(400);

  init = (await send({ type: "settings", settings: { theme: "blue", codeWord: { silence: 3 } } })).messages[0];
  expect(init.settings.theme).toBe("blue");
  expect(init.settings.codeWord).toEqual({ phrase: "okapi", locale: "sv-SE", silence: 3, voiceDB: -45 });
  expect(init.history.length).toBe(2);
  expect(init.files).toEqual({ "notes/2026-11-13-0700-test.md": "# Test\n" });
  expect(JSON.parse(readFileSync(join(dirs.okapi, "settings.json"), "utf8")).theme).toBe("blue");

  expect((await send({ type: "ask", messages: [] })).messages[0].type).toBe("aiError");
  expect((await send({ type: "resize", height: 400 })).messages).toEqual([]);
  const list = await (await hub("/api/files")).json();
  expect(list.some((f: any) => f.root === "okapi" && f.p === "notes/2026-11-13-0700-test.md")).toBe(true);
});

test("okapi web ui is served with the bridge injected first", async () => {
  const html = await (await fetch(base + "/okapi/")).text();
  expect(html.indexOf("/okapi-shim.js")).toBeGreaterThan(0);
  expect(html.indexOf("/okapi-shim.js")).toBeLessThan(html.indexOf("app.js"));
  expect(await (await fetch(base + "/okapi/app.js")).text()).toBe("1");
  expect((await fetch(base + "/okapi/..%2Fsecret.md")).status).toBe(400);
  expect((await fetch(base + "/okapi-shim.js")).status).toBe(200);
});

test("flow: lists sessions and streams only what is new", async () => {
  const list = await (await hub("/api/sessions")).json();
  expect(list[0]).toMatchObject({ key: "-tmp-proj", id: "abc-123", title: 'Build the "thing"', cwd: "/tmp/proj", live: true });

  const first = await (await hub("/api/session?key=-tmp-proj&id=abc-123")).json();
  expect(first.events.map((e: any) => [e.k, e.x])).toEqual([["you", "hello hub"], ["claude", "on it"], ["tool", "ls -la"], ["result", "boom"]]);
  expect(first.events[2].n).toBe("Bash");
  expect(first.events[3].err).toBe(true);

  const idle = await (await hub(`/api/session?key=-tmp-proj&id=abc-123&from=${first.next}`)).json();
  expect(idle.events).toEqual([]);
  expect(idle.next).toBe(first.next);

  // a half-written line must wait for its newline
  appendFileSync(log, line({ type: "assistant", message: { content: [{ type: "text", text: "done ✓" }] } }) + '{"type":"assistant","mess');
  const more = await (await hub(`/api/session?key=-tmp-proj&id=abc-123&from=${first.next}`)).json();
  expect(more.events.map((e: any) => e.x)).toEqual(["done ✓"]);
  appendFileSync(log, 'age":{"content":"late"}}\n');
  const late = await (await hub(`/api/session?key=-tmp-proj&id=abc-123&from=${more.next}`)).json();
  expect(late.events.map((e: any) => e.x)).toEqual(["late"]);

  expect((await hub("/api/session?key=..&id=abc-123")).status).toBe(400);
  expect((await hub("/api/session?key=a/b&id=x")).status).toBe(400);
});

test("builds: projects with their freshest files, junk folders skipped", async () => {
  const list = await (await hub("/api/builds")).json();
  expect(list.length).toBe(1);
  expect(list[0]).toMatchObject({ name: "alpha", kind: "projects", live: true, git: null });
  expect(list[0].files.map((f: any) => f.p)).toEqual(["src/main.ts"]);
});
