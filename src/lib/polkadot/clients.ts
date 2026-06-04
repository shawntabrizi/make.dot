// Cached PAPI clients for Bulletin Chain and Asset Hub Next.
//
// Asset Hub routes through the host (`createPapiProvider` with WS fallback)
// when running as a deployed app inside Polkadot Desktop/Mobile — the host
// owns the chain follow there, so signing/permissions stay coordinated
// (Rock-Paper-Scissors / t3rminal pattern). Dev/localhost bypasses straight
// to WS: the host refuses to open a follow for unregistered domains even
// though `host_feature_supported` reports true, so the provider would trap
// without the fallback ever firing. Bulletin stays direct WS everywhere —
// hosts don't follow Bulletin (yet).

import { createClient, type TypedApi } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { createPapiProvider } from "@novasamatech/product-sdk";
import { isInHost } from "../host/detect.ts";
// Locally-generated descriptors via `papi add` against the live chains.
// The pre-published `@parity/product-sdk-descriptors` package is too stale for
// the v2 runtime — runtime-API entry hashes mismatch, producing
// "Incompatible runtime entry RuntimeCall(ReviveApi_call)" at dry-run time.
// Re-generate via `npx papi generate` whenever the chain's runtime upgrades.
import { bulletin, pah } from "@polkadot-api/descriptors";
import { ASSET_HUB_RPC, BULLETIN_RPC, NETWORK } from "./constants.ts";

function assetHubProvider() {
    const ws = getWsProvider(ASSET_HUB_RPC);
    const genesis = NETWORK.assetHubGenesis;
    const isDevHost =
        typeof window !== "undefined" && /^localhost(:\d+)?$/.test(window.location.host);
    if (!genesis || isDevHost || !isInHost()) return ws;
    return createPapiProvider(genesis as `0x${string}`, ws);
}

type BulletinApi = TypedApi<typeof bulletin>;
type AssetHubApi = TypedApi<typeof pah>;
type Client = ReturnType<typeof createClient>;

let bulletinClient: Client | null = null;
let bulletinApi: BulletinApi | null = null;

let assetHubClient: Client | null = null;
let assetHubApi: AssetHubApi | null = null;
let assetHubUnsafeApi: ReturnType<Client["getUnsafeApi"]> | null = null;

export function getBulletinClient(): { client: Client; api: BulletinApi } {
    if (!bulletinClient) {
        bulletinClient = createClient(getWsProvider(BULLETIN_RPC));
        bulletinApi = bulletinClient.getTypedApi(bulletin);
    }
    return { client: bulletinClient, api: bulletinApi! };
}

export function getAssetHubClient(): {
    client: Client;
    api: AssetHubApi;
    unsafeApi: ReturnType<Client["getUnsafeApi"]>;
} {
    if (!assetHubClient) {
        assetHubClient = createClient(assetHubProvider());
        assetHubApi = assetHubClient.getTypedApi(pah);
        assetHubUnsafeApi = assetHubClient.getUnsafeApi();
    }
    return { client: assetHubClient, api: assetHubApi!, unsafeApi: assetHubUnsafeApi! };
}
