// SS58 → H160 mapping via ReviveApi.address(). Returns the canonical on-chain
// H160 that pallet-revive uses as msg.sender for contract calls signed by
// this SS58 account.

import { getAssetHubClient } from "../polkadot/clients.ts";

const cache = new Map<string, `0x${string}`>();

export async function getEvmAddress(ss58Address: string): Promise<`0x${string}`> {
    const cached = cache.get(ss58Address);
    if (cached) return cached;

    const { unsafeApi } = await getAssetHubClient();
    const result = await unsafeApi.apis.ReviveApi.address(ss58Address);
    const hex = (result as { asHex?: () => string })?.asHex?.() ?? (result as string);

    if (typeof hex === "string" && hex.startsWith("0x") && hex.length === 42) {
        const evmAddr = hex.toLowerCase() as `0x${string}`;
        cache.set(ss58Address, evmAddr);
        return evmAddr;
    }

    throw new Error(`ReviveApi.address() returned unexpected result for ${ss58Address}: ${hex}`);
}
