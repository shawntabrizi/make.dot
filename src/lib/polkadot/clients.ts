// Asset Hub Next client for the DotNS flow.
//
// IMPORTANT: this goes through the product-sdk's `getChainAPI`, NOT a bespoke
// `createClient(createPapiProvider(...))`. We learned the hard way that
// hand-rolling the client produces a chainHead stream observable-client can't
// keep consistent over the host transport — every DotNS call crashed in-host
// with cascading chainHead errors (`reading 'children'`, then `toBlockInfo`
// on undefined, …). `getChainAPI` is the exact path playground-app uses
// successfully inside the same hosts, so we use it verbatim:
//   - one cached client per chain (no duplicate chainHead subscriptions),
//   - host provider with no WS fallback (the fallback was a prime suspect),
//   - `getUnsafeApi()` for everything, so calls bind to LIVE chain metadata and
//     we don't depend on a (periodically-stale) published descriptor.
//
// `getChainAPI` throws when not inside a host. That's fine: the DotNS flow only
// runs on the host-gated deploy path (standalone is preview-only).

import { getChainAPI } from "@parity/product-sdk-chain-client";

const CHAIN = "paseo";

type AssetHubClient = {
    // The raw PAPI client for Asset Hub.
    client: Awaited<ReturnType<typeof getChainAPI>>["raw"]["assetHub"];
    // Unsafe API bound to live metadata — used for both ReviveApi runtime calls
    // (dry-run / address) and Revive extrinsic construction.
    unsafeApi: ReturnType<Awaited<ReturnType<typeof getChainAPI>>["raw"]["assetHub"]["getUnsafeApi"]>;
};

// Cache the in-flight/resolved promise so concurrent callers share one client.
// Reset on rejection so a later retry can re-establish the connection.
let assetHubPromise: Promise<AssetHubClient> | null = null;

export function getAssetHubClient(): Promise<AssetHubClient> {
    if (!assetHubPromise) {
        assetHubPromise = (async () => {
            const chain = await getChainAPI(CHAIN);
            const client = chain.raw.assetHub;
            return { client, unsafeApi: client.getUnsafeApi() };
        })().catch((err) => {
            assetHubPromise = null;
            throw err;
        });
    }
    return assetHubPromise;
}
