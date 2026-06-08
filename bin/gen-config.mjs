#!/usr/bin/env node
/**
 * bin/gen-config.mjs
 *
 * Patches the start_block values in the environment's config file using live
 * data from rail0-api. All other content (chain IDs, RPC URLs, contract
 * addresses, events) is left unchanged — those are maintained statically.
 *
 * Config files (committed to git, one per environment):
 *   config.yaml         → development
 *   config.staging.yaml → staging
 *   config.production.yaml → production (add when ready)
 *
 * Usage:
 *   node bin/gen-config              # patches config.yaml (development)
 *   NODE_ENV=staging node bin/gen-config  # patches config.staging.yaml
 *
 * Falls back to the existing start_block values if rail0-api is unreachable.
 *
 * Environment variables:
 *   NODE_ENV               — selects which config file to patch (default: development)
 *   RAIL0_API_URL          — base URL of rail0-api
 *   RAIL0_API_HMAC_SECRET  — 32-byte hex shared secret
 */

import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

const env = process.env.NODE_ENV ?? "development";
const configFile =
  env === "staging" ? "config.staging.yaml" :
  env === "production" ? "config.production.yaml" :
  "config.yaml";

const CONFIG_PATH = join(__dirname, "../", configFile);

// ── Fetch start blocks from rail0-api ─────────────────────────────────────────

async function fetchStartBlocks() {
  const baseUrl = process.env.RAIL0_API_URL;
  const secret = process.env.RAIL0_API_HMAC_SECRET;

  if (!baseUrl || !secret) {
    console.warn(
      "[gen-config] RAIL0_API_URL or RAIL0_API_HMAC_SECRET not set — keeping existing start_block values",
    );
    return {};
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret).update(`${timestamp}.`).digest("hex");

  try {
    const res = await fetch(`${baseUrl}/sync/blockchains`, {
      headers: {
        "X-Rail0-Timestamp": timestamp,
        "X-Rail0-Signature": signature,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(
        `[gen-config] GET /sync/blockchains returned ${res.status} — keeping existing start_block values`,
      );
      return {};
    }

    const data = await res.json();
    const map = {};
    for (const entry of Array.isArray(data) ? data : (data.blockchains ?? [])) {
      map[entry.chain_id] = entry.start_block ?? 0;
    }
    console.log(`[gen-config] Fetched start blocks: ${JSON.stringify(map)}`);
    return map;
  } catch (err) {
    console.warn("[gen-config] Failed to fetch start blocks:", err.message ?? err);
    return {};
  }
}

// ── Patch start_block values ──────────────────────────────────────────────────

const raw = readFileSync(CONFIG_PATH, "utf-8");
const parsed = loadYaml(raw);
const networks = parsed?.networks ?? [];

const startBlocks = await fetchStartBlocks();

let patched = raw;
for (const network of networks) {
  if (!(network.id in startBlocks)) continue;
  patched = patched.replace(
    new RegExp(`(- id: ${network.id}[\\s\\S]*?start_block: )\\d+`),
    `$1${startBlocks[network.id]}`,
  );
}

writeFileSync(CONFIG_PATH, patched, "utf-8");
console.log(`[gen-config] ${configFile} updated (env: ${env})`);
