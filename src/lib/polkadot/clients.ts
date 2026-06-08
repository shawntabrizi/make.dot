// Cached PAPI client for Asset Hub Next (DotNS).
//
// The Asset Hub client is host-routed: inside the Polkadot host (Desktop/Mobile
// webview or iframe) it goes through the host's chain connection via
// `createPapiProvider(genesisHash)`, with the direct WebSocket kept as the
// `__fallback`. When running standalone (the //Bob dev path always is), we use
// the direct WS provider straight away.
//
// `createPapiProvider` calls `transport.isCorrectEnvironment()` at construction
// and THROWS ("PapiProvider can only be used in a product environment") when not
// in a host — it does not lazily fall back at construct time. So we guard it
// with `isInsideContainerSync()` (the same iframe/webview check the transport
// uses) and only construct the host provider when we're actually in a host.
//
// The Bulletin store path is host-routed separately by CloudStorageClient (T3);
// it does not go through this module.

import { createClient, type TypedApi } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { createPapiProvider } from "@novasamatech/host-api-wrapper";
import { isInsideContainerSync } from "@parity/product-sdk-host";
// Locally-generated descriptors via `papi add` against the live chains.
// The pre-published `@parity/product-sdk-descriptors` package is too stale for
// the v2 runtime — runtime-API entry hashes mismatch, producing
// "Incompatible runtime entry RuntimeCall(ReviveApi_call)" at dry-run time.
// Re-generate via `npx papi generate` whenever the chain's runtime upgrades.
import { pah } from "@polkadot-api/descriptors";
import { ASSET_HUB_GENESIS, ASSET_HUB_RPC } from "./constants.ts";

type AssetHubApi = TypedApi<typeof pah>;
type Client = ReturnType<typeof createClient>;

// Cached for the page lifetime — isInsideContainerSync() is evaluated once at
// first call. Environment (host vs. standalone) is assumed not to change within
// a session, which holds for this SPA (no SSR, no dynamic context switches).
let assetHubClient: Client | null = null;
let assetHubApi: AssetHubApi | null = null;
let assetHubUnsafeApi: ReturnType<Client["getUnsafeApi"]> | null = null;

function getAssetHubProvider() {
    // Construct the host provider only when in a host — otherwise it throws.
    // The direct WS provider is passed as `__fallback` so that even in-host,
    // if the host can't serve this chain, papi falls back to a direct dial.
    if (isInsideContainerSync()) {
        return createPapiProvider(ASSET_HUB_GENESIS, getWsProvider(ASSET_HUB_RPC));
    }
    return getWsProvider(ASSET_HUB_RPC);
}

export function getAssetHubClient(): {
    client: Client;
    api: AssetHubApi;
    unsafeApi: ReturnType<Client["getUnsafeApi"]>;
} {
    if (!assetHubClient) {
        assetHubClient = createClient(getAssetHubProvider());
        assetHubApi = assetHubClient.getTypedApi(pah);
        assetHubUnsafeApi = assetHubClient.getUnsafeApi();
    }
    return { client: assetHubClient, api: assetHubApi!, unsafeApi: assetHubUnsafeApi! };
}
