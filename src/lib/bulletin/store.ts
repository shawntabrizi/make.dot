// Bulletin storage flow via the host-routed CloudStorageClient:
// validate size → store().send() → receipt with CID + block.
//
// The client is a lazy singleton built once and reused. Its signer is resolved
// per-call from the currently-active account (the //Bob dev account) via the
// module-level holder in account.ts. There is no `signer` param on
// storeBytes / storeHTML.

import {
    CloudStorageClient,
    createLazySigner,
    calculateCid,
    TxStatus,
} from "@parity/product-sdk-cloud-storage";
import type { PolkadotSigner } from "polkadot-api";
import { getCurrentAccount } from "../../account.ts";
import { BULLETIN_GATEWAY } from "../polkadot/constants.ts";
import type { DeployStatus } from "./submit-and-wait.ts";

/** Per-transaction chain cap — applies regardless of account authorization. */
export const MAX_TX_BYTES = 2 * 1024 * 1024; // 2 MiB on Paseo Next (8 MiB on Polkadot Bulletin)

// `environment: "paseo"` resolves to the paseo-bulletin-next chain
// (genesis 0x8cfe…0a22, wss://paseo-bulletin-next-rpc.polkadot.io).
// Verified against the chain-client preset.
const ENVIRONMENT = "paseo" as const;

export interface StoreHTMLResult {
    cid: string;
    blockNumber: number;
    blockHash: string | null;
    ipfsUrl: string;
    bytes: number;
}

// Promise-based singleton so concurrent first callers share one
// CloudStorageClient.create() instead of each spinning up their own. The lazy
// signer resolves the //Bob dev account from account.ts on each store call.
let clientPromise: Promise<CloudStorageClient> | null = null;

function getCloudStorageClient(): Promise<CloudStorageClient> {
    if (!clientPromise) {
        const signer: PolkadotSigner = createLazySigner(
            () => getCurrentAccount()?.signer ?? null,
        );
        clientPromise = CloudStorageClient.create({ environment: ENVIRONMENT, signer })
            .catch((err) => { clientPromise = null; return Promise.reject(err); });
    }
    return clientPromise;
}

export async function storeBytes(params: {
    bytes: Uint8Array;
    signerAddress: string;
    displayName: string;
    label?: string;
    onStatus?: (status: DeployStatus) => void;
}): Promise<StoreHTMLResult> {
    const { bytes, label = "Content", onStatus } = params;

    if (bytes.length === 0) throw new Error(`${label} is empty — nothing to store`);
    if (bytes.length > MAX_TX_BYTES) {
        throw new Error(
            `${label} is ${bytes.length.toLocaleString()} bytes — Bulletin max is ${MAX_TX_BYTES.toLocaleString()} (~2 MiB)`,
        );
    }

    const client = await getCloudStorageClient();

    onStatus?.("signing");
    const result = await client
        .store(bytes)
        .withCallback((evt) => {
            if (evt.type === TxStatus.Broadcasted) onStatus?.("broadcasting");
            else if (evt.type === TxStatus.InBlock) onStatus?.("in-block");
        })
        .send();
    onStatus?.("finalized");

    const cid = result.cid?.toString() ?? (await calculateCid(bytes)).toString();
    return {
        cid,
        blockNumber: result.blockNumber ?? 0,
        // StoreResult exposes block number + extrinsic index, not a block hash.
        // The hash isn't surfaced by the host-routed store path; downstream only
        // displays the number.
        blockHash: null,
        ipfsUrl: `${BULLETIN_GATEWAY}${cid}`,
        bytes: bytes.length,
    };
}

export async function storeHTML(params: {
    html: string;
    signerAddress: string;
    displayName: string;
    onStatus?: (status: DeployStatus) => void;
}): Promise<StoreHTMLResult> {
    return storeBytes({
        bytes: new TextEncoder().encode(params.html),
        signerAddress: params.signerAddress,
        displayName: params.displayName,
        label: "HTML",
        onStatus: params.onStatus,
    });
}
