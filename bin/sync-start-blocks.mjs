#!/usr/bin/env node
/**
 * bin/sync-start-blocks.mjs
 *
 * Patches the start_block values in the environment's config file.
 *
 * Fallback chain (per network):
 *   1. rail0-api GET /sync/blockchains  — authoritative, uses DB state
 *   2. RPC binary search                — finds the earliest deploy block
 *                                         among all contract addresses on that network
 *   3. 0                               — last resort
 *
 * Config files (committed to git, one per environment):
 *   config.yaml            → development
 *   config.staging.yaml    → staging
 *   config.production.yaml → production
 *
 * Usage:
 *   node bin/sync-start-blocks                       # patches config.yaml
 *   NODE_ENV=staging node bin/sync-start-blocks      # patches config.staging.yaml
 *   NODE_ENV=production node bin/sync-start-blocks   # patches config.production.yaml
 *
 * Environment variables:
 *   NODE_ENV               — selects which config file to patch (default: development)
 *   RAIL0_API_URL          — base URL of rail0-api (optional — skipped if absent)
 *   RAIL0_API_HMAC_SECRET  — 32-byte hex shared secret (optional — skipped if absent)
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

// ── Step 1: fetch start blocks from rail0-api ─────────────────────────────────

async function fetchStartBlocks() {
  const baseUrl = process.env.RAIL0_API_URL;
  const secret = process.env.RAIL0_API_HMAC_SECRET;

  if (!baseUrl || !secret) {
    console.log("[sync-start-blocks] RAIL0_API_URL/RAIL0_API_HMAC_SECRET not set — skipping API fetch");
    return { startBlocks: {}, explorerUrls: {} };
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
      console.warn(`[sync-start-blocks] GET /sync/blockchains → ${res.status}`);
      return { startBlocks: {}, explorerUrls: {} };
    }

    const data = await res.json();
    const entries = Array.isArray(data) ? data : (data.start_blocks ?? []);
    const startBlocks = {};
    const explorerUrls = {};
    for (const entry of entries) {
      startBlocks[entry.chain_id] = entry.start_block ?? 0;
      if (entry.explorer_url) explorerUrls[entry.chain_id] = entry.explorer_url;
    }
    console.log(`[sync-start-blocks] rail0-api start blocks: ${JSON.stringify(startBlocks)}`);
    return { startBlocks, explorerUrls };
  } catch (err) {
    console.warn(`[sync-start-blocks] rail0-api unreachable: ${err.message ?? err}`);
    return { startBlocks: {}, explorerUrls: {} };
  }
}

// ── Step 2: explorer API (Etherscan-compatible / Blockscout) ─────────────────

// Returns the earliest deploy block for all addresses via the explorer API.
// Returns null if the explorer is not configured or the request fails.
async function fetchDeployBlocksFromExplorer(explorerUrl, addresses) {
  if (!explorerUrl) return null;

  const joined = addresses.join(",");
  const url = `${explorerUrl}/api?module=contract&action=getcontractcreation&contractaddresses=${joined}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const json = await res.json();

    if (json.status !== "1" || !Array.isArray(json.result)) {
      console.warn(`[sync-start-blocks] explorer returned status=${json.status}: ${json.message}`);
      return null;
    }

    let earliest = Infinity;
    for (const entry of json.result) {
      const block = Number(entry.blockNumber);
      console.log(`[sync-start-blocks]   ${entry.contractAddress} → block ${block} (explorer)`);
      if (block < earliest) earliest = block;
    }
    return earliest === Infinity ? null : earliest;
  } catch (err) {
    console.warn(`[sync-start-blocks] explorer request failed: ${err.message}`);
    return null;
  }
}

// ── Step 3: binary search for deploy block via RPC ────────────────────────────

async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function getLatestBlock(rpcUrl) {
  const result = await rpcCall(rpcUrl, "eth_blockNumber", []);
  return BigInt(result);
}

// Returns the first block where `address` has non-empty bytecode.
async function findDeployBlock(rpcUrl, address, latestBlock) {
  let lo = 0n;
  let hi = latestBlock;

  // Quick check: is the contract deployed at all?
  const codeAtLatest = await rpcCall(rpcUrl, "eth_getCode", [address, "latest"]);
  if (!codeAtLatest || codeAtLatest === "0x") {
    throw new Error(`No bytecode found for ${address} — not deployed on this network`);
  }

  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const code = await rpcCall(rpcUrl, "eth_getCode", [address, "0x" + mid.toString(16)]);
    if (code && code !== "0x") hi = mid;
    else lo = mid + 1n;
  }

  return lo;
}

// Returns the earliest deploy block among all addresses on a network.
// Fallback chain: explorer API → RPC binary search → 0.
async function findNetworkStartBlock(network, explorerUrl) {
  const addresses = (network.contracts ?? []).flatMap((c) => {
    const addr = c.address;
    if (!addr) return [];
    return Array.isArray(addr) ? addr : [addr];
  });

  if (addresses.length === 0) {
    console.warn(`[sync-start-blocks] network ${network.id}: no contract addresses — using 0`);
    return 0;
  }

  // 1. Try explorer API (URL comes from rail0-api DB)
  if (explorerUrl) {
    console.log(`[sync-start-blocks] network ${network.id}: querying explorer…`);
    const block = await fetchDeployBlocksFromExplorer(explorerUrl, addresses);
    if (block !== null) return block;
    console.warn(`[sync-start-blocks] network ${network.id}: explorer failed — falling back to RPC binary search`);
  }

  // 2. RPC binary search
  const rpcUrl = network.rpc;
  if (!rpcUrl) {
    console.warn(`[sync-start-blocks] network ${network.id}: no rpc URL — using 0`);
    return 0;
  }

  let latestBlock;
  try {
    latestBlock = await getLatestBlock(rpcUrl);
  } catch (err) {
    console.warn(`[sync-start-blocks] network ${network.id}: eth_blockNumber failed (${err.message}) — using 0`);
    return 0;
  }

  console.log(`[sync-start-blocks] network ${network.id}: latest block ${latestBlock}, binary searching ${addresses.length} address(es)…`);

  let earliest = latestBlock;
  for (const address of addresses) {
    try {
      const deployBlock = await findDeployBlock(rpcUrl, address, latestBlock);
      console.log(`[sync-start-blocks]   ${address} → block ${deployBlock} (binary search)`);
      if (deployBlock < earliest) earliest = deployBlock;
    } catch (err) {
      console.warn(`[sync-start-blocks]   ${address} → error: ${err.message}`);
    }
  }

  if (earliest === latestBlock) {
    console.warn(`[sync-start-blocks] network ${network.id}: could not determine deploy block — using 0`);
    return 0;
  }

  return Number(earliest);
}

// ── Patch ─────────────────────────────────────────────────────────────────────

const raw = readFileSync(CONFIG_PATH, "utf-8");
const parsed = loadYaml(raw);
const networks = parsed?.networks ?? [];

const { startBlocks: apiStartBlocks, explorerUrls } = await fetchStartBlocks();

// Resolve start block + source label for each network.
const resolved = {}; // chain_id → { block, source }
for (const network of networks) {
  if (network.id in apiStartBlocks) {
    resolved[network.id] = { block: apiStartBlocks[network.id], source: "rail0-api" };
  } else {
    console.log(`[sync-start-blocks] network ${network.id}: not in rail0-api response — detecting deploy block…`);
    const explorerUrl = explorerUrls[network.id];
    const block = await findNetworkStartBlock(network, explorerUrl);
    const source = block === 0 ? "fallback" : explorerUrl ? "explorer" : "rpc-binary-search";
    resolved[network.id] = { block, source };
  }
}

let patched = raw;
for (const network of networks) {
  const { block, source } = resolved[network.id] ?? { block: 0, source: "fallback" };
  patched = patched.replace(
    new RegExp(`(- id: ${network.id}[\\s\\S]*?start_block: )\\d+(\\s*#[^\n]*)?`),
    `$1${block} # ${source}`,
  );
}

writeFileSync(CONFIG_PATH, patched, "utf-8");
console.log(`[sync-start-blocks] ${configFile} updated (env: ${env})`);
