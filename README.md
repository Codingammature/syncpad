# SyncPad

A real-time collaborative document editor: several people edit the same document at once, see each other's cursors, keep working offline, and never lose an edit. Built to be scaled horizontally: any server instance can serve any client.

**Stack:** React · TipTap/ProseMirror · Yjs (CRDT) · Node.js · WebSockets · Redis pub/sub · MongoDB · nginx · Docker Compose

## What it does

- **Real-time co-editing** with CRDT conflict resolution (Yjs). Concurrent edits always converge; there is no "last write wins".
- **Live presence:** colored cursors with name flags, and an avatar list of who is here.
- **Offline editing:** changes are kept in IndexedDB and merge when the connection returns.
- **Roles and sharing:** owner / editor / viewer, add people by email or share an invite link. Viewer writes are rejected **on the server**, not just hidden in the UI.
- **Version history:** save named versions, preview them, restore (everyone connected sees the restore live).
- **Horizontal scaling:** run N server instances behind nginx with no sticky sessions; Redis pub/sub keeps them in sync.
- **Durable storage:** append-only operation log with batched writes, compacted into snapshots with optimistic concurrency control.
- **Abuse protection:** per-socket token-bucket rate limit, max payload size, per-IP limits on login/register.

## Run it

**Fastest (no Docker, no databases).** Uses an in-memory store; data is lost on restart.

```bash
cd server && npm install && npm run dev      # API + WebSocket on :4000
cd client && npm install && npm run dev      # UI on http://localhost:5173
```

**Full stack (MongoDB + Redis + 2 server instances + nginx):**

```bash
cp .env.example .env        # set JWT_SECRET
docker compose up --build   # http://localhost:8080
```

Open the same document in two browser windows (use two accounts, share via the Share button). The status chip shows which instance each window is on (`s1` / `s2`), and edits still sync between them.

## Test it

```bash
cd server
npm test                                          # 7 integration tests (no external services)
REDIS_URL=redis://localhost:6379 npm test         # +3 cross-instance tests (needs a Redis)
```

What the tests cover: convergence of concurrent edits, viewer write rejection, auth on WebSocket upgrade, persistence + compaction across restarts, version restore, rate limiting, and (with Redis) edits/presence crossing instances, late-joining instances getting *unflushed* edits, and delete propagation.

## Load test

```bash
cd loadtest && npm install
# zero-infra: 2 server instances in one process, real Redis between them
REDIS_URL=redis://localhost:6379 node load.mjs --inproc --instances 2 --clients 100 --writers 10 --rate 5 --seconds 20
# against the running Docker stack (hits both instances directly)
node load.mjs --api http://localhost:4001 --ws ws://localhost:4001,ws://localhost:4002 --clients 100
```

It reports edit-propagation latency (p50/p95/p99) and verifies **every client converged to identical content**.

### Measured results 

Server instances, Redis, and all simulated clients ran on the same box, so these are conservative and not production numbers.

| Clients | Writers × rate | Instances | p50 | p95 | p99 | Converged |
|---|---|---|---|---|---|---|
| 60 | 6 × 5/s | 2 (+Redis) | 6 ms | 53 ms | 110 ms | yes |
| 150 | 10 × 5/s | 2 (+Redis) | 23 ms | 134 ms | 254 ms | yes |
| 40 | 4 × 5/s | 1, through nginx | 8 ms | 39 ms | 88 ms | yes |





## Layout

```
server/      Express API + WebSocket sync server
  src/collab/   docManager (load/persist/compact/fan-out), bus (Redis), wsServer (protocol + auth)
  src/store.js  MongoDB and in-memory stores behind one interface
  test/         integration tests (node:test)
client/      React SPA (TipTap editor, presence, sharing, history) + nginx gateway config
loadtest/    latency + convergence load tester
docs/DESIGN.md   architecture, trade-offs, failure modes  <- read this before interviews
```

## Known limitations 

- **Permission changes don't kick live sockets.** Removing a member takes effect on their next connection. Fix: publish a `revoke` bus message and close matching sockets.
- **JWT in the WebSocket query string** (browsers can't set headers on WebSocket). It can appear in proxy logs. Fix: short-lived single-use WS tickets from a REST endpoint.
- **Redis pub/sub is at-most-once.** Handled by the `hello` re-sync on doc load/reconnect, but a long partition could delay convergence until then. Redis Streams would give replay.
- **One hot document = one instance's memory/CPU per instance holding it.** Fine to hundreds of editors; beyond that you'd shard docs to instances by consistent hash.
- **Rich text only.** Images/embeds, comments, and suggestions are natural extensions.
