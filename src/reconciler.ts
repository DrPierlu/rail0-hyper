import { Pool } from "pg";

import { notifyApi, notifyApiFail, type ApiNotifyPayload, type ApiFailPayload } from "./api-client.js";
import { config } from "./config";
import { withRetry } from "./utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type FailureRow = {
  id: string;
  event_type: string;
  payment_id: string;
  payload: string;
  attempts: number;
  last_error: string;
  created_at: number;
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
    `SELECT id, event_type, payment_id, payload, attempts, last_error, created_at
     FROM api_sync_failures
     WHERE resolved_at IS NULL
     ORDER BY created_at
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
      switch (row.event_type) {
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
          throw new Error(`Unknown event type: ${row.event_type}`);
      }
    });

    if (result.ok) {
      await pool.query(
        'UPDATE api_sync_failures SET resolved_at = $1 WHERE id = $2',
        [Math.floor(Date.now() / 1000), row.id],
      );
      resolved++;
    } else {
      console.warn(
        `[reconciler] Failed to resolve ${row.id} (${row.event_type}): ${result.error}`,
      );
    }
  }

  console.log(`[reconciler] Resolved ${resolved}/${rows.length} failure(s)`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Starts the background reconciliation loop.
 *
 * - Runs immediately on start, then every reconcileIntervalSecs seconds.
 * - Silently skips if DATABASE_URL is not set (e.g. local dev with PGlite).
 * - Returns a triggerNow() function for on-demand runs (e.g. from an API route).
 */
export function startReconciler(): { triggerNow: () => Promise<void> } {
  const noop = () => Promise.resolve();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn("[reconciler] DATABASE_URL not set — reconciler disabled");
    return { triggerNow: noop };
  }

  const pool = new Pool({ connectionString, max: 2 });
  const run = () => reconcile(pool).catch((err) => console.error("[reconciler] Unexpected error:", err));

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
