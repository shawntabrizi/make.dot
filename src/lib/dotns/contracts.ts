// Pallet-revive bridge: dry-run a contract call, submit a contract call,
// and (one-time per account) ensure the SS58 → H160 mapping exists.
//
// Patterns adapted from dotdot-deployer. The 4x gas multiplier + minimum
// 2 PAS storage deposit defaults are inherited from the DotNS SDK reference.

import { decodeAbiParameters } from "viem";
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

/**
 * Read-only probe: dry-run against the zero address. If the account is
 * unmapped, pallet-revive returns AccountUnmapped — much faster than
 * checking storage. Used standalone by pre-flight and by ensureAccountMapped.
 */
export async function isAccountMapped(signerAddress: string): Promise<boolean> {
    if (mappedAccounts.has(signerAddress)) return true;
    const { unsafeApi } = getAssetHubClient();
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
    if (!isUnmapped) mappedAccounts.add(signerAddress);
    return !isUnmapped;
}

export async function ensureAccountMapped(
    signerAddress: string,
    signer: PolkadotSigner,
): Promise<void> {
    if (mappedAccounts.has(signerAddress)) return;

    const { api } = getAssetHubClient();

    try {
        if (await isAccountMapped(signerAddress)) return;
    } catch {
        // fall through to mapping
    }

    const tx = api.tx.Revive.map_account();
    await submitAndWait(tx, signer);

    // Poll until the mapping propagates. submitAndWait resolved at in-block,
    // so the mapping is usually visible immediately — probe right away, then
    // every 1s (was: a blind 3s sleep before the first check, 3s interval).
    // Same ~60s ceiling as before.
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            if (await isAccountMapped(signerAddress)) return;
        } catch {
            // keep retrying
        }
        await new Promise((r) => setTimeout(r, 1000));
    }

    throw new Error("Account mapping did not propagate after multiple attempts");
}

export async function dryRunContractCall(
    contractAddress: string,
    callerAddress: string,
    encodedData: `0x${string}`,
    value: bigint = 0n,
): Promise<DryRunResult> {
    const { unsafeApi } = getAssetHubClient();

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

/** First 4 bytes of revert data — the custom-error selector. */
export function revertSelector(returnData: `0x${string}`): string | null {
    return returnData.length >= 10 ? returnData.slice(0, 10).toLowerCase() : null;
}

// The registrar controller's custom errors (selector = keccak of signature).
const KNOWN_ERRORS: Record<string, { name: string; arg?: "bytes32" | "string" | "uint256" }> = {
    "0x836588c9": { name: "CommitmentNotFound", arg: "bytes32" },
    "0x5320bcf9": { name: "CommitmentTooNew", arg: "bytes32" },
    "0xcb7690d7": { name: "CommitmentTooOld", arg: "bytes32" },
    "0x0a059d71": { name: "UnexpiredCommitmentExists", arg: "bytes32" },
    "0x477707e8": { name: "NameNotAvailable", arg: "string" },
    "0x11011294": { name: "InsufficientValue" },
    "0x9a71997b": { name: "DurationTooShort", arg: "uint256" },
};

/**
 * Best-effort human form of a reverted dry-run's return data. Solidity
 * `revert("reason")` encodes as Error(string) (selector 0x08c379a0);
 * known registrar custom errors decode by name; anything else is surfaced
 * as raw hex so it's at least greppable.
 */
export function describeRevert(returnData: `0x${string}`): string {
    if (returnData.startsWith("0x08c379a0")) {
        try {
            const [reason] = decodeAbiParameters(
                [{ type: "string" }],
                `0x${returnData.slice(10)}` as `0x${string}`,
            );
            return reason as string;
        } catch {
            // fall through to raw hex
        }
    }
    const selector = revertSelector(returnData);
    const known = selector ? KNOWN_ERRORS[selector] : undefined;
    if (known) {
        if (!known.arg) return known.name;
        try {
            const [arg] = decodeAbiParameters(
                [{ type: known.arg }],
                `0x${returnData.slice(10)}` as `0x${string}`,
            );
            return `${known.name}(${String(arg)})`;
        } catch {
            return known.name;
        }
    }
    return returnData === "0x" ? "no revert data" : returnData;
}

/**
 * Gate a paid submission on its dry-run: a COMPLETED dry-run that reports
 * failure means the chain will revert the real call — submitting anyway
 * burns fees for a guaranteed failure. (A dry-run that THROWS — transport
 * failure — propagates from dryRunContractCall before reaching this point,
 * which is the correct distinction: don't pay for known reverts, but don't
 * let this helper be the place that swallows RPC errors either.)
 */
export function assertDryRunOk(
    result: DryRunResult,
    what: string,
): asserts result is DryRunResult & { success: true } {
    if (!result.success) {
        throw new Error(`${what} would revert — not submitting. ${describeRevert(result.returnData)}`);
    }
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
    const { api } = getAssetHubClient();

    const refTime = gasEstimate ? gasEstimate.refTime * GAS_MULTIPLIER : DEFAULT_REF_TIME;
    const proofSize = gasEstimate
        ? gasEstimate.proofSize * GAS_MULTIPLIER
        : DEFAULT_PROOF_SIZE;

    let storageDeposit = storageDepositEstimate
        ? storageDepositEstimate + storageDepositEstimate / 5n
        : MIN_STORAGE_DEPOSIT;
    if (storageDeposit < MIN_STORAGE_DEPOSIT) storageDeposit = MIN_STORAGE_DEPOSIT;

    const tx = api.tx.Revive.call({
        // Descriptor types `dest` as SizedHex<20> (branded plain string), not
        // a Binary class instance. Pallet-revive accepts the lowercase hex.
        dest: contractAddress.toLowerCase() as `0x${string}`,
        value,
        weight_limit: { ref_time: refTime, proof_size: proofSize },
        storage_deposit_limit: storageDeposit,
        data: Binary.fromHex(encodedData),
    });

    return submitAndWait(tx, signer, onStatus);
}
