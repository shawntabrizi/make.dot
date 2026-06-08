// paseo-next-v2 endpoints + DotNS contract addresses.
// Sources:
//   - playground-cli/src/config.ts (RPCs + gateway)
//   - bulletin-deploy/assets/environments.json (DotNS contract addresses)

// Note: BULLETIN_RPC was removed — Bulletin chain is reached via
// CloudStorageClient({ environment: "paseo" }) which uses its own host-routed
// transport. BULLETIN_GATEWAY is still used to construct IPFS gateway URLs.
export const BULLETIN_GATEWAY = "https://paseo-bulletin-next-ipfs.polkadot.io/ipfs/";

export const ASSET_HUB_RPC = "wss://paseo-asset-hub-next-rpc.polkadot.io";

// Asset Hub Next genesis hash (`.papi/polkadot-api.json` "pah".genesis).
// Used to host-route the chain provider via `createPapiProvider`. This testnet
// resets periodically, rotating its genesis — re-sync this with polkadot-api.json
// after any `papi update`.
export const ASSET_HUB_GENESIS =
    "0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f";

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

/** 1 PAS (native, 12 decimals) = 1_000_000 Wei (EVM, 18 decimals). */
export const NATIVE_TO_ETH_RATIO = 1_000_000n;

/** PAS faucet for paying contract fees on Asset Hub Next. */
export const PAS_FAUCET_URL = "https://faucet.polkadot.io/";
