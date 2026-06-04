// Commit-reveal DotNS registration flow. ENS-style — front-running protection
// via a 60s commitment age.

import { encodeFunctionData, decodeFunctionResult } from "viem";
import type { PolkadotSigner } from "polkadot-api";
import { DOTNS_CONTRACTS, NATIVE_TO_ETH_RATIO } from "../polkadot/constants.ts";
import { POP_RULES_ABI, REGISTRAR_CONTROLLER_ABI, REGISTRY_ABI } from "./abis.ts";
import { labelToFullName, namehash } from "./namehash.ts";
import {
    assertDryRunOk,
    dryRunContractCall,
    ensureAccountMapped,
    revertSelector,
    submitContractCall,
} from "./contracts.ts";

function generateSecret(): `0x${string}` {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return ("0x" +
        Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")) as `0x${string}`;
}

/**
 * Current registry owner (H160) of `label`.dot, or null when unregistered /
 * the probe fails. Lets the deploy flow route "already registered to YOU"
 * to a plain setContenthash update instead of refusing.
 */
export async function getDomainOwner(
    label: string,
    callerAddress: string,
): Promise<`0x${string}` | null> {
    const node = namehash(labelToFullName(label));
    const encoded = encodeFunctionData({
        abi: REGISTRY_ABI,
        functionName: "owner",
        args: [node],
    });
    const result = await dryRunContractCall(DOTNS_CONTRACTS.registry, callerAddress, encoded);
    if (!result.success) return null;
    return decodeFunctionResult({
        abi: REGISTRY_ABI,
        functionName: "owner",
        data: result.returnData,
    }) as `0x${string}`;
}

export async function checkDomainAvailability(
    label: string,
    callerAddress: string,
): Promise<boolean> {
    const node = namehash(labelToFullName(label));
    const encoded = encodeFunctionData({
        abi: REGISTRY_ABI,
        functionName: "recordExists",
        args: [node],
    });

    const result = await dryRunContractCall(DOTNS_CONTRACTS.registry, callerAddress, encoded);
    if (!result.success) return true; // assume available when probe fails

    const exists = decodeFunctionResult({
        abi: REGISTRY_ABI,
        functionName: "recordExists",
        data: result.returnData,
    });
    return !exists;
}

export interface DomainQuote {
    /** Price in Wei (18 decimals). Null when neither price probe succeeded. */
    price: bigint | null;
    /** The name's requirement tier (0 = available to all; probed empirically:
     *  1 = Lite personhood, 3 = governance-reserved). Null on fallback path. */
    status: number | null;
    /** The caller's verification tier — registrable when userStatus >= status. */
    userStatus: number | null;
    /** PoP-rules classification message (present even on success,
     *  e.g. "Available to all"). */
    message: string | null;
}

/** Read-only price + PoP-rules verdict — used by pre-flight and register. */
export async function quoteDomain(
    label: string,
    ownerEvmAddress: `0x${string}`,
    callerAddress: string,
): Promise<DomainQuote> {
    const encoded = encodeFunctionData({
        abi: POP_RULES_ABI,
        functionName: "priceWithoutCheck",
        args: [label, ownerEvmAddress],
    });
    const result = await dryRunContractCall(DOTNS_CONTRACTS.popRules, callerAddress, encoded);

    if (!result.success) {
        // Fallback: simpler price() lookup.
        const fallback = encodeFunctionData({
            abi: POP_RULES_ABI,
            functionName: "price",
            args: [label],
        });
        const fbResult = await dryRunContractCall(
            DOTNS_CONTRACTS.popRules,
            callerAddress,
            fallback,
        );
        if (!fbResult.success) return { price: null, status: null, userStatus: null, message: null };
        const price = decodeFunctionResult({
            abi: POP_RULES_ABI,
            functionName: "price",
            data: fbResult.returnData,
        });
        return { price, status: null, userStatus: null, message: null };
    }

    const metadata = decodeFunctionResult({
        abi: POP_RULES_ABI,
        functionName: "priceWithoutCheck",
        data: result.returnData,
    }) as { price: bigint; status: number; userStatus: number; message: string };
    return {
        price: metadata.price,
        status: metadata.status,
        userStatus: metadata.userStatus,
        message: metadata.message || null,
    };
}

async function getDomainPrice(
    label: string,
    ownerEvmAddress: `0x${string}`,
    callerAddress: string,
): Promise<bigint> {
    return (await quoteDomain(label, ownerEvmAddress, callerAddress)).price ?? 0n;
}

async function getMinCommitmentAge(callerAddress: string): Promise<number> {
    const encoded = encodeFunctionData({
        abi: REGISTRAR_CONTROLLER_ABI,
        functionName: "minCommitmentAge",
    });
    const result = await dryRunContractCall(
        DOTNS_CONTRACTS.registrarController,
        callerAddress,
        encoded,
    );
    if (!result.success) return 60;
    const age = decodeFunctionResult({
        abi: REGISTRAR_CONTROLLER_ABI,
        functionName: "minCommitmentAge",
        data: result.returnData,
    });
    return Number(age);
}

export interface DomainCommitment {
    registration: {
        label: string;
        owner: `0x${string}`;
        secret: `0x${string}`;
        reserved: boolean;
    };
    /** Seconds until the registrar accepts the reveal (minAge + safety buffer). */
    totalWait: number;
}

/**
 * Commit-reveal phase 1: map the account if needed and land the commitment.
 * Split from the reveal so the caller can overlap the mandatory commitment
 * age (~60s) with independent work — e.g. the Bulletin store.
 */
export async function commitDomain(params: {
    label: string;
    ownerEvmAddress: `0x${string}`;
    signerAddress: string;
    signer: PolkadotSigner;
    onStatus?: (status: string) => void;
}): Promise<DomainCommitment> {
    const { label, ownerEvmAddress, signerAddress, signer, onStatus } = params;

    onStatus?.("Mapping account on Asset Hub…");
    await ensureAccountMapped(signerAddress, signer);

    const secret = generateSecret();
    const registration = { label, owner: ownerEvmAddress, secret, reserved: false };

    // 1. Compute commitment (read-only)
    onStatus?.("Computing commitment…");
    const makeCommitmentData = encodeFunctionData({
        abi: REGISTRAR_CONTROLLER_ABI,
        functionName: "makeCommitment",
        args: [registration],
    });
    const commitmentResult = await dryRunContractCall(
        DOTNS_CONTRACTS.registrarController,
        signerAddress,
        makeCommitmentData,
    );
    if (!commitmentResult.success) {
        throw new Error("Failed to compute commitment");
    }
    const commitment = decodeFunctionResult({
        abi: REGISTRAR_CONTROLLER_ABI,
        functionName: "makeCommitment",
        data: commitmentResult.returnData,
    });

    // 2. Submit commitment (extrinsic)
    onStatus?.("Submitting commitment…");
    const commitData = encodeFunctionData({
        abi: REGISTRAR_CONTROLLER_ABI,
        functionName: "commit",
        args: [commitment],
    });
    const commitGas = await dryRunContractCall(
        DOTNS_CONTRACTS.registrarController,
        signerAddress,
        commitData,
    );
    assertDryRunOk(commitGas, "Commitment");
    await submitContractCall(
        DOTNS_CONTRACTS.registrarController,
        signer,
        commitData,
        0n,
        commitGas.gasConsumed,
        commitGas.storageDeposit,
        (status) => {
            if (status === "signing") onStatus?.("Signing commitment…");
            if (status === "in-block") onStatus?.("Commitment confirmed");
        },
    );

    const minAge = await getMinCommitmentAge(signerAddress);
    return { registration, totalWait: minAge + 6 }; // safety buffer per DotNS SDK
}

/**
 * Commit-reveal phase 2: price and register. Only valid after the
 * commitment age from `commitDomain` has fully elapsed.
 */
export async function finishRegistration(params: {
    commitment: DomainCommitment;
    signerAddress: string;
    signer: PolkadotSigner;
    onStatus?: (status: string) => void;
}): Promise<void> {
    const { commitment, signerAddress, signer, onStatus } = params;
    const { registration } = commitment;

    onStatus?.("Pricing domain…");
    const priceWei = await getDomainPrice(
        registration.label,
        registration.owner,
        signerAddress,
    );
    const bufferedWei = (priceWei * 110n) / 100n; // 10% buffer per DotNS SDK
    const bufferedNative = bufferedWei / NATIVE_TO_ETH_RATIO;

    const registerData = encodeFunctionData({
        abi: REGISTRAR_CONTROLLER_ABI,
        functionName: "register",
        args: [registration],
    });
    let registerGas = await dryRunContractCall(
        DOTNS_CONTRACTS.registrarController,
        signerAddress,
        registerData,
        bufferedNative,
    );
    // CommitmentNotFound / CommitmentTooNew right after the wait is usually
    // TRANSIENT: the commit resolved at in-block, and a lagging RPC replica
    // (or a short reorg) may not show it yet. This got much more visible
    // when the registrar dropped minCommitmentAge from 60s to 6s — the wait
    // no longer hides settling time. Retry the (free) dry-run for up to
    // ~30s before declaring failure.
    const TRANSIENT = new Set([
        "0x836588c9", // CommitmentNotFound(bytes32)
        "0x5320bcf9", // CommitmentTooNew(bytes32)
        "0x74480cc9", // CommitmentTooNew(bytes32,uint256,uint256)
    ]);
    for (let attempt = 1; !registerGas.success && attempt <= 10; attempt++) {
        const selector = revertSelector(registerGas.returnData);
        if (!selector || !TRANSIENT.has(selector)) break;
        onStatus?.(`Commitment not visible yet — retrying (${attempt}/10)…`);
        await new Promise((r) => setTimeout(r, 3000));
        registerGas = await dryRunContractCall(
            DOTNS_CONTRACTS.registrarController,
            signerAddress,
            registerData,
            bufferedNative,
        );
    }
    // The expensive gate: a register that would revert must not be paid for.
    // The commitment is NOT consumed by this stop — it stays valid until
    // maxCommitmentAge, so a retry after fixing the cause still works.
    assertDryRunOk(registerGas, "Registration");
    await submitContractCall(
        DOTNS_CONTRACTS.registrarController,
        signer,
        registerData,
        bufferedNative,
        registerGas.gasConsumed,
        registerGas.storageDeposit,
        (status) => {
            if (status === "signing") onStatus?.("Signing registration…");
            if (status === "in-block") onStatus?.("Domain registered");
        },
    );
}
