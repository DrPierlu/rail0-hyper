/**
 * EventHandlers.ts
 *
 * Envio event handlers for all RAIL0 contract events.
 * Mirrors the logic of rail0-indexer/src/RAIL0.ts (Ponder) — same DB schema,
 * same rail0-api notifications, same api_sync_failures fallback.
 *
 * Key differences from the Ponder version:
 *   - Handler registration: RAIL0.PaymentAuthorized.handler() instead of ponder.on()
 *   - Event args: event.params instead of event.args
 *   - Payment tuple: positional array [payer, payee, token, amount, authExpiry, refundExpiry, feeBps, feeReceiver]
 *   - Chain ID: event.chainId
 *   - Block: event.block.number (number, not bigint), event.block.timestamp (number)
 *   - Transaction: event.transaction.nonce is bigint (converted to number for storage)
 *   - DB: context.Payment.set() / context.Payment.get() — synchronous set, async get
 */

import { RAIL0 } from "generated";
import type { handlerContext } from "../generated/src/Types.gen";
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

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Calls notifyApi with retry; on exhaustion logs and writes to ApiSyncFailure.
 */
async function notifyAndRecord(
  context: handlerContext,
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

RAIL0.PaymentAuthorized.handler(async ({ event, context }) => {
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

  // p is [payer, payee, token, amount, authorizationExpiry, refundExpiry, feeBps, feeReceiver]
  context.Payment.set({
    id,
    paymentId,
    chainId,
    payer: p[0],
    payee: p[1],
    token: p[2],
    amount: p[3],
    authorizationExpiry: p[4],
    refundExpiry: p[5],
    feeBps: Number(p[6]),
    feeReceiver: p[7],
    status: "authorized",
    capturableAmount: p[3],
    refundableAmount: 0n,
    txHash: event.transaction.hash,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: event.block.timestamp,
  });

  context.PaymentEvent.set({
    id: evId,
    paymentId: id,
    chainId,
    eventType: "authorized",
    amount: undefined,
    txHash: event.transaction.hash,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: event.block.timestamp,
    txFrom: event.transaction.from ?? "",
    txNonce: Number(event.transaction.nonce),
    gasLimit: event.transaction.gas,
    gasUsed: event.transaction.gasUsed,
    effectiveGasPrice: event.transaction.effectiveGasPrice,
    baseFeePerGas: event.block.baseFeePerGas,
  });

  await notifyAndRecord(
    context,
    evId,
    id,
    {
      eventType: "authorized",
      chainId,
      paymentId: paymentId as `0x${string}`,
      blockNumber: event.block.number,
    },
    event.transaction.hash,
    event.block.timestamp,
  );
});

// ── PaymentCharged ────────────────────────────────────────────────────────────

RAIL0.PaymentCharged.handler(async ({ event, context }) => {
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
    payer: p[0],
    payee: p[1],
    token: p[2],
    amount: p[3],
    authorizationExpiry: p[4],
    refundExpiry: p[5],
    feeBps: Number(p[6]),
    feeReceiver: p[7],
    status: "charged",
    capturableAmount: 0n,
    refundableAmount: p[3],
    txHash: event.transaction.hash,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: event.block.timestamp,
  });

  context.PaymentEvent.set({
    id: evId,
    paymentId: id,
    chainId,
    eventType: "charged",
    amount: undefined,
    txHash: event.transaction.hash,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: event.block.timestamp,
    txFrom: event.transaction.from ?? "",
    txNonce: Number(event.transaction.nonce),
    gasLimit: event.transaction.gas,
    gasUsed: event.transaction.gasUsed,
    effectiveGasPrice: event.transaction.effectiveGasPrice,
    baseFeePerGas: event.block.baseFeePerGas,
  });

  await notifyAndRecord(
    context,
    evId,
    id,
    {
      eventType: "charged",
      chainId,
      paymentId: paymentId as `0x${string}`,
      blockNumber: event.block.number,
    },
    event.transaction.hash,
    event.block.timestamp,
  );
});

// ── PaymentCaptured ───────────────────────────────────────────────────────────

RAIL0.PaymentCaptured.handler(async ({ event, context }) => {
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
    blockTimestamp: event.block.timestamp,
    txFrom: event.transaction.from ?? "",
    txNonce: Number(event.transaction.nonce),
    gasLimit: event.transaction.gas,
    gasUsed: event.transaction.gasUsed,
    effectiveGasPrice: event.transaction.effectiveGasPrice,
    baseFeePerGas: event.block.baseFeePerGas,
  });

  await notifyAndRecord(
    context,
    evId,
    id,
    {
      eventType: "captured",
      chainId,
      paymentId: paymentId as `0x${string}`,
      blockNumber: event.block.number,
      amount: amount.toString(),
    },
    event.transaction.hash,
    event.block.timestamp,
  );
});

// ── PaymentVoided ─────────────────────────────────────────────────────────────

RAIL0.PaymentVoided.handler(async ({ event, context }) => {
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
    blockTimestamp: event.block.timestamp,
    txFrom: event.transaction.from ?? "",
    txNonce: Number(event.transaction.nonce),
    gasLimit: event.transaction.gas,
    gasUsed: event.transaction.gasUsed,
    effectiveGasPrice: event.transaction.effectiveGasPrice,
    baseFeePerGas: event.block.baseFeePerGas,
  });

  await notifyAndRecord(
    context,
    evId,
    id,
    {
      eventType: "voided",
      chainId,
      paymentId: paymentId as `0x${string}`,
      blockNumber: event.block.number,
      amount: amount.toString(),
    },
    event.transaction.hash,
    event.block.timestamp,
  );
});

// ── PaymentReleased ───────────────────────────────────────────────────────────

RAIL0.PaymentReleased.handler(async ({ event, context }) => {
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
    blockTimestamp: event.block.timestamp,
    txFrom: event.transaction.from ?? "",
    txNonce: Number(event.transaction.nonce),
    gasLimit: event.transaction.gas,
    gasUsed: event.transaction.gasUsed,
    effectiveGasPrice: event.transaction.effectiveGasPrice,
    baseFeePerGas: event.block.baseFeePerGas,
  });

  await notifyAndRecord(
    context,
    evId,
    id,
    {
      eventType: "released",
      chainId,
      paymentId: paymentId as `0x${string}`,
      blockNumber: event.block.number,
      amount: amount.toString(),
    },
    event.transaction.hash,
    event.block.timestamp,
  );
});

// ── PaymentRefunded ───────────────────────────────────────────────────────────

RAIL0.PaymentRefunded.handler(async ({ event, context }) => {
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
    blockTimestamp: event.block.timestamp,
    txFrom: event.transaction.from ?? "",
    txNonce: Number(event.transaction.nonce),
    gasLimit: event.transaction.gas,
    gasUsed: event.transaction.gasUsed,
    effectiveGasPrice: event.transaction.effectiveGasPrice,
    baseFeePerGas: event.block.baseFeePerGas,
  });

  await notifyAndRecord(
    context,
    evId,
    id,
    {
      eventType: "refunded",
      chainId,
      paymentId: paymentId as `0x${string}`,
      blockNumber: event.block.number,
      amount: amount.toString(),
    },
    event.transaction.hash,
    event.block.timestamp,
  );
});
