/**
 * Application configuration — non-secret parameters.
 *
 * Secrets stay in .env and are never defined here:
 *   ENVIO_PG_*            — PostgreSQL connection (shared with Envio)
 *   RAIL0_API_URL         — Base URL of rail0-api (e.g. https://api.rail0.io)
 *   RAIL0_API_HMAC_SECRET — 32-byte hex shared secret for HMAC request signing
 */

export const config = {
  // How many times a rail0-api notification is attempted before the event is
  // written to api_sync_failures for later reconciliation. Minimum effective value: 1.
  apiMaxAttempts: 3,

  // Starting delay (ms) for the exponential backoff between retry attempts.
  // Actual delays: apiBaseDelayMs × 2^(attempt−1) → 100ms, 200ms, 400ms
  apiBaseDelayMs: 100,

  // Request timeout for each notifyApi call (ms).
  // Gives rail0-api time to wake from a cold start before we give up.
  apiTimeoutMs: 10_000,

  // How often the background reconciler scans api_sync_failures for unresolved
  // entries and re-attempts the notification (seconds).
  // Set to 0 to disable automatic scheduling — reconciliation then happens
  // only on explicit POST /reconcile calls.
  reconcileIntervalSecs: 5 * 60,

  // Maximum rows the reconciler processes in a single tick. Caps the run time
  // when the failure queue is large; remaining rows are picked up next tick.
  reconcileBatchSize: 100,

  // How often the sweeper polls rail0-api for stale submitted transactions and
  // checks their on-chain receipt (seconds).
  sweepIntervalSecs: 30,

  // Port for the standalone Hono API server.
  apiPort: Number(process.env.API_PORT ?? 3001),
} as const;
