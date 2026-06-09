/**
 * sweeper.ts
 *
 * Detects on-chain reverts and unindexed confirmations for transactions that
 * were broadcast but not yet confirmed by Envio.
 *
 * Every SWEEP_INTERVAL_SECS seconds:
 *   1. GET /sync/transactions  — fetch stale submitted txs from rail0-gateway
 *   2. For each tx, call eth_getTransactionReceipt on its chain
 *   3a. receipt null      → still in mempool, skip
 *   3b. receipt reverted  → notifyApiFail()   (same as handlers / reconciler)
 *   3c. receipt success   → notifyApi()        (same as handlers / reconciler)
 *        (safety net: Envio may be temporarily behind or the event missed)
 *
 * Notifications are sent via the same notifyApi / notifyApiFail used by the
 * Envio event handlers and the reconciler, so the HTTP method, signing, and
 * retry behaviour are centralised in gateway.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { http, createPublicClient } from "viem";
import { config } from "../config";
import { hmacHeaders } from "../hmac";
import { notifyApi, notifyApiFail } from "../gateway";

// ── Chain config from config.yaml ────────────────────────────────────────────

type EnvioConfig = {
  networks: { id: number; rpc: string }[];
};

const envioConfig = loadYaml(
  readFileSync(join(__dirname, "../../config.yaml"), "utf-8"),
) as EnvioConfig;

// ── Types ─────────────────────────────────────────────────────────────────────

type StaleTx = {
  transaction_hash: `0x${string}`;
  payment_id: `0x${string}`;
  chain_id: number;
  /** One of: authorize | charge | capture | void | release | refund */
  operation: string;
  /** On-chain amount in token base units (string); present for capture/refund. */
  amount?: string;
};

type SyncTransactionsResponse = {
  transactions: StaleTx[];
};

// Maps operation verb (from gateway) to the event_type expected by notifyApi.
const OPERATION_TO_EVENT_TYPE: Record<string, string> = {
  authorize: "authorized",
  charge:    "charged",
  capture:   "captured",
  void:      "voided",
  release:   "released",
  refund:    "refunded",
};

// ── viem clients per chain ────────────────────────────────────────────────────

const clients = new Map(
  envioConfig.networks.map((n) => [n.id, createPublicClient({ transport: http(n.rpc) })]),
);

// ── Core sweep logic ──────────────────────────────────────────────────────────

export async function sweep(): Promise<void> {
  const baseUrl = process.env.RAIL0_API_URL;
  const secret  = process.env.RAIL0_API_HMAC_SECRET;

  if (!baseUrl || !secret) {
    console.warn("[sweeper] RAIL0_API_URL or RAIL0_API_HMAC_SECRET not set — skipping");
    return;
  }

  // 1. Fetch stale submitted transactions from rail0-gateway.
  let staleTxs: StaleTx[];
  try {
    const res = await fetch(`${baseUrl}/sync/transactions`, {
      headers: hmacHeaders(secret, ""),
      signal:  AbortSignal.timeout(config.apiTimeoutMs),
    });
    if (!res.ok) {
      console.warn(`[sweeper] GET /sync/transactions failed: ${res.status}`);
      return;
    }
    const data = (await res.json()) as SyncTransactionsResponse;
    staleTxs = data.transactions ?? [];
  } catch (err) {
    console.warn("[sweeper] GET /sync/transactions error:", err);
    return;
  }

  if (staleTxs.length === 0) return;

  console.log(
    JSON.stringify({ component: "sweeper", event: "checking_stale_txs", count: staleTxs.length }),
  );

  // 2. Check each tx on-chain concurrently.
  await Promise.allSettled(staleTxs.map((tx) => checkTx(tx)));
}

async function checkTx(tx: StaleTx): Promise<void> {
  const client = clients.get(tx.chain_id);
  if (!client) {
    console.warn(
      JSON.stringify({
        component: "sweeper",
        event: "unknown_chain",
        chain_id: tx.chain_id,
        tx: tx.transaction_hash,
      }),
    );
    return;
  }

  let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>> | null;
  try {
    receipt = await client.getTransactionReceipt({ hash: tx.transaction_hash });
  } catch (err) {
    // viem throws when the receipt is not found (tx still in mempool).
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("could not be found") || msg.includes("TransactionReceiptNotFoundError")) {
      return; // still in mempool — expected
    }
    console.warn(
      JSON.stringify({
        component: "sweeper",
        event: "receipt_error",
        tx: tx.transaction_hash,
        error: msg,
      }),
    );
    return;
  }

  if (!receipt) return; // still in mempool

  if (receipt.status === "reverted") {
    let revertReason: string | undefined = (receipt as unknown as { revertReason?: string })
      .revertReason;

    if (!revertReason) {
      try {
        const originalTx = await client.getTransaction({ hash: tx.transaction_hash });
        await client.call({
          to:          originalTx.to ?? undefined,
          data:        originalTx.input,
          value:       originalTx.value,
          gas:         originalTx.gas,
          blockNumber: receipt.blockNumber,
        });
      } catch (err) {
        const data = (err as { data?: string })?.data;
        if (data && data !== "0x") revertReason = data;
      }
    }

    console.warn(
      JSON.stringify({
        component: "sweeper",
        event: "revert_detected",
        tx: tx.transaction_hash,
        payment: tx.payment_id,
        revert_reason: revertReason,
      }),
    );

    try {
      await notifyApiFail(tx.transaction_hash, {
        chainId:      tx.chain_id,
        paymentId:    tx.payment_id,
        blockNumber:  Number(receipt.blockNumber),
        revertReason: revertReason,
      });
    } catch (err) {
      console.warn(
        JSON.stringify({
          component: "sweeper",
          event: "notify_fail_error",
          tx: tx.transaction_hash,
          error: String(err),
        }),
      );
    }

  } else if (receipt.status === "success") {
    const eventType = OPERATION_TO_EVENT_TYPE[tx.operation];
    if (!eventType) {
      console.warn(
        JSON.stringify({
          component: "sweeper",
          event: "unknown_operation",
          operation: tx.operation,
          tx: tx.transaction_hash,
        }),
      );
      return;
    }

    console.warn(
      JSON.stringify({
        component: "sweeper",
        event: "confirmed_not_indexed",
        tx: tx.transaction_hash,
        payment: tx.payment_id,
        event_type: eventType,
      }),
    );

    try {
      await notifyApi(tx.transaction_hash, {
        eventType:   eventType as "authorized" | "charged" | "captured" | "voided" | "released" | "refunded",
        chainId:     tx.chain_id,
        paymentId:   tx.payment_id,
        blockNumber: Number(receipt.blockNumber),
      });
    } catch (err) {
      console.warn(
        JSON.stringify({
          component: "sweeper",
          event: "notify_confirm_error",
          tx: tx.transaction_hash,
          error: String(err),
        }),
      );
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startSweeper(): void {
  const run = () => sweep().catch((err) => console.error("[sweeper] Unexpected error:", err));

  void run();
  setInterval(run, config.sweepIntervalSecs * 1000);
  console.log(`[sweeper] Started — interval ${config.sweepIntervalSecs}s`);
}
