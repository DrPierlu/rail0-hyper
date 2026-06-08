/**
 * EventHandlers.ts
 *
 * Envio event handlers for all RAIL0 contract events.
 * Mirrors the logic of rail0-indexer/src/RAIL0.ts (Ponder) — same DB schema,
 * same rail0-api notifications, same api_sync_failures fallback.
 *
 * Key differences from the Ponder version:
 *   - Handler registration: indexer.onEvent() instead of ponder.on()
 *   - Event args: event.params instead of event.args
 *   - Block: event.block (same shape)
 *   - Transaction: event.transaction (gas fields from field_selection in config.yaml)
 *   - Chain ID: event.chainId (number)
 *   - Log index: event.logIndex
 *   - DB: context.Payment.set() / context.Payment.get() instead of context.db.insert()
 *   - No built-in onConflictDoUpdate — do a get() + set() manually
 */

import { indexer } from "generated";
import { type ApiNotifyPayload, notifyApi } from "./api-client";
import { config } from "./config";
import { isApiPaymentId, withRetry } from "./utils";

// ── ID helpers ────────────────────────────────────────────────────────────────

function pid(chainId: number, paymentId: string) {
  return `${chainId}_${paymentId}`;
}

function eid(chainId: number, txHash: string, logIndex: number) {
  return `${chainId}_${txHash}_${logIndex}`;
}

// ── Context type ─────────────────────────────────────────────────────────────
// Extracted from the handler callback type so helpers can accept it without
// repeating the inline generic.

type HandlerContext = Parameters<
  Parameters<typeof indexer.onEvent>[1]
>[0]["context"];

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Calls notifyApi with retry; on exhaustion logs and writes to ApiSyncFailure.
 * Identical across all handlers; only the ApiNotifyPayload varies.
 */
async function notifyAndRecord(
  context: HandlerContext,
  evId: string,
  id: string,
  payload: ApiNotifyPayload,
  txHash: string,
  blockTimestamp: number,
) {
  const apiResult = await withRetry(async () => {
    await notifyApi(txHash as `0x${string}`, payload);
  });

  if (!apiResult.ok) {
    console.log(
      JSON.stringify({
        component: "indexer",
        event: "notify_api_failed",
        txHash,
        error: apiResult.error,
      }),
    );
    context.ApiSyncFailure.set({
      id: evId,
      eventType: payload.eventType,
      paymentId: id,
      payload: JSON.stringify({ txHash, ...payload }),
      attempts: config.apiMaxAttempts,
      lastError: apiResult.error,
      createdAt: blockTimestamp,
      resolvedAt: undefined,
    });
  }
}

// ── PaymentAuthorized ─────────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "RAIL0", event: "PaymentAuthorized" },
  async ({ event, context }) => {
    const { paymentId, payment: p } = event.params;
    const chainId = event.chainId;

    if (!isApiPaymentId(paymentId as `0x${string}`)) {
      console.log(
        JSON.stringify({
          component: "indexer",
          event: "payment_id_skipped",
          reason: "out_of_scope",
          paymentId,
          chainId,
          txHash: event.transaction.hash,
          blockNumber: event.block.number,
        }),
      );
      return;
    }

    const id = pid(chainId, paymentId);
    const evId = eid(chainId, event.transaction.hash, event.logIndex);

    context.Payment.set({
      id,
      paymentId,
      chainId,
      payer: p.payer,
      payee: p.payee,
      token: p.token,
      amount: p.amount,
      authorizationExpiry: BigInt(p.authorizationExpiry),
      refundExpiry: BigInt(p.refundExpiry),
      feeBps: Number(p.feeBps),
      feeReceiver: p.feeReceiver,
      status: "authorized",
      capturableAmount: p.amount,
      refundableAmount: 0n,
      txHash: event.transaction.hash,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: Number(event.block.timestamp),
    });

    context.PaymentEvent.set({
      id: evId,
      paymentId: id,
      chainId,
      eventType: "authorized",
      amount: undefined,
      txHash: event.transaction.hash,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: Number(event.block.timestamp),
      txFrom: event.transaction.from,
      txNonce: event.transaction.nonce,
      gasLimit: event.transaction.gas,
      gasUsed: event.transaction.gasUsed,
      effectiveGasPrice: event.transaction.effectiveGasPrice,
      baseFeePerGas: event.block.baseFeePerGas ?? undefined,
    });

    await notifyAndRecord(
      context,
      evId,
      id,
      { eventType: "authorized", chainId, paymentId: paymentId as `0x${string}`, blockNumber: Number(event.block.number) },
      event.transaction.hash,
      Number(event.block.timestamp),
    );
  },
);

// ── PaymentCharged ────────────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "RAIL0", event: "PaymentCharged" },
  async ({ event, context }) => {
    const { paymentId, payment: p } = event.params;
    const chainId = event.chainId;

    if (!isApiPaymentId(paymentId as `0x${string}`)) {
      console.log(
        JSON.stringify({
          component: "indexer",
          event: "payment_id_skipped",
          reason: "out_of_scope",
          paymentId,
          chainId,
          txHash: event.transaction.hash,
          blockNumber: event.block.number,
        }),
      );
      return;
    }

    const id = pid(chainId, paymentId);
    const evId = eid(chainId, event.transaction.hash, event.logIndex);

    context.Payment.set({
      id,
      paymentId,
      chainId,
      payer: p.payer,
      payee: p.payee,
      token: p.token,
      amount: p.amount,
      authorizationExpiry: BigInt(p.authorizationExpiry),
      refundExpiry: BigInt(p.refundExpiry),
      feeBps: Number(p.feeBps),
      feeReceiver: p.feeReceiver,
      status: "charged",
      capturableAmount: 0n,
      refundableAmount: p.amount,
      txHash: event.transaction.hash,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: Number(event.block.timestamp),
    });

    context.PaymentEvent.set({
      id: evId,
      paymentId: id,
      chainId,
      eventType: "charged",
      amount: undefined,
      txHash: event.transaction.hash,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: Number(event.block.timestamp),
      txFrom: event.transaction.from,
      txNonce: event.transaction.nonce,
      gasLimit: event.transaction.gas,
      gasUsed: event.transaction.gasUsed,
      effectiveGasPrice: event.transaction.effectiveGasPrice,
      baseFeePerGas: event.block.baseFeePerGas ?? undefined,
    });

    await notifyAndRecord(
      context,
      evId,
      id,
      { eventType: "charged", chainId, paymentId: paymentId as `0x${string}`, blockNumber: Number(event.block.number) },
      event.transaction.hash,
      Number(event.block.timestamp),
    );
  },
);

// ── PaymentCaptured ───────────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "RAIL0", event: "PaymentCaptured" },
  async ({ event, context }) => {
    const { paymentId, amount } = event.params;
    const chainId = event.chainId;

    if (!isApiPaymentId(paymentId as `0x${string}`)) {
      console.log(
        JSON.stringify({
          component: "indexer",
          event: "payment_id_skipped",
          reason: "out_of_scope",
          paymentId,
          chainId,
          txHash: event.transaction.hash,
          blockNumber: event.block.number,
        }),
      );
      return;
    }

    const id = pid(chainId, paymentId);
    const evId = eid(chainId, event.transaction.hash, event.logIndex);

    // Read current state to compute partial capture amounts correctly.
    const existing = await context.Payment.get(id);
    const prevCapturable = existing?.capturableAmount ?? 0n;
    const prevRefundable = existing?.refundableAmount ?? 0n;
    const newCapturable = prevCapturable - amount;

    context.Payment.set({
      // Carry over all fields from existing (or use safe defaults for orphan events)
      id,
      paymentId,
      chainId,
      payer: existing?.payer,
      payee: existing?.payee,
      token: existing?.token,
      amount: existing?.amount,
      feeBps: existing?.feeBps,
      feeReceiver: existing?.feeReceiver,
      authorizationExpiry: existing?.authorizationExpiry,
      refundExpiry: existing?.refundExpiry,
      txHash: existing?.txHash,
      blockNumber: existing?.blockNumber,
      blockTimestamp: existing?.blockTimestamp,
      // Mutable fields
      status: newCapturable === 0n ? "captured" : "partially_captured",
      capturableAmount: newCapturable,
      refundableAmount: prevRefundable + amount,
    });

    context.PaymentEvent.set({
      id: evId,
      paymentId: id,
      chainId,
      eventType: "captured",
      amount,
      txHash: event.transaction.hash,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: Number(event.block.timestamp),
      txFrom: event.transaction.from,
      txNonce: event.transaction.nonce,
      gasLimit: event.transaction.gas,
      gasUsed: event.transaction.gasUsed,
      effectiveGasPrice: event.transaction.effectiveGasPrice,
      baseFeePerGas: event.block.baseFeePerGas ?? undefined,
    });

    await notifyAndRecord(
      context,
      evId,
      id,
      { eventType: "captured", chainId, paymentId: paymentId as `0x${string}`, blockNumber: Number(event.block.number), amount: amount.toString() },
      event.transaction.hash,
      Number(event.block.timestamp),
    );
  },
);

// ── PaymentVoided ─────────────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "RAIL0", event: "PaymentVoided" },
  async ({ event, context }) => {
    const { paymentId, amount } = event.params;
    const chainId = event.chainId;

    if (!isApiPaymentId(paymentId as `0x${string}`)) {
      console.log(
        JSON.stringify({
          component: "indexer",
          event: "payment_id_skipped",
          reason: "out_of_scope",
          paymentId,
          chainId,
          txHash: event.transaction.hash,
          blockNumber: event.block.number,
        }),
      );
      return;
    }

    const id = pid(chainId, paymentId);
    const evId = eid(chainId, event.transaction.hash, event.logIndex);

    const existing = await context.Payment.get(id);

    context.Payment.set({
      id,
      paymentId,
      chainId,
      payer: existing?.payer,
      payee: existing?.payee,
      token: existing?.token,
      amount: existing?.amount,
      feeBps: existing?.feeBps,
      feeReceiver: existing?.feeReceiver,
      authorizationExpiry: existing?.authorizationExpiry,
      refundExpiry: existing?.refundExpiry,
      txHash: existing?.txHash,
      blockNumber: existing?.blockNumber,
      blockTimestamp: existing?.blockTimestamp,
      status: "voided",
      capturableAmount: 0n,
      refundableAmount: existing?.refundableAmount ?? 0n,
    });

    context.PaymentEvent.set({
      id: evId,
      paymentId: id,
      chainId,
      eventType: "voided",
      amount,
      txHash: event.transaction.hash,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: Number(event.block.timestamp),
      txFrom: event.transaction.from,
      txNonce: event.transaction.nonce,
      gasLimit: event.transaction.gas,
      gasUsed: event.transaction.gasUsed,
      effectiveGasPrice: event.transaction.effectiveGasPrice,
      baseFeePerGas: event.block.baseFeePerGas ?? undefined,
    });

    await notifyAndRecord(
      context,
      evId,
      id,
      { eventType: "voided", chainId, paymentId: paymentId as `0x${string}`, blockNumber: Number(event.block.number), amount: amount.toString() },
      event.transaction.hash,
      Number(event.block.timestamp),
    );
  },
);

// ── PaymentReleased ───────────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "RAIL0", event: "PaymentReleased" },
  async ({ event, context }) => {
    const { paymentId, amount } = event.params;
    const chainId = event.chainId;

    if (!isApiPaymentId(paymentId as `0x${string}`)) {
      console.log(
        JSON.stringify({
          component: "indexer",
          event: "payment_id_skipped",
          reason: "out_of_scope",
          paymentId,
          chainId,
          txHash: event.transaction.hash,
          blockNumber: event.block.number,
        }),
      );
      return;
    }

    const id = pid(chainId, paymentId);
    const evId = eid(chainId, event.transaction.hash, event.logIndex);

    const existing = await context.Payment.get(id);

    context.Payment.set({
      id,
      paymentId,
      chainId,
      payer: existing?.payer,
      payee: existing?.payee,
      token: existing?.token,
      amount: existing?.amount,
      feeBps: existing?.feeBps,
      feeReceiver: existing?.feeReceiver,
      authorizationExpiry: existing?.authorizationExpiry,
      refundExpiry: existing?.refundExpiry,
      txHash: existing?.txHash,
      blockNumber: existing?.blockNumber,
      blockTimestamp: existing?.blockTimestamp,
      status: "released",
      capturableAmount: 0n,
      refundableAmount: existing?.refundableAmount ?? 0n,
    });

    context.PaymentEvent.set({
      id: evId,
      paymentId: id,
      chainId,
      eventType: "released",
      amount,
      txHash: event.transaction.hash,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: Number(event.block.timestamp),
      txFrom: event.transaction.from,
      txNonce: event.transaction.nonce,
      gasLimit: event.transaction.gas,
      gasUsed: event.transaction.gasUsed,
      effectiveGasPrice: event.transaction.effectiveGasPrice,
      baseFeePerGas: event.block.baseFeePerGas ?? undefined,
    });

    await notifyAndRecord(
      context,
      evId,
      id,
      { eventType: "released", chainId, paymentId: paymentId as `0x${string}`, blockNumber: Number(event.block.number), amount: amount.toString() },
      event.transaction.hash,
      Number(event.block.timestamp),
    );
  },
);

// ── PaymentRefunded ───────────────────────────────────────────────────────────

indexer.onEvent(
  { contract: "RAIL0", event: "PaymentRefunded" },
  async ({ event, context }) => {
    const { paymentId, amount } = event.params;
    const chainId = event.chainId;

    if (!isApiPaymentId(paymentId as `0x${string}`)) {
      console.log(
        JSON.stringify({
          component: "indexer",
          event: "payment_id_skipped",
          reason: "out_of_scope",
          paymentId,
          chainId,
          txHash: event.transaction.hash,
          blockNumber: event.block.number,
        }),
      );
      return;
    }

    const id = pid(chainId, paymentId);
    const evId = eid(chainId, event.transaction.hash, event.logIndex);

    const existing = await context.Payment.get(id);
    const prevRefundable = existing?.refundableAmount ?? 0n;
    const newRefundable = prevRefundable - amount;

    context.Payment.set({
      id,
      paymentId,
      chainId,
      payer: existing?.payer,
      payee: existing?.payee,
      token: existing?.token,
      amount: existing?.amount,
      feeBps: existing?.feeBps,
      feeReceiver: existing?.feeReceiver,
      authorizationExpiry: existing?.authorizationExpiry,
      refundExpiry: existing?.refundExpiry,
      txHash: existing?.txHash,
      blockNumber: existing?.blockNumber,
      blockTimestamp: existing?.blockTimestamp,
      capturableAmount: existing?.capturableAmount ?? 0n,
      status: newRefundable === 0n ? "refunded" : "partially_refunded",
      refundableAmount: newRefundable,
    });

    context.PaymentEvent.set({
      id: evId,
      paymentId: id,
      chainId,
      eventType: "refunded",
      amount,
      txHash: event.transaction.hash,
      blockNumber: BigInt(event.block.number),
      blockTimestamp: Number(event.block.timestamp),
      txFrom: event.transaction.from,
      txNonce: event.transaction.nonce,
      gasLimit: event.transaction.gas,
      gasUsed: event.transaction.gasUsed,
      effectiveGasPrice: event.transaction.effectiveGasPrice,
      baseFeePerGas: event.block.baseFeePerGas ?? undefined,
    });

    await notifyAndRecord(
      context,
      evId,
      id,
      { eventType: "refunded", chainId, paymentId: paymentId as `0x${string}`, blockNumber: Number(event.block.number), amount: amount.toString() },
      event.transaction.hash,
      Number(event.block.timestamp),
    );
  },
);
