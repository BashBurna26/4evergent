# API Server Troubleshooting

This page documents observable behavior of the current implementation. Error messages, startup checks, and source line references must be kept in sync with `apps/api/src/server.ts`.

## Contents

- [Startup failures](#startup-failures)
- [API_KEYS format](#api_keys-format)
- [Authentication modes](#authentication-modes)
- [Testnet Horizon guard](#testnet-horizon-guard)
- [Container binding](#container-binding)
- [Startup exits and logs](#startup-exits-and-logs)
- [Fresh-checkout build ordering](#fresh-checkout-build-ordering)
- [Dashboard cannot reach the API](#dashboard-cannot-reach-the-api)
- [Source mapping](#source-mapping)
- [Local verification evidence](#local-verification-evidence)

## Startup failures

Each entry below corresponds to a `FATAL:` call site in the current API server. `${...}` denotes a value interpolated by the implementation, not literal output. The parser includes the offending `API_KEYS` entry in its error; redact it before sharing logs if it could contain credential material.

### Invalid API_KEYS entry format

- **Message:** `FATAL: Invalid API_KEYS format. Expected key:ownerId[:subject], got: ${entry}`. `${entry}` is the trimmed comma-separated entry that has fewer than two colon-separated fields.
- **Cause:** An entry does not contain the required `key:ownerId` fields, for example a value with no colon.
- **Fix:** Set each entry to `key:ownerId` or `key:ownerId:subject`, with entries separated by commas. Use a fake local example while developing; never put real credentials in this document or a transcript.
- **Source:** [apps/api/src/server.ts](../apps/api/src/server.ts#L58).
- **Further reading:** [API authentication](api.md#authentication) and [API Authentication](security-model.md#api-authentication-development-vs-production).

### Missing API key or owner ID

- **Message:** `FATAL: API key and ownerId are required. Got: ${entry}`. `${entry}` is the invalid configured entry.
- **Cause:** The first field (`key`) or second field (`ownerId`) is empty after splitting on `:`.
- **Fix:** Supply both a non-empty key and owner ID, then restart the server. Keep actual keys in runtime secret configuration, not in logs or screenshots.
- **Source:** [apps/api/src/server.ts](../apps/api/src/server.ts#L63).
- **Further reading:** [API authentication](api.md#authentication) and [API Authentication](security-model.md#api-authentication-development-vs-production).

### Horizon URL is not Testnet

- **Message:** `FATAL: STELLAR_HORIZON_URL must point to Testnet (got: ${horizonUrl}). Mainnet execution is not supported.` `${horizonUrl}` is the configured URL.
- **Cause:** The URL does not contain `testnet`. This guard runs before signer construction, API key parsing, or server creation.
- **Fix:** Use `STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org` (or leave it unset to use that default). Mainnet execution is unsupported by design; do not bypass this guard.
- **Source:** [apps/api/src/server.ts](../apps/api/src/server.ts#L124).
- **Further reading:** [Testnet setup](testnet.md).

### Testnet signer construction failed

- **Message template:** `FATAL: ${err.message}`. The error text is supplied by the thrown signer-construction error.
- **Cause:** `TestnetLocalSigner` throws when `STELLAR_TESTNET_SECRET_KEY` is missing or is not a valid Stellar secret key.
- **Fix:** Configure a valid Testnet-only key through your local runtime environment or secrets manager. Do not commit it, print it, or include it in a support transcript. Signing keys are not needed just to inspect the earlier Horizon guard.
- **Source:** [apps/api/src/server.ts](../apps/api/src/server.ts#L133); signer details are in [testnet-local-signer.ts](../packages/stellar/src/testnet-local-signer.ts).
- **Further reading:** [Testnet setup](testnet.md) and [key management](security-model.md#key-management).

### Public bind refused without production auth

- **Message template:** `FATAL: ${decision.reason}`. For this refusal, the reason is `refusing to start: bind host '${host}' is not loopback and API_KEYS is unset. Set API_KEYS for production authentication, bind to 127.0.0.1, or explicitly set ALLOW_DEV_AUTH=1.` The host is dynamic.
- **Cause:** `HOST` is not `127.0.0.1`, `localhost`, or `::1`; no usable API keys were parsed; and `ALLOW_DEV_AUTH` is not exactly `1`.
- **Fix:** For a local server, bind to `127.0.0.1`. For a production deployment, configure valid `API_KEYS`. The printed `ALLOW_DEV_AUTH=1` option is only an explicit unsafe development opt-in, not a production fix.
- **Source:** [apps/api/src/server.ts](../apps/api/src/server.ts#L147).
- **Further reading:** [Authentication fail-closed](api.md#authentication-fail-closed) and [API Authentication](security-model.md#api-authentication-development-vs-production).

### API server creation or listen failed

- **Message template:** `FATAL: ${err.message}`. The error text is supplied by the exception caught during server creation or `server.listen()`.
- **Cause:** Server initialization or binding threw an error. The underlying message is dynamic; inspect it for the specific address, port, storage, or initialization problem.
- **Fix:** Correct the reported underlying configuration or resource problem, then restart. Confirm the requested port is available and that the process can access its configured storage.
- **Source:** [apps/api/src/server.ts](../apps/api/src/server.ts#L223).
- **Further reading:** [hosted runtime and deployment](api.md#hosted-runtime-production-deployment).

## API_KEYS format

The parser accepts comma-separated entries in the form `key:ownerId[:subject]`:

- `key` is the credential clients send as `Authorization: Bearer <key>`.
- `ownerId` is the server-assigned owner identity; clients cannot choose it.
- `subject` is optional identity metadata. When omitted or empty, the implementation uses `key:` followed by the first eight characters of the key.

Syntactically valid local-only example (not a credential and not suitable for production):

```dotenv
API_KEYS=local-only-example-key:not-a-real-owner:docs-example
```

Use actual randomly generated keys only in runtime secret configuration. Do not paste them into documentation, screenshots, or transcripts.

The parser splits entries on commas and fields on colons. A missing colon, empty key (`:owner`), or empty owner (`key:`) triggers a startup `FATAL:`. Empty comma-separated entries are ignored; additional colon-separated fields after `subject` are not used by the current parser, so stick to the documented two- or three-field format. A malformed value is not silently ignored or treated as development authentication.

## Authentication modes

The server selects a mode from the parsed keys, `HOST`, and whether `ALLOW_DEV_AUTH` is exactly `1`:

| Mode | Required configuration and selection | Startup | Operational and security implications |
|---|---|---|---|
| Production authentication | At least one valid parsed `API_KEYS` entry. This takes precedence over `ALLOW_DEV_AUTH`. | Allowed. | Uses `ProductionApiKeyAuthProvider`; protected API requests require a configured Bearer key. Use this for a deployed service. |
| Loopback development | No usable `API_KEYS`; `HOST` is exactly `127.0.0.1`, `localhost`, or `::1`. `HOST` defaults to `127.0.0.1`. | Allowed without an opt-in. | Uses `DevAuthProvider` and the `DEV_OWNER_ID` (default `operator`); requests are treated as that owner without credentials. Keep the server local. |
| Explicit public development | No usable `API_KEYS`; non-loopback `HOST`; `ALLOW_DEV_AUTH=1`. | Allowed only after explicit opt-in. | Uses `DevAuthProvider` on a public interface, so it is unauthenticated development access. This is not appropriate for production. |
| Unsafe public configuration | No usable `API_KEYS`; non-loopback `HOST`; `ALLOW_DEV_AUTH` is unset or not exactly `1`. | Refused with `FATAL:` and exit code `1`. | Fail-closed behavior prevents accidental public development authentication. The diagnostic says to configure `API_KEYS`, bind to `127.0.0.1`, or explicitly opt into `ALLOW_DEV_AUTH=1`. |

With the public development opt-in, the startup auth line appends this exact banner: `[ALLOW_DEV_AUTH=1 — public bind without API_KEYS]`. It appears only when the selected mode is development because `ALLOW_DEV_AUTH=1` enabled a non-loopback bind with no API keys. **Do not enable development authentication on a public bind for production.** The banner is a warning, not a security control.

See [the API's authentication fail-closed section](api.md#authentication-fail-closed) and the [security model](security-model.md#api-authentication-development-vs-production).

## Testnet Horizon guard

The API rejects a `STELLAR_HORIZON_URL` that does not contain `testnet`; Mainnet transaction execution is intentionally unsupported. Use the canonical endpoint `https://horizon-testnet.stellar.org`, which is also the default when the variable is unset. See the [Testnet setup guide](testnet.md) for the supported network configuration and workflow.

## Container binding

The server defaults `HOST` to `127.0.0.1`, which accepts connections only from loopback inside its own network namespace. For a container that should accept traffic from outside that namespace, configure `HOST=0.0.0.0` and publish or route the container port to the intended network. Setting the bind address alone does not publish the port.

A non-loopback bind still needs valid production `API_KEYS`; do not expose an unauthenticated development server. See [hosted runtime, deployment, and Docker guidance](api.md#hosted-runtime-production-deployment).

## Startup exits and logs

The startup fatal paths call `process.exit(1)`. Exit code `1` means startup failed; a process manager or container orchestrator may consequently restart the process repeatedly. Inspect the service logs before changing configuration:

```sh
docker logs <container-name> 2>&1
docker logs -f <container-name>
journalctl -u <service-name> -b --no-pager
```

Use `journalctl` only for a systemd-managed service, and replace `<service-name>` with the actual unit name. These are inspection commands; they have not been run as part of the local reproductions below.

## Fresh-checkout build ordering

If `pnpm typecheck` reports `TS2307: Cannot find module '@4evergent/shared'` on a fresh checkout, the workspace package may not have been built yet. The workspace package metadata points imports at generated `dist/` output, so this can be a build-ordering issue rather than a missing dependency. Follow the existing [build-before-typecheck instructions](../CONTRIBUTING.md#development-setup); this page intentionally does not duplicate them.

## Dashboard cannot reach the API

The web client uses `VITE_API_BASE?.trim() || 'http://localhost:3000'`. If `VITE_API_BASE` is unset or blank, a browser therefore calls `http://localhost:3000`, which is useful only when the API is reachable from that browser at that address. For a deployed or otherwise separate API, set `VITE_API_BASE` to the API's correct public base URL when building the web app; Vite inlines it at build time. See [environment configuration](../.env.example) and [frontend integration](api.md#frontend-integration).

A failed browser request is not automatically a CORS problem. First check that the URL is correct and the API is running and reachable. If the browser reports a CORS policy failure, configure the API's allowed origin (`CORS_ORIGIN`; the server's `WEB_ORIGIN` value is used as its fallback) to match the frontend origin exactly. The API implementation handles this in [apps/api/src/index.ts](../apps/api/src/index.ts#L511); the API entry point supplies `WEB_ORIGIN`, defaulting to `http://localhost:5173`, in [apps/api/src/server.ts](../apps/api/src/server.ts#L158).

## Source mapping

Every `FATAL:` call site found in the current `apps/api/src/server.ts` is listed below. “Reproduced” means the local built application emitted that failure and returned the stated exit code in the evidence section. Other entries are source-derived, not represented as captured output.

| Message or condition | Source | Verification status |
|---|---|---|
| `FATAL: Invalid API_KEYS format. Expected key:ownerId[:subject], got: ${entry}` | [server.ts](../apps/api/src/server.ts#L58) | Reproduced; exit status 1 |
| `FATAL: API key and ownerId are required. Got: ${entry}` | [server.ts](../apps/api/src/server.ts#L63) | Source-derived; this malformed variant was not reproduced |
| `FATAL: STELLAR_HORIZON_URL must point to Testnet (got: ${horizonUrl}). Mainnet execution is not supported.` | [server.ts](../apps/api/src/server.ts#L124) | Reproduced; exit status 1 |
| `FATAL: ${err.message}` from signer construction | [server.ts](../apps/api/src/server.ts#L133) | Source-derived; not reproduced |
| `FATAL: ${decision.reason}` for fail-closed authentication | [server.ts](../apps/api/src/server.ts#L147) | Reproduced; exit status 1 |
| `FATAL: ${err.message}` from server creation/listen | [server.ts](../apps/api/src/server.ts#L223) | Source-derived; not reproduced |

Related behavior: the default `HOST` is set at [server.ts](../apps/api/src/server.ts#L117); mode selection is at [server.ts](../apps/api/src/server.ts#L92); the opt-in banner is at [server.ts](../apps/api/src/server.ts#L190); and startup exit calls are at [server.ts](../apps/api/src/server.ts#L59), [server.ts](../apps/api/src/server.ts#L126), and [server.ts](../apps/api/src/server.ts#L224).

## Local verification evidence

The repository was built with `pnpm build`, then the actual built entry point `node apps/api/dist/server.js` was run. For each case, startup-selection environment variables were isolated, an ephemeral random Stellar Testnet key was generated only to pass signer construction where needed (never printed), and `NODE_NO_WARNINGS=1` suppressed Node's unrelated experimental SQLite warning. `PORT=not-a-port` was used as a fail-safe so an unexpected path could not open a listener. Each targeted failure occurred before `server.listen()`.

### Malformed API_KEYS

Environment: Testnet Horizon, `HOST=127.0.0.1`, `API_KEYS=not-a-valid-entry`, ephemeral test key, `PORT=not-a-port`.

Command:

```powershell
node apps/api/dist/server.js
```

Captured output:

```text
FATAL: Invalid API_KEYS format. Expected key:ownerId[:subject], got: not-a-valid-entry
Exit status: 1
```

### Mainnet Horizon URL

Environment: `STELLAR_HORIZON_URL=https://horizon.stellar.org`, `HOST=127.0.0.1`, `PORT=not-a-port`.

Command:

```powershell
node apps/api/dist/server.js
```

Captured output:

```text
FATAL: STELLAR_HORIZON_URL must point to Testnet (got: https://horizon.stellar.org). Mainnet execution is not supported.
Exit status: 1
```

### Public bind without API_KEYS or development opt-in

Environment: Testnet Horizon, `HOST=0.0.0.0`, `API_KEYS` unset, `ALLOW_DEV_AUTH` unset, ephemeral test key, `PORT=not-a-port`.

Command:

```powershell
node apps/api/dist/server.js
```

Captured output:

```text
FATAL: refusing to start: bind host '0.0.0.0' is not loopback and API_KEYS is unset. Set API_KEYS for production authentication, bind to 127.0.0.1, or explicitly set ALLOW_DEV_AUTH=1.
Exit status: 1
```
