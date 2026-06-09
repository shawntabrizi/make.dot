// Pallet-revive bridge: dry-run a contract call, submit a contract call,
// and (one-time per account) ensure the SS58 → H160 mapping exists.
//
// Patterns adapted from dotdot-deployer. The 4x gas multiplier + minimum
// 2 PAS storage deposit defaults are inherited from the DotNS SDK reference.

import { Binary, type PolkadotSigner } from "polkadot-api";
import { getAssetHubClient } from "../polkadot/clients.ts";
import { submitAndWait, type DeployStatus } from "../bulletin/submit-and-wait.ts";

const MAX_WEIGHT = 18446744073709551615n;
const MIN_STORAGE_DEPOSIT = 2_000_000_000_000n; // 2 PAS
const ZERO_H160 = "0x0000000000000000000000000000000000000000";

const GAS_MULTIPLIER = 4n;
const DEFAULT_REF_TIME = 5_000_000_000n;
const DEFAULT_PROOF_SIZE = 500_000n;

interface DryRunResult {
    success: boolean;
    gasConsumed: { refTime: bigint; proofSize: bigint };
    storageDeposit: bigint;
    returnData: `0x${string}`;
}

const mappedAccounts = new Set<string>();

function bytesToHex(data: unknown): `0x${string}` {
    if (data instanceof Uint8Array) {
        return `0x${Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    }

    const maybeBinary = data as
        | { asHex?: () => string; asBytes?: () => Uint8Array }
        | null
        | undefined;
    const asHex = maybeBinary?.asHex?.();
    if (asHex?.startsWith("0x")) return asHex as `0x${string}`;

    const asBytes = maybeBinary?.asBytes?.();
    if (asBytes) return bytesToHex(asBytes);

    return "0x";
}

function toBigInt(value: unknown): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    return 0n;
}

function chargedStorageDeposit(value: unknown): bigint {
    const deposit = value as { type?: string; value?: unknown } | null | undefined;
    if (deposit?.type === "Charge") return toBigInt(deposit.value);
    if (deposit?.type === "Refund") return 0n;
    return toBigInt(value);
}

// ── Transaction submission with stale-nonce retry ────────────────────────────
//
// AH-Next's known "nonce_stale flake": after a sequence of extrinsics (and
// especially after the ~66s commit→reveal idle wait), the chainHead view PAPI
// reads the nonce from can lag behind the real chain tip, so the next tx is
// signed with an already-consumed nonce → `InvalidTransaction::Stale`. The
// reference deployers (bulletin-deploy `signAndSubmitWithRetry`, playground-cli
// `atBest` nonce) handle this by rebuilding + resubmitting with a fresh nonce
// and a jittered backoff that lets the view catch up. We mirror that here.

const MAX_TX_ATTEMPTS = 5;

// Mirror of bulletin-deploy's dotnsRetryBackoffMs: full-ish jitter (50–100% of
// an exponential ceiling, base 400ms, capped 6s) so concurrent retries don't
// re-collide on the same nonce tick.
function retryBackoffMs(attempt: number): number {
    const ceil = Math.min(400 * 2 ** (attempt - 1), 6000);
    return Math.round(ceil * (0.5 + Math.random() * 0.5));
}

// Whether a failed submission is safe to resubmit with a fresh nonce.
//
// CRITICAL: on-chain dispatch failures are TERMINAL and must never be retried.
// submit-and-wait wraps those as `Transaction failed: <dispatchError JSON>`
// (this covers ContractReverted, Revive.OutOfGas, name-taken, expired
// commitment, …). Excluding that prefix FIRST is what stops the substring
// checks below from false-matching a module-error whose serialized JSON merely
// happens to contain "stale"/"dropped" — and, just as importantly, it
// guarantees every case we DO retry is one where the extrinsic was never
// included (rejected at validation or dropped from the pool). That makes the
// rebuild-with-fresh-nonce resubmit idempotent: it cannot double-execute an
// extrinsic that actually landed (which is the only way `register` could be
// re-run and revert with "name taken").
function isRetriableTxError(message: string): boolean {
    if (message.startsWith("Transaction failed:")) return false;
    const m = message.toLowerCase();
    return (
        // InvalidTransaction::Stale / Future — nonce signed against a lagging
        // chainHead view; rejected at validation, never included. (The
        // stale-nonce flake this retry exists for.)
        m.includes("stale") ||
        m.includes("future") ||
        // Pool dropped / declared the tx invalid → not included.
        m.includes("transaction dropped") ||
        m.includes("transaction invalid")
    );
}

// Build-and-submit with stale-nonce retry. `buildTx` is called fresh per attempt
// so PAPI recomputes the nonce against the current view each time.
async function submitTxWithRetry(
    buildTx: () => Parameters<typeof submitAndWait>[0],
    signer: PolkadotSigner,
    onStatus: ((status: DeployStatus) => void) | undefined,
    label: string,
): Promise<{ blockHash: string; blockNumber: number }> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await submitAndWait(buildTx(), signer, onStatus);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (attempt < MAX_TX_ATTEMPTS && isRetriableTxError(message)) {
                const delay = retryBackoffMs(attempt);
                console.warn(
                    `[dotns] ${label} attempt ${attempt}/${MAX_TX_ATTEMPTS} failed ` +
                        `(${message.slice(0, 100)}); retrying in ${delay}ms with a fresh nonce`,
                );
                // Re-signing happens on the next iteration; surface it as another
                // "signing" tick so the UI doesn't look frozen.
                onStatus?.("signing");
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
}

export async function ensureAccountMapped(
    signerAddress: string,
    signer: PolkadotSigner,
): Promise<void> {
    if (mappedAccounts.has(signerAddress)) return;

    const { unsafeApi } = await getAssetHubClient();

    // Probe: a dry-run against the zero address. If the account is unmapped,
    // pallet-revive returns AccountUnmapped — much faster than checking storage.
    try {
        const test = await unsafeApi.apis.ReviveApi.call(
            signerAddress,
            ZERO_H160,
            0n,
            { ref_time: MAX_WEIGHT, proof_size: MAX_WEIGHT },
            MAX_WEIGHT,
            Binary.fromHex("0x"),
        );
        const r = test as {
            result?: {
                value?: {
                    type?: string;
                    value?: { type?: string; value?: { type?: string } };
                };
            };
        };
        const isUnmapped =
            r.result?.value?.type === "Module" &&
            r.result?.value?.value?.type === "Revive" &&
            r.result?.value?.value?.value?.type === "AccountUnmapped";
        if (!isUnmapped) {
            mappedAccounts.add(signerAddress);
            return;
        }
    } catch {
        // fall through to mapping
    }

    await submitTxWithRetry(
        () => unsafeApi.tx.Revive.map_account(),
        signer,
        undefined,
        "map_account",
    );

    // Poll until the mapping propagates (usually 1-2 blocks).
    for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
            const check = await unsafeApi.apis.ReviveApi.call(
                signerAddress,
                ZERO_H160,
                0n,
                undefined,
                undefined,
                Binary.fromHex("0x"),
            );
            const c = check as {
                result?: {
                    value?: {
                        type?: string;
                        value?: { type?: string; value?: { type?: string } };
                    };
                };
            };
            const stillUnmapped =
                c.result?.value?.type === "Module" &&
                c.result?.value?.value?.type === "Revive" &&
                c.result?.value?.value?.value?.type === "AccountUnmapped";
            if (!stillUnmapped) {
                mappedAccounts.add(signerAddress);
                return;
            }
        } catch {
            // keep retrying
        }
    }

    throw new Error("Account mapping did not propagate after multiple attempts");
}

export async function dryRunContractCall(
    contractAddress: string,
    callerAddress: string,
    encodedData: `0x${string}`,
    value: bigint = 0n,
): Promise<DryRunResult> {
    const { unsafeApi } = await getAssetHubClient();

    const dryRun = await unsafeApi.apis.ReviveApi.call(
        callerAddress,
        contractAddress.toLowerCase() as `0x${string}`,
        value,
        { ref_time: MAX_WEIGHT, proof_size: MAX_WEIGHT },
        MAX_WEIGHT,
        Binary.fromHex(encodedData),
    );

    const r = dryRun as {
        result?: {
            success?: boolean;
            value?: { flags?: number; data?: unknown };
        };
        weight_required?: {
            ref_time?: bigint | number;
            proof_size?: bigint | number;
        };
        storage_deposit?: unknown;
    };

    const flags = r.result?.value?.flags ?? 0;
    const success = r.result?.success === true && !(flags & 1);

    return {
        success,
        gasConsumed: {
            refTime: BigInt(r.weight_required?.ref_time ?? 0),
            proofSize: BigInt(r.weight_required?.proof_size ?? 0),
        },
        storageDeposit: chargedStorageDeposit(r.storage_deposit),
        returnData: bytesToHex(r.result?.value?.data),
    };
}

export async function submitContractCall(
    contractAddress: string,
    signer: PolkadotSigner,
    encodedData: `0x${string}`,
    value: bigint = 0n,
    gasEstimate?: { refTime: bigint; proofSize: bigint },
    storageDepositEstimate?: bigint,
    onStatus?: (status: DeployStatus) => void,
): Promise<{ blockHash: string; blockNumber: number }> {
    const { unsafeApi } = await getAssetHubClient();

    const refTime = gasEstimate ? gasEstimate.refTime * GAS_MULTIPLIER : DEFAULT_REF_TIME;
    const proofSize = gasEstimate
        ? gasEstimate.proofSize * GAS_MULTIPLIER
        : DEFAULT_PROOF_SIZE;

    let storageDeposit = storageDepositEstimate
        ? storageDepositEstimate + storageDepositEstimate / 5n
        : MIN_STORAGE_DEPOSIT;
    if (storageDeposit < MIN_STORAGE_DEPOSIT) storageDeposit = MIN_STORAGE_DEPOSIT;

    // Rebuilt fresh on each retry attempt so PAPI recomputes the nonce against
    // the current chainHead view (the stale-nonce flake fix).
    return submitTxWithRetry(
        () =>
            unsafeApi.tx.Revive.call({
                // `dest` is a SizedHex<20> (branded plain string), not a Binary
                // class instance. Pallet-revive accepts the lowercase hex.
                dest: contractAddress.toLowerCase() as `0x${string}`,
                value,
                weight_limit: { ref_time: refTime, proof_size: proofSize },
                storage_deposit_limit: storageDeposit,
                data: Binary.fromHex(encodedData),
            }),
        signer,
        onStatus,
        `Revive.call(${contractAddress.slice(0, 10)}…)`,
    );
}
