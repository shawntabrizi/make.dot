// Bulletin storage flow: check authorization → TransactionStorage.store →
// wait for inclusion. Authorization check is REQUIRED — unauthorized store
// transactions fail silently on Bulletin Chain (no on-chain error event).

import { Enum, type PolkadotSigner } from "polkadot-api";
import { getBulletinClient } from "../polkadot/clients.ts";
import { BULLETIN_FAUCET_URL, BULLETIN_GATEWAY } from "../polkadot/constants.ts";
import { computeCID } from "./cid.ts";
import { submitAndWait, type DeployStatus } from "./submit-and-wait.ts";

const MAX_SIZE = 2 * 1024 * 1024; // 2 MiB on Paseo Next (8 MiB on Polkadot Bulletin)

export interface StoreHTMLResult {
    cid: string;
    blockNumber: number;
    blockHash: string;
    ipfsUrl: string;
    bytes: number;
}

interface AuthCheck {
    authorized: boolean;
    transactions: number;
    bytes: bigint;
}

export async function checkBulletinAuthorization(address: string): Promise<AuthCheck> {
    const { api } = getBulletinClient();
    const auth = await api.query.TransactionStorage.Authorizations.getValue(
        Enum("Account", address),
    );
    if (!auth) return { authorized: false, transactions: 0, bytes: 0n };
    return {
        authorized: auth.extent.transactions > 0 && auth.extent.bytes > 0n,
        transactions: auth.extent.transactions,
        bytes: auth.extent.bytes,
    };
}

export async function storeBytes(params: {
    bytes: Uint8Array;
    signer: PolkadotSigner;
    signerAddress: string;
    displayName: string;
    label?: string;
    onStatus?: (status: DeployStatus) => void;
}): Promise<StoreHTMLResult> {
    const { bytes, signer, signerAddress, displayName, label = "Content", onStatus } = params;

    if (bytes.length === 0) throw new Error(`${label} is empty — nothing to store`);
    if (bytes.length > MAX_SIZE) {
        throw new Error(
            `${label} is ${bytes.length.toLocaleString()} bytes — Bulletin max is ${MAX_SIZE.toLocaleString()} (~2 MiB)`,
        );
    }

    const auth = await checkBulletinAuthorization(signerAddress);
    if (!auth.authorized) {
        throw new Error(
            `No Bulletin authorization for ${displayName} (${signerAddress}).\n\n` +
                `Self-serve faucet:\n${BULLETIN_FAUCET_URL}`,
        );
    }
    if (auth.bytes < BigInt(bytes.length)) {
        throw new Error(
            `${displayName} is authorized for ${auth.bytes} bytes but ${label.toLowerCase()} is ${bytes.length} bytes`,
        );
    }

    const cid = computeCID(bytes).toString();
    const { api } = getBulletinClient();
    const tx = api.tx.TransactionStorage.store({ data: bytes });
    const result = await submitAndWait(tx, signer, onStatus);

    return {
        cid,
        blockNumber: result.blockNumber,
        blockHash: result.blockHash,
        ipfsUrl: `${BULLETIN_GATEWAY}${cid}`,
        bytes: bytes.length,
    };
}

export async function storeHTML(params: {
    html: string;
    signer: PolkadotSigner;
    signerAddress: string;
    displayName: string;
    onStatus?: (status: DeployStatus) => void;
}): Promise<StoreHTMLResult> {
    return storeBytes({
        bytes: new TextEncoder().encode(params.html),
        signer: params.signer,
        signerAddress: params.signerAddress,
        displayName: params.displayName,
        label: "HTML",
        onStatus: params.onStatus,
    });
}
