# 4evergent Operator CLI

`4evergent` is a command-line operator client for the 4evergent HTTP API. It is
an operator tool only — it does NOT sign transactions, build Stellar operations,
or access Horizon directly. All transaction work is delegated to the API server.

## Install

```bash
npm install --global @4evergent/cli
4evergent --help
```

The published package includes its built CLI and installs the `4evergent`
command. To run the source version while developing this repository, install
the workspace dependencies and use `pnpm --filter @4evergent/cli build`.

## Version

Run `4evergent --version` or `4evergent -v` to print the CLI package version and
exit successfully. This works offline and does not require API configuration.
The build embeds the version from `apps/cli/package.json`; source runs read the
same package metadata.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `FOREGENT_API_URL` | `http://127.0.0.1:3000` | API base URL |
| `FOREGENT_API_KEY` | - | Bearer API key (production auth mode) |
| `FOREGENT_API_TIMEOUT_MS` | `5000` | Per-request timeout in milliseconds (positive integer) |

```bash
export FOREGENT_API_URL=http://localhost:3000
export FOREGENT_API_KEY=your-api-key-here
export FOREGENT_API_TIMEOUT_MS=5000
```

Set these variables in the same shell before invoking `4evergent`; the API key
is read from the environment and is never saved by the CLI. `FOREGENT_API_KEY`
is optional when the API is running in development authentication mode.

## Commands

```
4evergent health                           Check API health
4evergent agent list                        List your agents
4evergent agent get <id>                    Show agent details
4evergent agent pause <id>                  Pause agent (rejects new intents)
4evergent agent resume <id>                 Resume agent (active)
4evergent agent disable <id>                Disable agent
4evergent approval list                     List pending approvals
4evergent approval get <id>                 Show approval detail
4evergent approval approve <id>             Approve an intent
4evergent approval reject <id>              Reject an intent
4evergent execution list                    List executions across all agents
4evergent execution get <id>                Show execution detail
4evergent execution retry <id>              Retry a failed or dead-letter execution
4evergent execution cancel <id>             Cancel a queued or executing execution
4evergent policy get <agent-id>             Show effective policy rules
4evergent activity list <agent-id> [limit]  List agent activity (limit 1-100, default 50)
4evergent activity get <agent-id> <activity-id>  Show activity detail
4evergent schedule list <agent-id> [limit]  List agent schedules (limit 1-100, default 50)
4evergent schedule get <agent-id> <sch-id>  Show schedule detail
4evergent intent submit <agent-id> <type> [args...] [--idempotency-key <key>]
                                            Submit an intent (see Intent types below)
```

## Intent submission

Supported intent types (accepted by the transaction pipeline):

```
payment       <asset> <amount> <destination> <reason> [memo]
trustline     <assetCode> <issuer> <reason> [limit]
contract_call <contractId> <function> <args-json-array> <reason>
```

`account_settings` is NOT supported by the transaction pipeline and is
rejected by the CLI.

The server decides the outcome: policy `allow` executes directly,
`requires_approval` returns an approvalId (approve it later with
`4evergent approval approve`), `deny` is rejected with 403.

### Idempotency

Use `--idempotency-key <key>` to make submissions safe against network
timeouts: the same key + same intent returns the original result instead
of creating a duplicate (HTTP 200), and the same key with a different
intent is rejected with 409.

If the CLI reports a network failure, the request outcome is UNKNOWN —
the request may have reached the server. Retry manually with the SAME
`--idempotency-key`. The CLI never retries automatically and never
submits twice silently.

### Request timeout

Every request has a finite deadline, so a server that accepts the connection
but never responds cannot hang the CLI. CI jobs, cron wrappers, and shell
pipelines inherit no hang.

- **Default:** `5000` ms, applied to every command through the shared HTTP
  path — no command has its own request path.
- **Override:** set `FOREGENT_API_TIMEOUT_MS` to a positive integer number of
  milliseconds. An invalid value is reported on stderr and the default is used.
- **On timeout:** the CLI prints a distinct message and exits `3`:

  ```
  Request timed out after 5000ms: GET http://127.0.0.1:3000/health. The server accepted the connection but did not respond in time. Set FOREGENT_API_TIMEOUT_MS to change the deadline; the CLI does not retry automatically.
  ```

The deadline bounds the HTTP request, not the process: once a response has
been received, the CLI takes as long as it needs to print it. A timeout is a
network failure of the kind described above, so the outcome is UNKNOWN and the
CLI does not retry automatically — retry manually, using the SAME
`--idempotency-key` for intent submissions.

## Examples

```bash
4evergent health
4evergent agent list
4evergent agent pause agent-123
4evergent approval list
4evergent approval get ap-123
4evergent approval approve ap-123
4evergent execution list
4evergent execution get exec-123
4evergent execution retry exec-123
4evergent execution cancel exec-123
4evergent policy get agent-123
4evergent activity list agent-123
4evergent activity list agent-123 10
4evergent activity get agent-123 act-123
4evergent schedule list agent-123
4evergent schedule get agent-123 sch-123
4evergent intent submit agent-123 payment XLM 25 GDAAAA... "weekly payout"
4evergent intent submit agent-123 payment XLM 25 GDAAAA... "weekly payout" --idempotency-key weekly-42
4evergent intent submit agent-123 trustline USDC GDAAAA... "add USDC trustline" 1000
4evergent intent submit agent-123 contract_call CABCD... transfer '["arg1","arg2"]' "transfer funds"
```

## Output

Default output is human-readable. Every command exits `0` on success,
non-zero on failure. The `--json` flag is not yet supported — planned for a
future CLI phase.

### Exit codes

| Code | Meaning | Failure message |
|---|---|---|
| `0` | Success | — |
| `1` | Usage error, connection failure, or server rejected the request | `Usage: ...`, `Cannot connect to API at <url>. Is the server running?` (`ECONNREFUSED` / `ENOTFOUND`), `HTTP <status>: <message>` |
| `3` | Request timed out — the server accepted the connection but did not respond within the deadline | `Request timed out after <ms>ms: <method> <url>...` |

The three failure modes are therefore distinguishable by script: **server
down** is `1` with `Cannot connect ...`, **server too slow** is `3` with
`Request timed out ...`, and **server said no** is `1` with
`HTTP <status>: ...`.

## Security

- **Never stores credentials.** API key is read from the environment on each run.
- **Never prints secrets.** API keys, XDR blobs, and private keys never appear in output.
- **No direct Stellar access.** The CLI only makes HTTP calls to the configured API.
- **No mainnet support.** The API itself rejects non-testnet Horizon URLs.
- The API key is sent as `Authorization: Bearer <key>` on every request when set.
