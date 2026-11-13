## **FANNYHUB**
ONE PAGE ON THE PHONE FOR EVERYTHING THE MAC IS DOING — TAILNET ONLY, NEVER THE OPEN INTERNET.

- `flow` — every Claude Code session, newest first; tap one and it streams live as Claude works.
- `builds` — every folder in `~/Developer`, with branch, uncommitted count and the files changing right now.
- `brain` — scribble box into `brain/inbox`, search, and an editor for every note; Okapi's notes and lists sit beside them.
- `okapi` — Okapi's own web UI, wired to the same `~/Okapi` files the Mac app uses.

*CAREFUL: the page shows full Claude transcripts, which can contain keys and private paths — it is only as private as the tailnet is.*

---

## **COMMANDS**
`just on` ONCE — AFTER THAT IT STARTS AT LOGIN AND THE PHONE ADDRESS NEVER CHANGES.

- `just on` — scaffold the brain, install the login agent, publish on the tailnet, print the address.
- `just off` — undo all of that.
- `just url` — print the phone address again.
- `just run` — run in a terminal instead, for working on the hub itself. `just test` — the test suite.
- `just init` — only the brain scaffold: `inbox notes projects areas resources archive`, own git repo.

*ALSO SEE: `local/logs/` for the server's output when something looks wrong.*

---

## **HOW IT IS BUILT**
ONE `server.ts` ON BUN, ONE `public/index.html`, ZERO DEPENDENCIES, NO BUILD STEP.

- Listens on `127.0.0.1:4747` only; Tailscale Serve forwards tailnet port 80 to it.
- Reads `~/.claude/projects/*/*.jsonl` for the flow and walks `~/Developer` for builds — read-only.
- Writes only `.md`/`.txt` inside `brain/`, and `notes/`, `lists/`, `history.jsonl`, `settings.json` inside `~/Okapi`.
- Every brain save is a commit in `brain/`'s own repo; `brain/` is ignored by this public one.
- Paths by env: `PORT`, `FANNYHUB_BRAIN`, `OKAPI_HOME`, `OKAPI_UI`, `FANNYHUB_DEV`, `CLAUDE_PROJECTS`.

*CAREFUL: writes need the `x-hub: 1` header and a tailnet or loopback `Host` — keep both checks if you add a route.*
