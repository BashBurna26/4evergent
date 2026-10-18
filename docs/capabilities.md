# Agent Capabilities

A capability is a named, policy-governed action an agent may perform on Stellar.

## Built-in capabilities (Phase 1)

| Capability | Intent type | Status |
|------------|-------------|--------|
| `payment` | `PaymentIntent` | ✅ MVP — validation + policy |
| `trustline` | `TrustlineIntent` | ✅ MVP — validation + policy |
| `contract_call` | `ContractCallIntent` | ✅ validation; policy denies by default |
| `account_settings` | `AccountSettingsIntent` | ✅ supported — `buildAccountSettings` + `parseIntent` + tests |

## Stellar Asset Support (Phase 12)

| Operation | Status | Notes |
|-----------|--------|-------|
| XLM payment (native) | ✅ Supported | `PaymentIntent` with `asset: "XLM"` |
| Issued asset payment | ✅ Supported | `PaymentIntent` with `assetDetails: { code, issuer }` |
| Create trustline | ✅ Supported | `TrustlineIntent` with `assetCode`, `issuer`, optional `limit` |
| Path payments | ❌ Not supported | — |
| Contract invocation | ❌ Not supported | Policy denies by default |
| Account settings | ✅ Supported | `AccountSettingsIntent` with `setting` + `value` — `home_domain`, `inflation_destination`, `signer`, `thresholds`, `set_flags`, `clear_flags` |
| Token issuance | ❌ Not supported | — |
| Soroban contracts | ⚠️ AgentRegistry deployed on Testnet | Contract exists and is callable directly; the transaction pipeline still does not invoke contracts (`contract_call` policy-denied by default). See `docs/testnet.md` and the [integration guide](soroban-integration.md). |

### Asset representation

All asset references use a consistent `PaymentAsset` shape:

```typescript
interface PaymentAsset {
  code: string;        // "XLM" or issued asset code (e.g. "USDC")
  issuer: string | null;  // Stellar address for issued assets; null for native XLM
}
```

This representation is used across:
- `PaymentIntent.assetDetails` (shared types)
- `TrustlineIntent.assetCode` + `TrustlineIntent.issuer`
- `extractAsset()` in PolicyEngine (normalizes to `CODE:ISSUER` or `XLM`)
- `StellarTransactionBuilder.parseAssetInput()` (resolves to Stellar SDK `Asset`)
- Activity/execution records

### Trustline flow

```
TrustlineIntent
  → IntentValidator.validateTrustline()
  → PolicyEngine.evaluate()
  → Approval gate (if configured)
  → ExecutionQueue (if async)
  → TransactionPipeline.execute()
  → StellarTransactionBuilder.buildTrustline()
  → StellarSimulator.simulate()
  → Signer.sign()
  → StellarSubmitter.submit()
  → Activity record
```

## Adding a new capability

See the "Adding a new agent capability" section of [README.md](../README.md).
