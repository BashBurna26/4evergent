# 4evergent HTTP API Reference

Current API surface of `apps/api`, accurate to the source at
`apps/api/src/index.ts`. All examples use placeholders — never real
credentials.

## Authentication

All endpoints except `GET /health` require authentication.

- **Development mode** (default): `DevAuthProvider` authenticates every
  request as the development owner (`DEV_OWNER_ID`, default `operator`).
  No `Authorization` header needed.
- **Production mode**: set `API_KEYS` (format
  `key:ownerId[:subject]`, comma-separated). Requests must send
  `Authorization: Bearer <key>`. Invalid/missing credentials → `401`.
  See [security-model.md](security-model.md) — API Authentication.

Unauthenticated requests to protected endpoints return
`{"error":"unauthorized"}` with status `401`.

## Ownership

All data is owner-scoped. Requests only see records owned by the
authenticated `ownerId`. Access to another owner's resource returns
`404` (not `403`) to avoid leaking existence.

## General error behavior

Errors are ad-hoc JSON — most follow `{"error": "<message>"}` with an
appropriate 4xx/5xx status, but some endpoints return message-shaped
bodies (noted where they differ). Unknown paths return
`{"error":"not found"}` with `404`. Request bodies are limited to 1 MB.

---

## Health

### GET /health

Public (no authentication). Returns `{"status":"ok","signerAccountId":"G..."}`.

---

## Agents

### POST /agents

Create an agent. Auth: any authenticated owner.

Body: `{ "displayName": string (required, ≤100 chars, trimmed), "description"?: string (optional, ≤500 chars), "capabilities"?: string[] (optional, ≤32 entries, each ≤32 chars, trimmed, non-empty, unique), "stellarAddress"?: string }`

- `201` → `{ "agent": AgentRecord }` (bound to caller's `ownerId`)
- `400` → invalid JSON / missing `displayName` / `displayName` too long (>100 chars) / `description` not a string or too long (>500 chars) / `capabilities` not string array, too many entries (>32), entry too long (>32 chars), empty entry after trimming, or duplicate entries / `stellarAddress` not a string

### GET /agents

List caller's agents. Returns `{ "agents": AgentRecord[] }`.

### GET /agents/:id

Get one agent (owner-scoped). `404` if not found or not owned.

### PATCH /agents/:id/status

Body: `{ "status": "active" | "paused" | "disabled" }`

- `200` → `{ "id", "status" }`
- `400` → invalid status / invalid JSON
- `404` → not found or not owned

---

## Intents

### POST /agents/:id/intents

Submit a typed intent for execution. The core endpoint.

Body: an `AgentIntent` union member (`packages/shared/src/types.ts`):

- `payment`: `{ type, asset, assetDetails?, destination, amount, reason, memo? }`
- `trustline`: `{ type, assetCode, issuer, limit?, reason }`
- `contract_call`: `{ type, contractId, function, args, reason }`
- `account_settings`: `{ type, setting, value, reason }`

Headers: optional `Idempotency-Key` (≤256 chars, scoped to owner+agent).
Same key + same intent → returns the original activity (`200`).
Same key + different intent → `409`.

Agent status admission: the agent must be `active`. A `paused` or
`disabled` agent rejects new intents before any activity, approval,
execution, or queue record is created:

- `409` → `{ "error": "agent is paused; new intents are rejected" }`
- `409` → `{ "error": "agent is disabled; new intents are rejected" }`

Existing approvals and in-flight executions are unaffected by a status
change — the gate applies to new intents only.

Behavior (policy decision):

- Policy `deny` → `403` with intent response recording the denial
- Policy `requires_approval` → `202` with `approvalId` in the response
- Policy `allow` → executes: `200` (submitted, includes `txHash`),
  `422` (simulation failed), `502` (source account load failed),
  `403` (rejected)

Response (success/denied): `{ "activityId", "agentId", "status",
"policyDecision", "authorizationStatus", "simulationResult",
"txHash", "error" }`

Raw XDR / transaction blobs in the body are rejected with `400`
(typed intents only — no raw transaction acceptance by design).

---

## Approvals

### POST /approvals/:id/approve

Approve a pending approval. Owner-scoped (`canApprove`). The approver
identity is taken from the authenticated principal's `subject`.

- `200` → `{ approvalId, activityId, agentId:"", status:"approved",
  message }` — execution is enqueued (persistent queue) or deferred
- `409` → invalid state transition (e.g. already approved)
- `410` → approval expired
- `404` → not found or not owned (response body is approval-response
  shaped with status `rejected`, not `{"error"}`)

Raw XDR in body → `400` with `{"message": ...}` (message-shaped).

### POST /approvals/:id/reject

Reject a pending approval. Owner-scoped (`canReject`).

- `200` → approval-response shaped, status `rejected`
- `409` → invalid state transition
- `404` → not found or not owned (approval-response shaped)

Raw XDR in body → `400` with `{"message": ...}`.

### GET /approvals

List caller's approvals (most recent 50). Query: `?status=<status>`
optional filter. Returns `{ "approvals": ApprovalRecord[] }`.

### GET /agents/:id/approvals

List approvals for one agent (owner-scoped). Query: `?status=` filter.
Returns `{ "agentId", "approvals": ApprovalRecord[] }`.

---

## Activity

### GET /agents/:id/activity

List activity records for an agent (owner-scoped).
Query: `?limit=` (default 50, clamped 1–100).
Returns `{ "agentId", "activity": ActivityRecord[] }`.

### GET /agents/:id/activity/:activityId

Single activity record (owner-scoped). `404` if not found/not owned.
Returns `{ "activity": ActivityRecord }`.

---

## Policy

### GET /agents/:id/policy

Get the agent's effective policy rules (owner-scoped). Returns
`{ "agentId", "policy": PolicyRules, "version": number, "updatedAt" }`.
Agents without a custom policy return `DEFAULT_RULES` with `version: 0`.

### PUT /agents/:id/policy

Set the agent's policy (owner-scoped). Body: a `PolicyRules` object.
Validated by `validatePolicyRules`; normalized before storage.

- `200` → `{ "agentId", "policy", "version" }`
- `400` → `{"error":"invalid policy","details":[...]}` / invalid JSON /
  body not an object

---

## Schedules

### POST /agents/:id/schedules

Create a schedule (owner-scoped). Body:

`{ "intent": AgentIntent, "scheduleExpression": "<cron-like>",
"timezone"?: string (default "UTC") }`

Intent and expression are validated (`validateScheduleIntent`,
`validateScheduleExpression`); invalid input → `400` with the
validator's error message. `201` → `{ "schedule": ScheduleRecord }`.

### GET /agents/:id/schedules

List schedules for an agent (owner-scoped). Query: `?limit=`
(default 50, clamped 1–100). Returns `{ "agentId", "schedules": [] }`.

### GET /agents/:id/schedules/:scheduleId

Single schedule (owner-scoped). Returns `{ "schedule": ScheduleRecord }`.

### PATCH /agents/:id/schedules/:scheduleId

Update a schedule's `scheduleExpression` (re-validated against the
schedule's timezone). `200` → `{ "schedule" }`.

### DELETE /agents/:id/schedules/:scheduleId

Delete a schedule. `200` → `{ "deleted": true }`.

### POST /agents/:id/schedules/:scheduleId/pause | /resume | /disable

Transition schedule status (`paused` / `active` / `disabled`).
`200` → `{ "schedule" }`.

### Missed schedule runs

An occurrence due now or no more than five minutes ago follows the normal
execution path and still passes policy and approval checks. An occurrence more
than five minutes late is logged and skipped; the scheduler advances the
schedule to its next cron occurrence rather than replaying every missed
interval. Configure the grace period with `SCHEDULER_MAX_LATENESS_MS` (default
`300000` milliseconds). This single-run grace window avoids unbounded payment
bursts after downtime while preserving near-on-time schedules.

---

## Executions

Execution records are created when an approved intent is enqueued for
on-chain execution (retry, dead-letter, reconciliation).

### GET /agents/:id/executions

List executions for an agent (owner-scoped). Query: `?limit=`
(default 50, clamped 1–100). Returns `{ "agentId", "executions": [] }`.

### GET /executions/:id

Single execution (owner-scoped via `getForOwner`). Returns
`{ "execution": ExecutionRecord }`.

### POST /executions/:id/retry

Retry a `failed` or `dead_letter` execution. Requires the execution
queue to be enabled.

- `200` → `{ "execution", "message": "execution queued for retry" }`
- `409` → wrong status / max retries reached / state conflict
- `404` → not found / queue not enabled

### POST /executions/:id/cancel

Cancel a `queued` or `executing` execution. Requires the queue.

- `200` → `{ "execution", "message": "execution cancelled" }`
- `409` → wrong status / conflict
- `404` → not found / queue not enabled

### GET /agent-queue

Queue summary for the caller's executions. Returns
`{ "running": boolean, "byStatus": Record<string, number> }`.
`404` with `{"error":"execution queue not enabled"}` if the queue is off.

---

## Notes

- Response shapes above are the primary success shapes; record fields
  (`AgentRecord`, `ActivityRecord`, `ApprovalRecord`, `ScheduleRecord`,
  `ExecutionRecord`, `PolicyRules`) are defined in
  `packages/shared/src/types.ts` and `packages/database/src/*-types.ts`.
- This API is served by `apps/api` (`pnpm --filter @4evergent/api start`,
  default port 3000). Configuration via environment — see
  [testnet.md](testnet.md) and `.env.example`.

---

## Hosted runtime (production deployment)

The API is a **long-running, stateful Node.js service**. It is not a serverless
function and does not support scale-to-zero. Any hosting choice must satisfy
the requirements below; this document does not endorse a specific provider.

### Runtime requirements

- **Node.js 22 or newer.** `apps/api` and the `@4evergent/database` stores use
  the built-in `node:sqlite` module (Node 22+). The repository pins
  `pnpm@10.34.5` (root `packageManager`) and Node 22 (`.nvmrc`).
- **One instance only.** Sequence-sensitive Stellar submission is serialized by
  an in-process coordinator (`AccountSequenceCoordinator`), and the execution
  queue and reconciler run as in-process timers. Running two instances against
  the same database would allow duplicate workers and conflicting sequence
  numbers. Do not autoscale horizontally.

### Required environment

| Variable | Required | Notes |
|---|---|---|
| `STELLAR_TESTNET_SECRET_KEY` | yes | Testnet signing key, read at startup by `TestnetLocalSigner`. Never bake into an image. |
| `STELLAR_HORIZON_URL` | no | Defaults to `https://horizon-testnet.stellar.org`. **Must contain `testnet`** or startup fails. |
| `HOST` | yes in a container | Bind address. Use `0.0.0.0` to be reachable outside the container/network namespace. Defaults to `127.0.0.1` (loopback only). |
| `PORT` | usually | Defaults to `3000`. Most platforms inject this. |
| `DATABASE_PATH` | yes in production | SQLite file path. Omit it and all records live in memory and are lost on restart. Mount a **persistent** volume at this path. |
| `API_KEYS` | yes unless deliberately public | `key:ownerId[:subject]`, comma-separated. Enables `ProductionApiKeyAuthProvider`; every protected endpoint then requires `Authorization: Bearer <key>`. |
| `CORS_ORIGIN` | when the frontend is cross-origin | Comma-separated exact browser origins. Unset ⇒ no `Access-Control-Allow-Origin` header ⇒ browsers block the calls. |
| `LIVE_SUBMIT` | no | `1` enables real Testnet submission. Off by default. |
| `ALLOW_DEV_AUTH` | no | See "Authentication fail-closed" below. |

### Authentication fail-closed

Development auth (`DevAuthProvider`) authenticates **every** request as a single
default owner with no credentials. To keep local development simple while
preventing an accidental public exposure, startup refuses to run when:

- `HOST` is not loopback (`127.0.0.1`, `localhost`, `::1`), **and**
- `API_KEYS` is not set, **and**
- `ALLOW_DEV_AUTH` is not `1`.

That combination exits with a `FATAL` error rather than serving an
unauthenticated API on a public interface. Setting `ALLOW_DEV_AUTH=1` is an
explicit operator opt-in and must not be used for a real deployment.

### Persistent filesystem

`DATABASE_PATH` must live on storage that survives restarts and redeploys —
a container volume or attached disk. An ephemeral container filesystem loses
agents, activities, approvals, schedules, executions, and policy config on every
restart, and the SQLite file cannot be reliably shared between instances.

### Background workers

`apps/api/src/server.ts` starts, in-process:

- an **execution queue** (polls for due executions every 10s, with retry and
  dead-letter semantics), and
- a **transaction status reconciler** (polls Horizon every 30s for submitted
  transactions).

Startup also runs `ExecutionRecoveryService.recover()` to re-queue records left
in `executing` by an unclean shutdown. These timers require a process that stays
alive; a platform that freezes or suspends idle processes will delay execution
and reconciliation. Note also that the process has no `SIGTERM`/`SIGINT` handler,
so a platform that stops hard on shutdown can interrupt in-flight work — the
startup recovery pass is what repairs that on the next boot.

### Not supported: serverless and scale-to-zero

This API must not be deployed to a request-scoped serverless or scale-to-zero
platform. The blockers are structural, not configuration:

- file-backed SQLite (no shared database service),
- long-lived in-process timers (queue, reconciler, scheduler),
- in-process sequence serialization for Stellar submissions,
- a persistent single-instance process model.

Deploy it as a long-running service with a persistent volume. The Dockerfile in
`apps/api/Dockerfile` builds a provider-neutral image for that purpose:

```
docker build -f apps/api/Dockerfile -t 4evergent-api .
```

It runs the repository's own start script (`pnpm --filter @4evergent/api start`
→ `node apps/api/dist/server.js`) and takes all configuration from the runtime
environment. No provider-specific configuration is included.

### Frontend integration

The dashboard (`apps/web`) is a static Vite SPA. Set `VITE_API_BASE` at build
time to the API's public origin, and set the API's `CORS_ORIGIN` to the
frontend's origin. The two are configured independently — the frontend must not
rely on same-origin `/api` proxying. See `.env.example`.
