/**
 * sweeper.ts
 *
 * Detects on-chain reverts and unindexed confirmations for transactions that
 * were broadcast but not yet confirmed by Ponder.
 *
 * Every SWEEP_INTERVAL_SECS seconds:
 *   1. GET /sync/transactions  — fetch stale submitted txs from rail0-api
 *   2. For each tx, call eth_getTransactionReceipt on its chain
 *   3a. receipt null           → still in mempool, skip
 *   3b. receipt reverted       → POST /sync/transactions { operation: "fail" }
 *   3c. receipt success        → POST /sync/transactions { operation: "confirm" }
 *        (safety net: Ponder should have handled these, but may be temporarily down)
 *
 * The operation field returned by GET /sync/transactions maps to the event_type
 * for the confirm path (authorize → authorized, charge → charged, etc.).
 *
 * Authenticated with the same HMAC-SHA256 used by the rest of the indexer.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { http, createPublicClient } from "viem";
import { config } from "./config";

// ── Chain config from config.yaml ────────────────────────────────────────────

type EnvioConfig = {
  networks: { id: number; rpc: string }[];
};

const envioConfig = loadYaml(
  readFileSync(join(__dirname, "../config.yaml"), "utf-8"),
) as EnvioConfig;

// ── Types ─────────────────────────────────────────────────────────────────────

type StaleTx = {
  transaction_hash: `0x${string}`;
  payment_id: `0x${string}`;
  chain_id: number;
  /** One of: authorize | charge | capture | void | release | refund */
  operation: string;
};

type SyncTransactionsResponse = {
  transactions: StaleTx[];
};

// Maps rail0-api "operation" (verb) to the event_type expected by POST /sync/transactions.
const OPERATION_TO_EVENT_TYPE: Record<string, string> = {
  authorize: "authorized",
  charge: "charged",
  capture: "captured",
  void: "voided",
  release: "released",
  refund: "refunded",
};

// ── HMAC helper ───────────────────────────────────────────────────────────────

function makeHmacHeaders(secret: string, body: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return {
    "Content-Type": "application/json",
    "X-Rail0-Timestamp": timestamp,
    "X-Rail0-Signature": signature,
  };
}

// For GET requests the body is empty but we still sign an empty string.
function makeHmacGetHeaders(secret: string) {
  return makeHmacHeaders(secret, "");
}

// ── viem clients per chain ────────────────────────────────────────────────────

const clients = new Map(
  envioConfig.networks.map((n) => [n.id, createPublicClient({ transport: http(n.rpc) })]),
);

// ── Core sweep logic ──────────────────────────────────────────────────────────

export async function sweep(): Promise<void> {
  const baseUrl = process.env.RAIL0_API_URL;
  const secret = process.env.RAIL0_API_HMAC_SECRET;

  if (!baseUrl || !secret) {
    console.warn("[sweeper] RAIL0_API_URL or RAIL0_API_HMAC_SECRET not set — skipping");
    return;
  }

  // 1. Fetch stale submitted transactions from rail0-api.
  let staleTxs: StaleTx[];
  try {
    const res = await fetch(`${baseUrl}/sync/transactions`, {
      headers: makeHmacGetHeaders(secret),
      signal: AbortSignal.timeout(config.apiTimeoutMs),
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

  // 2. Check each tx on-chain.
  await Promise.allSettled(staleTxs.map((tx) => checkTx(tx, baseUrl, secret)));
}

async function checkTx(tx: StaleTx, baseUrl: string, secret: string): Promise<void> {
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
          to: originalTx.to ?? undefined,
          data: originalTx.input,
          value: originalTx.value,
          gas: originalTx.gas,
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
    await postSync(baseUrl, secret, tx.chain_id, tx.transaction_hash, {
      operation: "fail",
      payment_id: tx.payment_id,
      block_number: Number(receipt.blockNumber),
      revert_reason: revertReason,
    });
  } else if (receipt.status === "success") {
    const event_type = OPERATION_TO_EVENT_TYPE[tx.operation];
    if (!event_type) {
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
        event_type,
      }),
    );
    await postSync(baseUrl, secret, tx.chain_id, tx.transaction_hash, {
      operation: "confirm",
      payment_id: tx.payment_id,
      event_type,
      block_number: Number(receipt.blockNumber),
    });
  }
}

async function postSync(
  baseUrl: string,
  secret: string,
  chainId: number,
  txHash: `0x${string}`,
  body: Record<string, unknown>,
): Promise<void> {
  const path = `/chains/${chainId}/transactions/${txHash}`;
  const bodyStr = JSON.stringify(body);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: makeHmacHeaders(secret, bodyStr),
      body: bodyStr,
      signal: AbortSignal.timeout(config.apiTimeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        JSON.stringify({
          component: "sweeper",
          event: "post_sync_failed",
          status: res.status,
          body: text,
        }),
      );
    }
  } catch (err) {
    console.warn(
      JSON.stringify({ component: "sweeper", event: "post_sync_error", error: String(err) }),
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startSweeper(): void {
  const run = () => sweep().catch((err) => console.error("[sweeper] Unexpected error:", err));

  void run();
  setInterval(run, config.sweepIntervalSecs * 1000);
  console.log(`[sweeper] Started — interval ${config.sweepIntervalSecs}s`);
}
