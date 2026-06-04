// Bulletin storage, two routes:
//
// HOST (`viaHost`): the host submits the bytes as a preimage
// (`preimageManager.submit` + RFC-0002 PreimageSubmit permission) — no
// Bulletin RPC connection, no account authorization, no signing-channel
// size negotiation. No block info comes back; the client-side CID is the
// receipt (Rock-Paper-Scissors / t3rminal pattern).
//
// DIRECT (extension///Bob): check authorization → TransactionStorage.store →
// wait for inclusion. Authorization check is REQUIRED — unauthorized store
// transactions fail silently on Bulletin Chain (no on-chain error event).
//
// AuthorizationExtent semantics (v2 runtime, per the pallet's types.rs):
// `transactions`/`bytes` count CONSUMPTION within the current window and
// never gate; `*_allowance` are the caps set at grant time. What gates a
// `store` call is a non-expired authorization existing at all — the soft
// byte counters only feed transaction priority.

import { preimageManager } from "@novasamatech/product-sdk";
import { Enum, type PolkadotSigner } from "polkadot-api";
import { ensureHostPermission } from "../host/permissions.ts";
import { getBulletinClient } from "../polkadot/clients.ts";
import { BULLETIN_FAUCET_URL, BULLETIN_GATEWAY } from "../polkadot/constants.ts";
import { computeCID } from "./cid.ts";
import { submitAndWait, type DeployStatus } from "./submit-and-wait.ts";

import { MAX_TX_BYTES } from "./limits.ts";

export { MAX_TX_BYTES };
const MAX_SIZE = MAX_TX_BYTES;

export interface StoreHTMLResult {
    cid: string;
    /** Null on the host preimage route — the host doesn't report inclusion. */
    blockNumber: number | null;
    blockHash: string | null;
    ipfsUrl: string;
    bytes: number;
}

export interface AuthCheck {
    /** Entry exists and hasn't expired — the actual gate for `store`. */
    authorized: boolean;
    /** True when an entry exists but its window has lapsed. */
    expired: boolean;
    expiresAt: number | null;
    /** Soft-side consumption (store + renew) — priority signal, never gates. */
    bytesUsed: bigint;
    bytesAllowance: bigint;
    transactionsUsed: number;
    transactionsAllowance: number;
}

const NO_AUTH: AuthCheck = {
    authorized: false,
    expired: false,
    expiresAt: null,
    bytesUsed: 0n,
    bytesAllowance: 0n,
    transactionsUsed: 0,
    transactionsAllowance: 0,
};

export async function checkBulletinAuthorization(address: string): Promise<AuthCheck> {
    const { api } = getBulletinClient();
    const [auth, now] = await Promise.all([
        api.query.TransactionStorage.Authorizations.getValue(Enum("Account", address)),
        api.query.System.Number.getValue(),
    ]);
    if (!auth) return NO_AUTH;
    const expired = auth.expiration <= now;
    return {
        authorized: !expired,
        expired,
        expiresAt: auth.expiration,
        bytesUsed: auth.extent.bytes + auth.extent.bytes_permanent,
        bytesAllowance: auth.extent.bytes_allowance,
        transactionsUsed: auth.extent.transactions,
        transactionsAllowance: auth.extent.transactions_allowance,
    };
}

export async function storeBytes(params: {
    bytes: Uint8Array;
    signer: PolkadotSigner;
    signerAddress: string;
    displayName: string;
    label?: string;
    /** Route through the host's preimage submission (host accounts). */
    viaHost?: boolean;
    onStatus?: (status: DeployStatus) => void;
}): Promise<StoreHTMLResult> {
    const { bytes, signer, signerAddress, displayName, label = "Content", viaHost, onStatus } =
        params;

    if (bytes.length === 0) throw new Error(`${label} is empty — nothing to store`);
    if (bytes.length > MAX_SIZE) {
        throw new Error(
            `${label} is ${bytes.length.toLocaleString()} bytes — Bulletin max is ${MAX_SIZE.toLocaleString()} (~2 MiB)`,
        );
    }

    if (viaHost) {
        // Status tags map onto the same stages the direct route reports:
        // permission prompt ≈ signing, host submission ≈ broadcast.
        onStatus?.("signing");
        await ensureHostPermission("PreimageSubmit");
        const cid = computeCID(bytes);
        onStatus?.("broadcasting");
        const key = await preimageManager.submit(bytes);
        // The returned key is the preimage hash. When it's a comparable
        // 32-byte hex, verify it matches our blake2b-256 digest — a mismatch
        // means the host stored (or hashed) something other than what we
        // sent, and the gateway URL we'd report would 404. Unrecognized key
        // formats pass through: a host-side format change must not start
        // failing every upload.
        const digestHex = `0x${Array.from(cid.multihash.digest, (b) =>
            b.toString(16).padStart(2, "0"),
        ).join("")}`;
        if (/^0x[0-9a-f]{64}$/i.test(key) && key.toLowerCase() !== digestHex) {
            throw new Error(
                `Host preimage key ${key} doesn't match the expected blake2b-256 ` +
                    `digest ${digestHex} — the stored bytes may differ from what was sent`,
            );
        }
        onStatus?.("finalized");
        return {
            cid: cid.toString(),
            blockNumber: null,
            blockHash: null,
            ipfsUrl: `${BULLETIN_GATEWAY}${cid.toString()}`,
            bytes: bytes.length,
        };
    }

    const auth = await checkBulletinAuthorization(signerAddress);
    if (!auth.authorized) {
        throw new Error(
            auth.expired
                ? `Bulletin authorization for ${displayName} expired at block #${auth.expiresAt?.toLocaleString()}.\n\n` +
                  `Re-up at the self-serve faucet:\n${BULLETIN_FAUCET_URL}`
                : `No Bulletin authorization for ${displayName} (${signerAddress}).\n\n` +
                  `Self-serve faucet:\n${BULLETIN_FAUCET_URL}`,
        );
    }
    // No byte-budget throw here: the soft-side counters never gate a store
    // call (per the pallet docs) — consumption past the allowance only
    // degrades priority. The pre-flight checklist surfaces that as a warn.

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
    viaHost?: boolean;
    onStatus?: (status: DeployStatus) => void;
}): Promise<StoreHTMLResult> {
    return storeBytes({
        bytes: new TextEncoder().encode(params.html),
        signer: params.signer,
        signerAddress: params.signerAddress,
        displayName: params.displayName,
        label: "HTML",
        viaHost: params.viaHost,
        onStatus: params.onStatus,
    });
}
