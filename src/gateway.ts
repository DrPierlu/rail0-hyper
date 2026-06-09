/**
 * gateway.ts
 *
 * HTTP client for the rail0-api transaction-confirmation endpoint.
 *
 * Instead of connecting directly to the API database, rail0-indexer notifies
 * rail0-api via a single authenticated HTTP endpoint.  This keeps the API DB
 * credentials inside rail0-api and eliminates the need for a shared connection
 * string.
 *
 * Authentication — HMAC-SHA256 with a shared secret:
 *
 *   signed_payload = `${timestamp}.${JSON.stringify(body)}`
 *   signature      = HMAC-SHA256(key: RAIL0_API_HMAC_SECRET, data: signed_payload)
 *
 * Request headers:
 *   X-Rail0-Timestamp  — Unix timestamp in seconds (string)
 *   X-Rail0-Signature  — hex-encoded HMAC digest
 *
 * rail0-api verifies the signature and rejects requests older than a configurable
 * replay window (default: 5 minutes).
 *
 * Environment variables (not needed at import time — resolved on first call):
 *   RAIL0_API_URL          — base URL, e.g. https://api.rail0.xyz
 *   RAIL0_API_HMAC_SECRET  — 32-byte (64 hex char) shared secret
 */

import { config } from "./config";
import { hmacHeaders } from "./hmac";

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Thrown when rail0-api responds with a non-2xx status.
 * Distinct from network/timeout errors so callers can skip retries.
 */
export class ApiResponseError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiResponseError";
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ApiNotifyPayload = {
  eventType: "authorized" | "charged" | "captured" | "voided" | "released" | "refunded";
  chainId: number;
  paymentId: `0x${string}`;
  blockNumber: number;
  amount?: string;
};

export type ApiFailPayload = {
  chainId: number;
  paymentId: `0x${string}`;
  blockNumber: number;
  revertReason?: string;
};

// ── Request builder ───────────────────────────────────────────────────────────

function signedRequest(secret: string, path: string, body: string) {
  return {
    url: `${process.env.RAIL0_API_URL}${path}`,
    headers: hmacHeaders(secret, body),
  };
}

function requireEnv(): { baseUrl: string; secret: string } {
  const baseUrl = process.env.RAIL0_API_URL;
  const secret = process.env.RAIL0_API_HMAC_SECRET;
  if (!baseUrl || !secret) {
    throw new Error("RAIL0_API_URL and RAIL0_API_HMAC_SECRET must be set.");
  }
  return { baseUrl, secret };
}

// ── POST /chains/:chain_id/transactions/:tx_hash (confirm) ───────────────────

export async function notifyApi(txHash: `0x${string}`, payload: ApiNotifyPayload): Promise<void> {
  const { secret } = requireEnv();
  const body = JSON.stringify({
    operation: "confirm",
    payment_id: payload.paymentId,
    event_type: payload.eventType,
    block_number: payload.blockNumber,
    amount: payload.amount,
  });
  const path = `/sync/chains/${payload.chainId}/transactions/${txHash}`;
  const { url, headers } = signedRequest(secret, path, body);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(config.apiTimeoutMs),
    });
  } catch (err) {
    console.warn(
      JSON.stringify({ component: "gateway", event: "api_unavailable", path, error: String(err) }),
    );
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiResponseError(
      res.status,
      `rail0-api POST ${path} responded ${res.status}: ${text}`,
    );
  }
}

// ── POST /chains/:chain_id/transactions/:tx_hash (fail) ──────────────────────

export async function notifyApiFail(txHash: `0x${string}`, payload: ApiFailPayload): Promise<void> {
  const { secret } = requireEnv();
  const body = JSON.stringify({
    operation: "fail",
    payment_id: payload.paymentId,
    block_number: payload.blockNumber,
    revert_reason: payload.revertReason,
  });
  const path = `/sync/chains/${payload.chainId}/transactions/${txHash}`;
  const { url, headers } = signedRequest(secret, path, body);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(config.apiTimeoutMs),
    });
  } catch (err) {
    console.warn(
      JSON.stringify({ component: "gateway", event: "api_unavailable", path, error: String(err) }),
    );
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiResponseError(
      res.status,
      `rail0-api POST ${path} responded ${res.status}: ${text}`,
    );
  }
}
