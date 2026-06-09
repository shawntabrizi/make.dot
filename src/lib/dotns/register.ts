// Commit-reveal DotNS registration flow. ENS-style — front-running protection
// via a 60s commitment age.

import { encodeFunctionData, decodeFunctionResult, decodeErrorResult } from "viem";
import type { PolkadotSigner } from "polkadot-api";
import { DOTNS_CONTRACTS, NATIVE_TO_ETH_RATIO } from "../polkadot/constants.ts";
import { POP_RULES_ABI, REGISTRAR_CONTROLLER_ABI, REGISTRY_ABI } from "./abis.ts";
import { labelToFullName, namehash } from "./namehash.ts";
import { dryRunContractCall, ensureAccountMapped, submitContractCall } from "./contracts.ts";

// Turn pallet-revive revert bytes into a human reason. Handles the standard
// Solidity `Error(string)` / `Panic(uint256)` (viem knows these built-in) and
// any custom errors declared in the ABI; otherwise surfaces the 4-byte selector
// so it can be looked up. Lets us fail the register pre-flight with the ACTUAL
// reason instead of a bare "ContractReverted".
function decodeRevertReason(returnData: `0x${string}`): string {
    if (!returnData || returnData === "0x") {
        return "contract reverted without a reason string";
    }
    try {
        const decoded = decodeErrorResult({ abi: REGISTRAR_CONTROLLER_ABI, data: returnData });
        if (decoded.errorName === "Error") return String(decoded.args?.[0] ?? "Error");
        const args = (decoded.args ?? []) as unknown[];
        return `${decoded.errorName}(${args.map(String).join(", ")})`;
    } catch {
        return `unrecognised revert (selector ${returnData.slice(0, 10)})`;
    }
}

function generateSecret(): `0x${string}` {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return ("0x" +
        Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")) as `0x${string}`;
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

async function getDomainPrice(
    label: string,
    ownerEvmAddress: `0x${string}`,
    callerAddress: string,
): Promise<bigint> {
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
        if (!fbResult.success) return 0n;
        return decodeFunctionResult({
            abi: POP_RULES_ABI,
            functionName: "price",
            data: fbResult.returnData,
        });
    }

    const metadata = decodeFunctionResult({
        abi: POP_RULES_ABI,
        functionName: "priceWithoutCheck",
        data: result.returnData,
    }) as { price: bigint; status: number; userStatus: number; message: string };
    return metadata.price;
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

export async function registerDomain(params: {
    label: string;
    ownerEvmAddress: `0x${string}`;
    signerAddress: string;
    signer: PolkadotSigner;
    onStatus?: (status: string) => void;
}): Promise<void> {
    const { label, ownerEvmAddress, signerAddress, signer, onStatus } = params;

    onStatus?.("Mapping account on Asset Hub…");
    await ensureAccountMapped(signerAddress, signer);

    const secret = generateSecret();
    const registration = { label, owner: ownerEvmAddress, secret, reserved: false } as const;

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

    // 3. Wait through the commitment age. Front-running protection — the
    // protocol REQUIRES this delay.
    const minAge = await getMinCommitmentAge(signerAddress);
    const totalWait = minAge + 6; // safety buffer per DotNS SDK
    for (let remaining = totalWait; remaining > 0; remaining--) {
        onStatus?.(`Waiting ${remaining}s for commitment age…`);
        await new Promise((r) => setTimeout(r, 1000));
    }

    // 4. Register with the priced payment value.
    onStatus?.("Pricing domain…");
    const priceWei = await getDomainPrice(label, ownerEvmAddress, signerAddress);
    const bufferedWei = (priceWei * 110n) / 100n; // 10% buffer per DotNS SDK
    // Ceil, not floor: BigInt division floors, so any positive price below the
    // ratio (<1e8 wei) would round to 0 native → underpay → revert. Round up so
    // a positive price always pays at least 1 planck (a free name stays 0).
    const bufferedNative =
        bufferedWei === 0n
            ? 0n
            : (bufferedWei + NATIVE_TO_ETH_RATIO - 1n) / NATIVE_TO_ETH_RATIO;

    const registerData = encodeFunctionData({
        abi: REGISTRAR_CONTROLLER_ABI,
        functionName: "register",
        args: [registration],
    });
    const registerGas = await dryRunContractCall(
        DOTNS_CONTRACTS.registrarController,
        signerAddress,
        registerData,
        bufferedNative,
    );
    // Pre-flight: if the dry-run reverts, submitting on-chain will revert the
    // same way (identical value + data). Fail now with the decoded reason
    // instead of burning a real tx + fee on a doomed register.
    if (!registerGas.success) {
        throw new Error(
            `Registration would revert: ${decodeRevertReason(registerGas.returnData)} ` +
                `(label "${label}", price ${bufferedWei} wei → ${bufferedNative} native).`,
        );
    }
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
