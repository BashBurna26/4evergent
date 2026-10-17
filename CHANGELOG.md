# Changelog

All notable changes to this project are recorded in this file.

## [Unreleased]

### Security
- Stellar network safety guard validating Horizon URL + passphrase, rejecting mainnet execution (Phase 21)
- Live submission gate requiring explicit `LIVE_SUBMIT=1` opt-in before real Testnet submission (Phase 21)
- Atomic daily spending reservation via dedicated `daily_spending` table with conditional SQL updates (Phase 23)
- Atomic idempotency reservation via unique database constraints and concurrent-map serialization (Phase 23)
- Numeric amount validation in PolicyEngine rejecting negative, zero, and malformed inputs (Phase 23)
- Per-account sequence serialization via `AccountSequenceCoordinator` preventing sequence collisions (Phase 25)
- Sequence coordination wrap for direct ALLOW intents and synchronous approval fallback execution (Phase 26A)
- Authentication boundary abstraction (`AuthProvider`, `AuthenticatedPrincipal`, `DevAuthProvider`) (Phase 28I)
- Request-scoped authentication context propagation ensuring tamper-proof approver identity (Phase 28K)
- Production API key authentication (`ProductionApiKeyAuthProvider`) with fail-closed configuration (Phase 28T)
- User authentication module supporting session cookies, scrypt passwords, Google OAuth, and Stellar wallet signatures (Phase 28U)
- CORS origin validation with credentialed header reflection (Phase 28W)
- Atomic execution claim via `updateIfStatus(queued→executing)` CAS to prevent concurrent workers from executing the same record (Phase 18A)
- Idempotency-Key header support for `POST /agents/:id/intents` to prevent duplicate financial execution from repeated API requests (Phase 18B)
- Horizon pre-check mitigation before blind retry — guards against duplicate submission when original transaction may have reached Horizon (Phase 18C)

### Added
- Persistent agent policy configuration (`PolicyConfigStore`, `SQLitePolicyConfigStore`) with monotonic versioning (Phase 28A)
- Policy resolver callback support in `PolicyEngine` and `TransactionPipeline` (Phase 28A, 28J)
- `PolicyEngine.evaluateWithoutReservation()` for policy check re-evaluation on approved intents (Phase 28J)
- Correlation ID propagation and request logging middleware via `X-Request-Id` (Phase 28L)
- User session authentication endpoints under `/auth/*` (register, login, challenge, verify, google, logout, me, config) (Phase 28U)
- `AccountSequenceCoordinator.runExclusive()` coordinating sequence-sensitive operations per Stellar account (Phase 25)
- `ExecutionRecord.submittedHash` field persisted on all pipeline paths for pre-check identification
- `ExecutionQueue.preCheck` option for pluggable transaction status verification
- `PreCheckFn` / `PreCheckResult` types for adapter-level integration
- `StellarAdapter.getTransactionStatus()` used as preCheck implementation in API server

### Changed
- All API route handlers explicitly receive `RequestContext` instead of relying on thread-local proxies (Phase 28K)
- Server bootstrap validates network configuration and enforces secure auth modes when exposed (Phase 21, 28T)
- `StellarSubmitter.submit()` error now preserves `preSubmitHash` for recovery/reconciliation
- `TransactionPipeline` carries `idempotencyKey` through all execution paths
- `ActivityStore.recordIdempotent()` for atomic key-based reservation

### Documentation
- Phase 19A: refreshed README, CONTRIBUTING, security-model, architecture, testnet docs
- Added SECURITY.md, issue templates, PR template
- Updated roadmap (`docs/roadmap.md`) to reflect shipped Phases 12 through 28W

## [0.1.0] — Project inception through Phase 18

- Monorepo scaffold with pnpm workspaces
- Policy engine (deterministic, pure function)
- Intent validation (payment, trustline, contract_call, account_settings)
- Transaction pipeline: build → simulate → sign → submit
- Activity/approval logging with in-memory + SQLite stores (`node:sqlite`)
- Execution queue with retry, dead-letter, and crash recovery
- Agent self-serve creation via `POST /agents`
- Agent scheduling & automation
- Web dashboard (React + TypeScript + Vite)
- GitHub Actions CI (build/typecheck/test)

[Unreleased]: https://github.com/naninu123/4evergent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/naninu123/4evergent/releases/tag/v0.1.0
