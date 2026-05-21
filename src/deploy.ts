// Deploy flow.
//
// Two paths today:
//   - `deployToBulletin(...)` — real chain submission, used by the //Bob path.
//     Connects to paseo-next-v2's Bulletin Chain via PAPI, checks auth,
//     submits `TransactionStorage.store`, returns the block where the data
//     landed plus the gateway URL.
//   - `previewDeploy(...)` — preview-only fallback. Used by the host/extension
//     paths today because (a) the host signer's signBytes is stubbed, and (b)
//     those accounts may not have Bulletin authorization yet.
//
// Not wired yet: DotNS register + setContenthash. After `deployToBulletin`
// succeeds, the bytes are live on Bulletin and reachable via the gateway URL,
// but the `<name>.dot.li` mapping requires a separate Asset Hub Next contract
// call (DotNS register/setContenthash). That'll need `@parity/product-sdk-contracts`
// + the DotNS contract address + the right ABI. Out of scope for this commit.

import { blake2b } from "@noble/hashes/blake2b";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { Enum, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_bulletin } from "@parity/product-sdk-descriptors/paseo-bulletin";
import type { ActiveAccount } from "./account.ts";

const RAW_CODEC = 0x55;
const BLAKE2B_256_MULTIHASH_CODE = 0xb220;

const BULLETIN_RPC = "wss://paseo-bulletin-next-rpc.polkadot.io";
const BULLETIN_GATEWAY = "https://paseo-bulletin-next-ipfs.polkadot.io/ipfs/";
const MAX_TX_BYTES = 2 * 1024 * 1024; // Paseo Next: 2 MiB
const TX_TIMEOUT_MS = 60_000;
const FAUCET_URL =
    "https://paritytech.github.io/polkadot-bulletin-chain/authorizations?tab=faucet";

// ── Common helpers ──────────────────────────────────────────────────────────

function computeCid(bytes: Uint8Array): CID {
    const hash = blake2b(bytes, { dkLen: 32 });
    const digest = Digest.create(BLAKE2B_256_MULTIHASH_CODE, hash);
    return CID.createV1(RAW_CODEC, digest);
}

// Auto-derive a NoStatus-shape label from the header text. Matches `dot
// decentralize`'s rule: base length >= 9 + exactly 2 trailing digits = NoStatus
// per DotNS's classifier. The .dot label isn't used today (DotNS register is
// not wired), but we still report it so the eventual `<name>.dot.li` URL is
// predictable from the preview.
function deriveDomain(seed: string): string {
    let s = seed
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (!s) s = "hello";
    if (s.length > 24) s = s.slice(0, 24).replace(/-+$/, "");
    const letters = Array.from(crypto.getRandomValues(new Uint8Array(4)))
        .map((b) => String.fromCharCode(97 + (b % 26)))
        .join("");
    const digits = String((crypto.getRandomValues(new Uint8Array(1))[0] % 90) + 10);
    const minPrefixLen = 9;
    const prefixLen = s.length + 1;
    const padded =
        prefixLen + letters.length >= minPrefixLen
            ? letters
            : letters + "abcd".slice(0, Math.max(0, minPrefixLen - prefixLen - letters.length));
    return `${s}-${padded}${digits}`;
}

// ── Public types ────────────────────────────────────────────────────────────

export interface DeployPreview {
    kind: "preview";
    bytes: number;
    cid: string;
    domain: string;
    url: string;
    gatewayUrl: string;
}

export interface DeploySuccess {
    kind: "stored";
    bytes: number;
    cid: string;
    domain: string;
    url: string;
    gatewayUrl: string;
    blockHash: string;
    blockNumber: number;
    txIndex: number;
}

export type StatusFn = (message: string) => void;

// ── Preview (no chain submission) ───────────────────────────────────────────

export async function previewDeploy(html: string, domain: string | null): Promise<DeployPreview> {
    const bytes = new TextEncoder().encode(html);
    const cid = computeCid(bytes).toString();
    const finalDomain = (domain ?? "").replace(/\.dot$/i, "") || deriveDomain(html.slice(0, 64));
    return {
        kind: "preview",
        bytes: bytes.length,
        cid,
        domain: finalDomain,
        url: `https://${finalDomain}.dot.li`,
        gatewayUrl: `${BULLETIN_GATEWAY}${cid}`,
    };
}

// ── Real Bulletin deploy (used by the //Bob path) ───────────────────────────

export async function deployToBulletin(
    html: string,
    domain: string | null,
    account: ActiveAccount,
    onStatus: StatusFn = () => {},
): Promise<DeploySuccess> {
    const bytes = new TextEncoder().encode(html);
    if (bytes.length === 0) throw new Error("HTML is empty — nothing to deploy");
    if (bytes.length > MAX_TX_BYTES) {
        throw new Error(
            `HTML is ${bytes.length.toLocaleString()} bytes — Bulletin max is ${MAX_TX_BYTES.toLocaleString()} (~2 MiB)`,
        );
    }

    const cid = computeCid(bytes).toString();
    const finalDomain = (domain ?? "").replace(/\.dot$/i, "") || deriveDomain(html.slice(0, 64));

    onStatus("Connecting to Bulletin Chain…");
    const client = createClient(getWsProvider(BULLETIN_RPC));

    try {
        const api = client.getTypedApi(paseo_bulletin);

        onStatus(`Checking authorization for ${account.address.slice(0, 10)}…`);
        const auth = await api.query.TransactionStorage.Authorizations.getValue(
            Enum("Account", account.address),
        );
        // `transactions` is `number`, `bytes` is `bigint` per the descriptor.
        if (!auth || auth.extent.transactions === 0 || auth.extent.bytes < BigInt(bytes.length)) {
            throw new Error(
                `No Bulletin authorization for ${account.displayName} (${account.address}).\n\n` +
                    `Visit the faucet to grant authorization, then retry:\n${FAUCET_URL}`,
            );
        }

        onStatus("Submitting TransactionStorage.store…");
        // The descriptor takes a Uint8Array directly for `data` — no Binary
        // wrapper needed (matches playground-cli's playground.ts usage).
        const tx = api.tx.TransactionStorage.store({ data: bytes });

        const inclusion = await submitAndWait(tx, account.signer, onStatus);

        return {
            kind: "stored",
            bytes: bytes.length,
            cid,
            domain: finalDomain,
            url: `https://${finalDomain}.dot.li`,
            gatewayUrl: `${BULLETIN_GATEWAY}${cid}`,
            blockHash: inclusion.blockHash,
            blockNumber: inclusion.blockNumber,
            txIndex: inclusion.txIndex,
        };
    } finally {
        // Per bulletin-storage skill: "NEVER destroy PAPI client while
        // signSubmitAndWatch observable is alive." We've awaited the
        // observable resolution above before reaching this finally, so the
        // destroy is safe.
        client.destroy();
    }
}

// ── Internal: Observable → Promise bridge for store transactions ────────────

interface Inclusion {
    blockHash: string;
    blockNumber: number;
    txIndex: number;
}

function submitAndWait(
    tx: {
        signSubmitAndWatch: (signer: ActiveAccount["signer"]) => {
            subscribe: (observer: {
                next: (ev: unknown) => void;
                error: (err: unknown) => void;
            }) => { unsubscribe: () => void };
        };
    },
    signer: ActiveAccount["signer"],
    onStatus: StatusFn,
): Promise<Inclusion> {
    return new Promise<Inclusion>((resolve, reject) => {
        const timer = setTimeout(() => {
            sub.unsubscribe();
            reject(new Error(`Transaction timed out after ${TX_TIMEOUT_MS / 1000}s`));
        }, TX_TIMEOUT_MS);

        const sub = tx.signSubmitAndWatch(signer).subscribe({
            next: (raw) => {
                const ev = raw as {
                    type: string;
                    found?: boolean;
                    ok?: boolean;
                    dispatchError?: unknown;
                    block?: { hash: string; number: number; index: number };
                };
                switch (ev.type) {
                    case "signed":
                        onStatus("Signed, broadcasting…");
                        break;
                    case "broadcasted":
                        onStatus("Broadcast — waiting for block inclusion…");
                        break;
                    case "txBestBlocksState":
                        if (ev.found && ev.block) {
                            clearTimeout(timer);
                            sub.unsubscribe();
                            if (ev.ok === false) {
                                reject(
                                    new Error(
                                        `Tx failed on-chain: ${
                                            ev.dispatchError
                                                ? JSON.stringify(ev.dispatchError)
                                                : "unknown dispatch error"
                                        }`,
                                    ),
                                );
                            } else {
                                resolve({
                                    blockHash: ev.block.hash,
                                    blockNumber: ev.block.number,
                                    txIndex: ev.block.index,
                                });
                            }
                        }
                        break;
                }
            },
            error: (err) => {
                clearTimeout(timer);
                sub.unsubscribe();
                reject(err instanceof Error ? err : new Error(String(err)));
            },
        });
    });
}
