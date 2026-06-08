/**
 * api/index.ts
 *
 * Standalone Hono API server that exposes indexer data and background services.
 * Unlike rail0-indexer (Ponder), Envio does not provide an integrated API server —
 * this process starts separately and connects to the same PostgreSQL database.
 *
 * Endpoints:
 *   POST /reconcile                   — trigger an immediate reconciliation run
 *   GET  /transactions/:tx_hash       — on-chain gas data for a confirmed tx
 *
 * Environment variables:
 *   DATABASE_URL          — PostgreSQL connection string (same DB as Envio)
 *   API_PORT              — port to listen on (default: 3001)
 *
 * ── Table names ───────────────────────────────────────────────────────────────
 * Envio creates PostgreSQL tables named after the GraphQL entities.
 * By default the tables are stored in the public schema with quoted names:
 *   "PaymentEvents", "Payments", "ApiSyncFailures"
 *
 * Column names match the GraphQL field names (camelCase).
 * Run `pnpm codegen` after schema changes to regenerate Envio types.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Pool } from "pg";

import { config } from "../config";
import { startReconciler } from "../reconciler";
import { startSweeper } from "../sweeper";

// ── DB pool ───────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

// ── Background services ───────────────────────────────────────────────────────

const { triggerNow } = startReconciler();
startSweeper();

// ── Routes ────────────────────────────────────────────────────────────────────

const app = new Hono();

/**
 * GET /health
 *
 * Simple liveness probe — returns 200 if the API process is up.
 * Does not check Envio indexer health (use Envio's own metrics for that).
 */
app.get("/health", (c) => c.json({ ok: true }));

/**
 * POST /reconcile
 *
 * Triggers an immediate reconciliation run outside the normal schedule.
 * Useful for ops/debugging after an API DB outage.
 * The run happens asynchronously — the endpoint returns immediately.
 */
app.post("/reconcile", async (c) => {
  void triggerNow().catch((err) => console.error("[reconciler] Manual trigger error:", err));
  return c.json({ ok: true, message: "Reconcile run triggered" });
});

/**
 * GET /sync/chains/:chain_id/transactions/:tx_hash
 *
 * Returns on-chain gas data for a confirmed transaction indexed by Envio.
 * Both chain_id and tx_hash are required — a tx_hash alone does not uniquely
 * identify a transaction across multiple chains.
 *
 * Path params:
 *   chain_id — numeric EVM chain ID
 *   tx_hash  — 0x-prefixed 32-byte transaction hash
 *
 * Response 200:
 *   {
 *     tx_hash, payment_id, chain_id, event_type,
 *     block_number, block_timestamp,
 *     gas_limit, gas_used, effective_gas_price,
 *     gas_cost,           // gas_used * effective_gas_price (wei)
 *     base_fee_per_gas,   // null on pre-London blocks
 *   }
 *
 * Response 400: { error: "invalid_chain_id" }
 * Response 404: { error: "not_found" }
 */
app.get("/sync/chains/:chain_id/transactions/:tx_hash", async (c) => {
  const txHash = c.req.param("tx_hash");
  const chainId = Number(c.req.param("chain_id"));

  if (Number.isNaN(chainId)) {
    return c.json({ error: "invalid_chain_id" }, 400);
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg QueryResult rows are untyped
  let result: import("pg").QueryResult<Record<string, unknown>>;
  try {
    result = await pool.query(
      `SELECT * FROM "PaymentEvents" WHERE "txHash" = $1 AND "chainId" = $2 LIMIT 1`,
      [txHash, chainId],
    );
  } catch (err) {
    console.error("[api] DB query error:", err);
    return c.json({ error: "db_error" }, 500);
  }

  const row = result.rows[0];
  if (!row) {
    return c.json({ error: "not_found" }, 404);
  }

  // BigInt arithmetic — values come back as strings from pg when > MAX_SAFE_INTEGER.
  const gasUsed = BigInt(row.gasUsed as string);
  const effectiveGasPrice = BigInt(row.effectiveGasPrice as string);
  const gasCost = gasUsed * effectiveGasPrice;

  return c.json({
    tx_hash: row.txHash,
    payment_id: row.paymentId,
    chain_id: row.chainId,
    event_type: row.eventType,
    block_number: String(row.blockNumber),
    block_timestamp: row.blockTimestamp,
    gas_limit: String(row.gasLimit),
    gas_used: gasUsed.toString(),
    effective_gas_price: effectiveGasPrice.toString(),
    gas_cost: gasCost.toString(),
    base_fee_per_gas: row.baseFeePerGas != null ? String(row.baseFeePerGas) : null,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const port = config.apiPort;

serve({ fetch: app.fetch, port }, () => {
  console.log(`[api] Listening on port ${port}`);
});

export default app;
