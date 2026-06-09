import type { Pool } from "pg";
import {
  type ApiFailPayload,
  type ApiNotifyPayload,
  notifyApi,
  notifyApiFail,
} from "../gateway.js";
import { config } from "../config";
import { makePgPool } from "../db";
import { withRetry } from "../utils";

// Envio creates tables in this schema (default: "public", override with ENVIO_PG_PUBLIC_SCHEMA).
const PG_SCHEMA = process.env.ENVIO_PG_PUBLIC_SCHEMA ?? "public";

// ── Types ─────────────────────────────────────────────────────────────────────

type FailureRow = {
  id: string;
  eventType: string;
  paymentId: string;
  payload: string;
  attempts: number;
  lastError: string;
  createdAt: number;
};

// ── Core reconciliation logic ─────────────────────────────────────────────────

/**
 * Processes one batch of unresolved API notification failures.
 *
 * For each row in api_sync_failures WHERE resolved_at IS NULL:
 *   1. Parses the JSON payload stored at failure time.
 *   2. Re-attempts the rail0-api notification via withRetry.
 *   3. On success, sets resolved_at to the current Unix timestamp.
 *   4. On failure, logs a warning and leaves the row for the next tick.
 *
 * The stored payload mirrors the ApiNotifyPayload / ApiFailPayload sent at
 * indexing time, including chainId — so the reconciler replays the exact same
 * notification the indexer would have sent, including the originating chain.
 */
/** Exported for unit testing; call startReconciler() in production. */
export async function reconcile(pool: Pool): Promise<void> {
  const { rows } = await pool.query<FailureRow>(
    `SELECT id, "eventType", "paymentId", payload, attempts, "lastError", "createdAt"
     FROM "${PG_SCHEMA}"."ApiSyncFailure"
     WHERE "resolvedAt" IS NULL
     ORDER BY "createdAt"
     LIMIT $1`,
    [config.reconcileBatchSize],
  );

  if (rows.length === 0) return;

  console.log(`[reconciler] Processing ${rows.length} unresolved failure(s)…`);

  let resolved = 0;

  for (const row of rows) {
    const p = JSON.parse(row.payload) as { txHash: `0x${string}` } & Record<string, unknown>;

    const result = await withRetry(async () => {
      // Replay the rail0-api notification using the payload stored at failure time.
      // txHash goes in the URL; the rest of the payload (eventType, paymentId,
      // blockNumber, amount) goes in the request body.
      switch (row.eventType) {
        case "authorized":
        case "charged":
        case "captured":
        case "voided":
        case "released":
        case "refunded":
          await notifyApi(p.txHash, p as unknown as ApiNotifyPayload);
          break;
        case "failed":
          await notifyApiFail(p.txHash, p as unknown as ApiFailPayload);
          break;
        default:
          throw new Error(`Unknown event type: ${row.eventType}`);
      }
    });

    if (result.ok) {
      await pool.query(`UPDATE "${PG_SCHEMA}"."ApiSyncFailure" SET "resolvedAt" = $1 WHERE id = $2`, [
        Math.floor(Date.now() / 1000),
        row.id,
      ]);
      resolved++;
    } else {
      console.warn(`[reconciler] Failed to resolve ${row.id} (${row.eventType}): ${result.error}`);
    }
  }

  console.log(`[reconciler] Resolved ${resolved}/${rows.length} failure(s)`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Starts the background reconciliation loop.
 *
 * - Runs immediately on start, then every reconcileIntervalSecs seconds.
 * - Returns a triggerNow() function for on-demand runs (e.g. from an API route).
 */
export function startReconciler(): { triggerNow: () => Promise<void> } {
  const pool = makePgPool(2);
  const run = () =>
    reconcile(pool).catch((err) => {
      // Table not yet created by Envio — silently skip until next tick.
      if (err instanceof Error && err.message.includes("does not exist")) return;
      console.error("[reconciler] Unexpected error:", err);
    });

  if (config.reconcileIntervalSecs > 0) {
    // Run once immediately, then on schedule.
    void run();
    setInterval(run, config.reconcileIntervalSecs * 1000);
    console.log(`[reconciler] Started — interval ${config.reconcileIntervalSecs}s`);
  } else {
    console.log("[reconciler] Started — manual mode (POST /reconcile to trigger)");
  }

  return { triggerNow: () => reconcile(pool) };
}
