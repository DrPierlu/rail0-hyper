#!/usr/bin/env node
/**
 * bin/gen-config.mjs
 *
 * Generates the networks section of config.yaml based on NODE_ENV, then
 * patches start_block values with live data from rail0-api.
 *
 * config.yaml is the single source of truth for chain/contract/event
 * definitions. The static sections (field_selection, contracts/events) are
 * preserved as-is; only the networks section is regenerated on each run.
 *
 * Chain definitions mirror rail0-indexer/src/chains.ts:
 *   development  → ARC Testnet only
 *   staging      → ARC Testnet + Celo Sepolia
 *   production   → (add production chains here when ready)
 *
 * Environment variables:
 *   NODE_ENV               — selects the chain list (default: development)
 *   RAIL0_API_URL          — base URL of rail0-api
 *   RAIL0_API_HMAC_SECRET  — 32-byte hex shared secret
 */

import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "../config.yaml");

// ── Chain definitions (mirrors rail0-indexer/src/chains.ts) ──────────────────

const CHAINS = {
  development: [
    {
      id: 5042002,
      rpc: "https://rpc.testnet.arc.network",
      contracts: [
        // "0xcEA3E28cb387929876F7b1c452460fF3F40C40B7", // v7 (inactive)
        "0x0e393A626EfC45EBd030EBB997CDa207013C4364", // v9
      ],
      startBlock: 0,
    },
  ],
  staging: [
    {
      id: 5042002,
      rpc: "https://rpc.testnet.arc.network",
      contracts: [
        // "0xcEA3E28cb387929876F7b1c452460fF3F40C40B7", // v7 (inactive)
        "0x0e393A626EfC45EBd030EBB997CDa207013C4364", // v9
      ],
      startBlock: 0,
    },
    {
      id: 44787,
      rpc: "https://rpc.ankr.com/celo_sepolia",
      contracts: [
        "0x7337ce441e831ef2904b7B2f33507d655a4381d0", // v9
      ],
      startBlock: 0,
    },
  ],
  production: [
    // Add production chains here when ready.
  ],
};

const env = process.env.NODE_ENV ?? "development";
const chainList = CHAINS[env] ?? CHAINS.development;

// ── Fetch start blocks from rail0-api ─────────────────────────────────────────

async function fetchStartBlocks() {
  const baseUrl = process.env.RAIL0_API_URL;
  const secret = process.env.RAIL0_API_HMAC_SECRET;

  if (!baseUrl || !secret) {
    console.warn(
      "[gen-config] RAIL0_API_URL or RAIL0_API_HMAC_SECRET not set — using fallback start_block: 0",
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
        `[gen-config] GET /sync/blockchains returned ${res.status} — using fallback start_block: 0`,
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

// ── Build networks YAML section ───────────────────────────────────────────────

function buildNetworksSection(startBlocks) {
  const lines = ["networks:"];
  for (const chain of chainList) {
    const startBlock = startBlocks[chain.id] ?? chain.startBlock;
    const addresses = chain.contracts.map((a) => `          - "${a}"`).join("\n");
    lines.push(
      `  - id: ${chain.id}`,
      `    start_block: ${startBlock}`,
      `    rpc: ${chain.rpc}`,
      `    contracts:`,
      `      - name: RAIL0`,
      `        address:`,
      addresses,
    );
  }
  return lines.join("\n");
}

// ── Patch config.yaml ─────────────────────────────────────────────────────────
// Preserve everything above the networks section; regenerate networks entirely.

const raw = readFileSync(CONFIG_PATH, "utf-8");

const startBlocks = await fetchStartBlocks();
const networksSection = buildNetworksSection(startBlocks);

// Replace everything from "networks:" to end of file.
const networksIndex = raw.indexOf("\nnetworks:");
const header = networksIndex >= 0 ? raw.slice(0, networksIndex) : raw;

writeFileSync(CONFIG_PATH, `${header}\n${networksSection}\n`, "utf-8");
console.log(`[gen-config] config.yaml written (env: ${env}, chains: ${chainList.map((c) => c.id).join(", ")})`);
