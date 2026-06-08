/**
 * Chain and contract configuration for all environments.
 *
 * Exports `chainConfigs` already selected for the current NODE_ENV:
 *   production  → production chains
 *   staging     → staging chains
 *   * (default) → development chains (mirrors staging by default)
 *
 * startBlock is set to 0 in every entry — the actual deployment block is stored
 * in contracts.start_block on rail0-api and returned by GET /sync/start_blocks
 * at ponder startup (see ponder.config.ts). To populate it, run:
 *
 *   rake contracts:sync_start_blocks
 *
 * ── Rules ─────────────────────────────────────────────────────────────────────
 *   rpcUrl      — public endpoints go here directly; endpoints with an API key
 *                 use an env var inline: `https://…/${process.env.MY_KEY}`
 *   contracts   — include all deployed versions; older contracts still emit events
 *   startBlock  — leave at 0; the API provides the real value at runtime
 */

export interface ChainConfig {
  /** EVM chain ID */
  chainId: number
  /**
   * HTTP RPC endpoint for this chain.
   * For public endpoints (no API key), hardcode the URL.
   * For private endpoints, reference an env var inline:
   *   `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`
   */
  rpcUrl: string
  /**
   * All RAIL0 contract addresses deployed on this chain.
   * Include every version — older contracts still emit events.
   */
  contracts: `0x${string}`[]
  /**
   * Fallback start block used only when rail0-api is unreachable at startup.
   * Leave at 0 — the real value comes from GET /sync/start_blocks.
   */
  startBlock: number
}

// ── Per-environment chain lists ────────────────────────────────────────────────

const development: ChainConfig[] = [
  // ARC Testnet (chainId 5042002) — mirrors staging so dev works against real on-chain data.
  // Override rpcUrl with a local node URL (e.g. Anvil) for a local fork.
  {
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.network",
    contracts: [
      // "0xcEA3E28cb387929876F7b1c452460fF3F40C40B7", // v7 (inactive)
      "0x0e393A626EfC45EBd030EBB997CDa207013C4364", // v9
    ],
    startBlock: 0,
  },
];

const staging: ChainConfig[] = [
  // ARC Testnet (chainId 5042002)
  {
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.network",
    contracts: [
      // "0xcEA3E28cb387929876F7b1c452460fF3F40C40B7", // v7 (inactive)
      "0x0e393A626EfC45EBd030EBB997CDa207013C4364", // v9
    ],
    startBlock: 0,
  },
  // Celo Sepolia (chainId 44787)
  {
    chainId: 44787,
    rpcUrl: "https://rpc.ankr.com/celo_sepolia",
    contracts: [
      "0x7337ce441e831ef2904b7B2f33507d655a4381d0", // v9
    ],
    startBlock: 0,
  },
];

const production: ChainConfig[] = [
  // Production chains go here.
  // Example — Arbitrum One:
  // {
  //   chainId: 42161,
  //   rpcUrl: `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`,
  //   contracts: ["0xAAA..."],
  //   startBlock: 0,
  // },
];

// ── Export ─────────────────────────────────────────────────────────────────────

const env = process.env.NODE_ENV;

export const chainConfigs: ChainConfig[] =
  env === "production" ? production :
  env === "staging"    ? staging    :
                         development;
