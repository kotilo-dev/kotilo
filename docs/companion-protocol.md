# Kotilo companion protocol — v1

Local WebSocket protocol between **Kotilo Deck** (server) and the **Kotilo desktop app** (client).
This file is the single source of truth and is copied verbatim into the desktop repo. If code on either
side disagrees with it, the code is wrong.

## 1. Transport

- Deck listens on `ws://127.0.0.1:47831` (loopback only; never `0.0.0.0`). Path `/`.
- One desktop client at a time. A second authenticated client replaces the first (the old socket is closed
  with code `4409 replaced`).
- Text frames only, UTF-8 JSON, one message per frame, max 1 MiB per frame.
- Keep-alive: Deck sends a WebSocket ping every 15 s; a client that misses 3 pongs is dropped.
- Deck must be fully usable with no client connected; the desktop must be fully usable with no Deck.

## 2. Token & handshake

- Shared secret in `~/.kotilo/companion.token`: 64 lowercase hex chars (32 random bytes), no newline required
  (readers trim whitespace). Created by **whichever side starts first** if missing (write to a temp file in
  the same folder, then rename; never overwrite an existing valid token). The file must be readable only by
  the current user (POSIX `0600`; on Windows the default ACL of the user profile is sufficient).
- The token never crosses the socket. Both sides prove they know it with HMAC-SHA256 over fresh nonces,
  **server first**, so a process squatting the port while the Deck is down learns nothing and cannot approve
  anything (since Deck 1.0.1).
- The whole handshake must complete within 5 s of the socket opening, otherwise the server closes with `4401`.

### 2.1 Mutual handshake

1. Client → `hello` with a fresh random nonce `Nc` (32 random bytes as 64 lowercase hex chars, new for
   every connection) and **no** `token` field:

   ```json
   { "v": 1, "type": "hello", "payload": { "nonce": "<Nc>", "client": "kotilo-desktop", "clientVersion": "1.4.0" } }
   ```

2. Server → `hello.challenge` with its own fresh nonce `Ns` and its proof `Ps`:

   ```json
   { "v": 1, "type": "hello.challenge", "payload": { "nonce": "<Ns>", "proof": "<Ps>" } }
   ```

3. The client checks `Ps` in constant time. If it is missing or wrong, the client closes with `1000`, backs
   off as usual and **never** sends its own proof. Otherwise, client → `hello.auth`:

   ```json
   { "v": 1, "type": "hello.auth", "payload": { "proof": "<Pc>" } }
   ```

4. The server checks `Pc` in constant time and replies:

   ```json
   { "v": 1, "type": "hello.ok", "payload": { "server": "kotilo-deck", "serverVersion": "1.0.1", "protocol": 1, "auth": "mutual" } }
   ```

Proofs (all strings ASCII; `|` is a literal character; `hex` = lowercase hex of the 32-byte digest):

```
key = the 64-char token string, as ASCII bytes (not hex-decoded)
Ps  = hex(HMAC-SHA256(key, "kotilo-companion-v1|server|" + Nc + "|" + Ns))
Pc  = hex(HMAC-SHA256(key, "kotilo-companion-v1|client|" + Ns + "|" + Nc))
```

Nonces and proofs are exactly 64 hex chars. Receivers lowercase them before comparing; anything else is
malformed (`4400`). A wrong `Pc`, or a frame other than `hello.auth` after the challenge, is `4401`.

Test vector:

| | |
|---|---|
| token | `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` |
| Nc | `a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf` |
| Ns | `c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf` |
| Ps | `7a405ce29b239672c5c818ed4755c62166745da6b19cc1a48bd9c14d501079e2` |
| Pc | `19dadb8ff84d74d2037f8d5e7860840d4719899023fc7f1e097c76a9984676cd` |

### 2.2 Legacy one-step hello (deprecated)

Decks still accept `hello { "token": "<64 hex>", ... }` (and Deck 1.0.0 accepts only this); `hello.ok` then
carries `"auth": "token"` (1.0.0 omits `auth`). Only the client proves the token here, so the token is sent
to whatever holds the port. **Clients must not fall back to it**: a squatter could close with `4401` just to
downgrade the handshake and collect the token. A Deck older than 1.0.1 answers the nonce `hello` with `4401`;
clients treat that like a bad token (re-read the token file, normal backoff) and may suggest updating the Deck.

### 2.3 Close codes and reconnect

Close codes: `4401` bad/missing token or proof, or handshake not finished in time · `4400` malformed first
frame, nonce or proof · `4409` replaced by a newer client · `4426` unsupported `v` (the server speaks only
`v: 1`) · `1001` Deck shutting down.

Clients reconnect with exponential backoff 1 s, 2 s, 4 s, … capped at 30 s, reset after a successful `hello.ok`.
On `4401` the client re-reads the token file before retrying.

## 3. Envelope

```json
{ "v": 1, "type": "<dotted.name>", "payload": { } }
```

- `v` is the protocol version (integer). A breaking change bumps it; additive fields do not.
- Unknown `type`: log at debug level and ignore. Unknown payload fields: ignore. Missing optional fields: use
  the documented default. A message that fails validation is logged and ignored — never fatal.
- All timestamps are Unix epoch **milliseconds** (integers). Durations are seconds unless named `…Ms`.

## 4. After the handshake

1. Deck sends its current `pomodoro.state`.
2. Desktop sends `agents.state` and `usage.today` (current snapshots), then deltas as things change.

Snapshots are authoritative: `agents.state` always carries the full list, so a missed message heals on the next one.

## 5. Desktop → Deck

### `agents.state`
Full snapshot of known agents and pending approvals.

```json
{ "v": 1, "type": "agents.state", "payload": {
  "agents": [
    { "id": "a1", "repo": "kotilo-deck", "name": "claude", "status": "working", "task": "Phase 3 widgets", "since": 1793733000000 },
    { "id": "a2", "repo": "shell", "name": "claude", "status": "waiting", "task": "Run cargo build?", "since": 1793733100000 }
  ],
  "approvals": [
    { "id": "ap-17", "agentId": "a2", "summary": "Run cargo build", "detail": "cargo build --release", "requestedAt": 1793733100000 }
  ]
} }
```

- `status`: `"idle" | "working" | "waiting"` (waiting = needs the user). Unknown values are shown as `idle`.
- `task` (optional string), `since` (optional, when the status started).
- `approvals[]` lists every approval still pending; anything absent is no longer pending.
- Agent and approval `id`s are opaque strings of up to 256 chars (for example
  `claude-code:<sessionId>:<sinceMs>`); never assume a prefix or format.

### `agent.approval.requested`
A new approval, sent in addition to the next `agents.state` so the Deck can react immediately (attention
border, optional OS notification). Payload = one approval object as in `approvals[]`.

### `agent.approval.resolved`
An approval was answered (on the desktop, on the Deck, or it expired).

```json
{ "v": 1, "type": "agent.approval.resolved", "payload": { "id": "ap-17", "decision": "approve", "by": "deck" } }
```

`decision`: `"approve" | "deny" | "expired" | "unknown"`; `by`: `"deck" | "desktop" | "agent"`.
`"unknown"` means no longer pending, outcome not known (for example the user answered in the agent's own
terminal). Decks from 1.0.1 treat any unrecognised `decision` as `"unknown"`; Deck 1.0.0 ignores the message,
so always follow a resolve with a fresh `agents.state`, which removes the approval on every Deck.

### `usage.today`

```json
{ "v": 1, "type": "usage.today", "payload": { "tokens": 1840000, "costUsd": 4.12, "budgetUsd": 10 } }
```

`budgetUsd` optional (no budget → omitted or `null`).

### `pomodoro.suggest`
The desktop suggests a focus block (e.g. an agent started a long task).

```json
{ "v": 1, "type": "pomodoro.suggest", "payload": { "reason": "Agent started a long task", "minutes": 25 } }
```

`minutes` optional (Deck default focus length). The Deck shows a dismissible banner for 60 s; it never
starts a timer on its own.

### `workspace.switch`

```json
{ "v": 1, "type": "workspace.switch", "payload": { "slug": "agents" } }
```

Honoured only if the user enabled "Allow desktop to switch workspace" in Deck settings; otherwise ignored.
Unknown slug → ignored.

## 6. Deck → Desktop

### `approval.respond`

```json
{ "v": 1, "type": "approval.respond", "payload": { "id": "ap-17", "decision": "approve" } }
```

`decision`: `"approve" | "deny"`. The desktop applies it and answers with `agent.approval.resolved`
(`by: "deck"`). If the approval is no longer pending, the desktop sends `agent.approval.resolved` with the
real outcome so the Deck can correct its UI.

### `pomodoro.state`
Sent on connect and on every change (start, pause, resume, skip, phase end, settings change). Not sent per tick:
the desktop computes the countdown from `endsAt`.

```json
{ "v": 1, "type": "pomodoro.state", "payload": {
  "phase": "focus", "running": true, "endsAt": 1793734500000, "remaining": 1500,
  "duration": 1500, "session": 2, "sessionsPerCycle": 4
} }
```

- `phase`: `"idle" | "focus" | "short-break" | "long-break"`.
- `running`: false when paused or idle. `endsAt`: present only while running (else `null`).
- `remaining`: seconds left (authoritative while paused). `duration`: full length of the phase in seconds.
- `session`: 1-based index of the current/next focus session in the cycle.

A desktop may mute its notifications while `phase == "focus" && running`.

### `todo.added`
Sent when the user adds a todo on the Deck (optional for the desktop to act on, e.g. mirror it into Kotilo tasks).

```json
{ "v": 1, "type": "todo.added", "payload": { "id": 42, "text": "deploy", "due": 1793770000000 } }
```

`due` optional / `null`.

## 7. Versioning & extension

- New message types and new optional fields are additive within `v: 1`.
- Renaming/removing a field or changing its meaning requires `v: 2`; a server supporting both versions
  answers in the client's version.
- To add a type: document it here first (direction, payload, example), then add the serde type + a codec
  round-trip test on the Deck, then extend the mock-desktop integration test.

## 8. Reference client

`scripts/mock-desktop.mjs` (Node ≥ 22, no dependencies) connects, authenticates with the mutual handshake
(`--legacy-hello` for the deprecated one), sends sample agents/usage,
prints every Deck message and can request an approval from the command line. It doubles as the manual
acceptance test for Phase 3.
