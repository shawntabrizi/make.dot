// paseo-next-v2 endpoints + DotNS contract addresses.
// Sources:
//   - playground-cli/src/config.ts (RPCs + gateway)
//   - bulletin-deploy/assets/environments.json (DotNS contract addresses)

// Note: BULLETIN_RPC was removed — Bulletin chain is reached via
// CloudStorageClient({ environment: "paseo" }) which uses its own host-routed
// transport. BULLETIN_GATEWAY is still used to construct IPFS gateway URLs.
export const BULLETIN_GATEWAY = "https://paseo-bulletin-next-ipfs.polkadot.io/ipfs/";

// Note: ASSET_HUB_RPC / ASSET_HUB_GENESIS were removed — the Asset Hub client is
// now built via `getChainAPI("paseo")` (see clients.ts), which resolves the
// chain through the host using the `paseo_asset_hub` descriptor's own genesis.
// On a testnet reset, re-run `npx papi update`; the descriptor carries the
// genesis, so there's no hash to hand-sync here anymore.

// DotNS deployed contract addresses (source: bulletin-deploy/assets/environments.json).
// Maps: DOTNS_REGISTRY / DOTNS_REGISTRAR / DOTNS_REGISTRAR_CONTROLLER /
//       DOTNS_CONTENT_RESOLVER / POP_RULES.
// The Paseo Asset Hub Next testnet resets periodically — re-sync these with
// environments.json after any testnet reset.
export const DOTNS_CONTRACTS = {
    registry: "0xa1b2b939E82b2ecE55Bd8a0E283818BfC1CA6CDc",
    registrar: "0xf7Ad3F44F316C73E4a2b46b1ed48d376bCc9E639",
    registrarController: "0x674b705268DAE369F0a7BE9cbaCDb928b8BA38C2",
    contentResolver: "0x8A26480b0B5Df3d4D9b95adc24a5Ecb33A5b8F64",
    popRules: "0x4909bFb3f4Fd86244abD6430fDfA0Ce5C91aD0c4",
} as const;

// Wei (EVM, 18 decimals) per native planck. Paseo Asset Hub's native token has
// **10 decimals**, so 1 PAS = 1e10 native = 1e18 Wei → 1 native planck = 1e8 Wei.
// (Source of truth: bulletin-deploy environments.json `paseo-next-v2`
// `nativeToEthRatio: 100000000`.) An earlier value of 1e6 assumed 12-decimal
// native and made `register` send 100× the correct payment → ContractReverted.
export const NATIVE_TO_ETH_RATIO = 100_000_000n;

/** PAS faucet for paying contract fees on Asset Hub Next. */
export const PAS_FAUCET_URL = "https://faucet.polkadot.io/";
