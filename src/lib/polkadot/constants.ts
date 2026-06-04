// All network endpoints and contract addresses come from /networks.json —
// the top-level config for the test networks this app can target. Switch
// networks by changing its `active` field; re-sync values from
// bulletin-deploy/assets/environments.json when backends change.

import networksConfig from "../../../networks.json";

export interface NetworkConfig {
    name: string;
    description: string;
    bulletinRpc: string;
    assetHubRpc: string;
    /** AH genesis hash — enables host-routed providers; WS fallback if absent. */
    assetHubGenesis?: string;
    ipfsGateway: string;
    dotHost: string;
    nativeToEthRatio: number;
    bulletinFaucetUrl: string;
    pasFaucetUrl: string;
    contracts: {
        registry: string;
        registrar: string;
        registrarController: string;
        contentResolver: string;
        popRules: string;
    };
}

const networks: Record<string, NetworkConfig> = networksConfig.networks;
export const NETWORK: NetworkConfig = networks[networksConfig.active];
if (!NETWORK) {
    throw new Error(
        `networks.json: active network "${networksConfig.active}" is not defined`,
    );
}

export const BULLETIN_RPC = NETWORK.bulletinRpc;
export const BULLETIN_GATEWAY = `${NETWORK.ipfsGateway}/ipfs/`;

export const ASSET_HUB_RPC = NETWORK.assetHubRpc;

/** Host suffix where DotNS names resolve (e.g. `<name>.dot.li`). */
export const DOT_HOST = NETWORK.dotHost;

/** DotNS deployed contract addresses on the active network's Asset Hub. */
export const DOTNS_CONTRACTS = NETWORK.contracts;

/** Native-token base units → EVM Wei (18 decimals) conversion factor. */
export const NATIVE_TO_ETH_RATIO = BigInt(NETWORK.nativeToEthRatio);

/** Self-serve faucet for Bulletin storage authorization. */
export const BULLETIN_FAUCET_URL = NETWORK.bulletinFaucetUrl;

/** Faucet for native tokens to pay contract fees on Asset Hub. */
export const PAS_FAUCET_URL = NETWORK.pasFaucetUrl;
