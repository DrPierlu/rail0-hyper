# rail0-hyper

RAIL0 payment event indexer using [Envio HyperSync](https://docs.envio.dev/) — the faster-backfill alternative to [rail0-indexer](../rail0-indexer) (which uses Ponder).

## Overview

| Feature | rail0-indexer (Ponder) | rail0-hyper (Envio) |
|---|---|---|
| Indexing engine | Ponder (eth_getLogs) | Envio HyperSync |
| Config format | `ponder.config.ts` (TypeScript) | `config.yaml` (YAML) |
| Schema | `ponder.schema.ts` | `schema.graphql` |
| Handlers | `src/RAIL0.ts` | `src/EventHandlers.ts` |
| API server | Integrated (ponder:api) | Standalone Hono process |
| DB | PostgreSQL / PGlite | PostgreSQL |
| Backfill speed | Standard RPC | HyperSync (much faster on supported chains) |

Both indexers emit the same rail0-api notifications, maintain the same data model, and expose the same REST API endpoints.

## Prerequisites

- Node.js ≥ 18.14
- pnpm
- PostgreSQL (or Docker for local dev)
- Access to rail0-api (for start block resolution and transaction notifications)

## Getting started

```bash
cp .env.example .env
# fill in DATABASE_URL, RAIL0_API_URL, RAIL0_API_HMAC_SECRET

pnpm install
pnpm run dev
```

`bin/dev` will:
1. Call `bin/gen-config` to fetch actual start blocks from rail0-api and write `config.yaml`
2. Run Envio codegen if the `generated/` directory is missing
3. Start the Envio indexer and the standalone Hono API server in parallel

## Configuration

### Dynamic start blocks

`bin/gen-config` calls `GET /sync/blockchains` on rail0-api and overwrites `config.yaml` with the actual deployment start block for each chain. If rail0-api is unreachable the script falls back to `start_block: 0` (scan from genesis).

The committed `config.yaml` is the safe fallback (development chain only, `start_block: 0`).

### Adding chains

1. Add the chain to `src/chains.ts` (same structure as rail0-indexer)
2. Add the chain entry to the `CHAINS` map in `bin/gen-config`
3. Run `node bin/gen-config` to regenerate `config.yaml`

### Gas data

Gas fields (`gasUsed`, `effectiveGasPrice`) are enabled via `field_selection.transaction_fields` in `config.yaml`. Envio fetches a transaction receipt for each event to populate these — equivalent to Ponder's `includeTransactionReceipts: true`.

**Evaluate the RPC cost** before enabling on high-volume chains or paid endpoints. The `GET /transactions/:tx_hash` API endpoint depends on these fields.

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `POST` | `/reconcile` | Trigger immediate reconciliation of failed API notifications |
| `GET` | `/sync/chains/:chain_id/transactions/:tx_hash` | On-chain gas data for a confirmed transaction |

The API server runs on port `3001` by default (configurable via `API_PORT`).

## Architecture

```
Envio HyperSync ──► src/EventHandlers.ts ──► PostgreSQL (Envio DB)
                          │
                          └──► POST /sync/chains/:chain_id/transactions/:tx_hash (rail0-api HMAC)
                                    │
                              on failure ──► ApiSyncFailures table
                                                   │
                                            src/reconciler.ts (retry loop)

src/sweeper.ts ──► GET /sync/transactions (rail0-api) ──► eth_getTransactionReceipt
                         └── handles reverts + unindexed confirmations

src/api/index.ts ──► Hono HTTP server ──► queries PostgreSQL directly
```
