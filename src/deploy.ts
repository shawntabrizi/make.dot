// Deploy orchestrator. Threads the three phases together:
//   1. Bulletin TransactionStorage.store (data → CID)
//   2. DotNS register (label → owned)
//   3. DotNS setContenthash (CID ↔ label)
//
// Host/extension submission is live; allowance gating is enforced in App.tsx.

import { calculateCid } from "@parity/product-sdk-cloud-storage";
import { storeBytes, storeHTML } from "./lib/bulletin/store.ts";
import { getEvmAddress } from "./lib/dotns/address.ts";
import { registerDomain, checkDomainAvailability } from "./lib/dotns/register.ts";
import { setContentHash } from "./lib/dotns/content-hash.ts";
import { getRegistryContract } from "./lib/registry/contracts.ts";
import { BULLETIN_GATEWAY } from "./lib/polkadot/constants.ts";
import type { ActiveAccount } from "./account.ts";

// Profile metadata listed in the playground registry. Mirrors playground-app's
// shape — `name` required; `description` optional. Other fields the registry
// accepts (repository, icon_cid, tag) aren't meaningful for a profile page.
export interface DeployMetadata {
    name: string;
    description?: string;
}

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
    blockHash: string | null;
    blockNumber: number;
    /** True iff DotNS register + setContenthash both succeeded — `<name>.dot.li` resolves. */
    dotMapped: boolean;
    /** Reason DotNS failed, if it did. Null when dotMapped===true. */
    dotError: string | null;
    /** True iff the site was published to the playground registry (shows in playground.dot's grid). */
    listed: boolean;
    /** Reason the registry publish failed, if it did. Null when listed===true. */
    registryError: string | null;
}

export type StatusFn = (message: string) => void;

// ── Common helpers ──────────────────────────────────────────────────────────

// Auto-derive a NoStatus-shape label from the rendered header text. Matches
// `dot decentralize`'s rule: base ≥9 + exactly 2 trailing digits → NoStatus.
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

// ── Preview (no chain submission, host/extension fallback) ──────────────────

export async function previewDeploy(html: string, domain: string | null): Promise<DeployPreview> {
    const bytes = new TextEncoder().encode(html);
    const cid = (await calculateCid(bytes)).toString();
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

// ── Real end-to-end deploy (//Bob path) ─────────────────────────────────────

export async function deployFull(
    html: string,
    domain: string | null,
    account: ActiveAccount,
    onStatus: StatusFn,
    metadata?: DeployMetadata,
): Promise<DeploySuccess> {
    const finalLabel = (domain ?? "").replace(/\.dot$/i, "") || deriveDomain(html.slice(0, 64));

    // Phase 1 — Bulletin store
    onStatus("Bulletin: connecting…");
    const stored = await storeHTML({
        html,
        signerAddress: account.address,
        displayName: account.displayName,
        onStatus: (s) => onStatus(`Bulletin: ${s}`),
    });

    // Phase 2 — DotNS register + setContenthash. Best-effort: if either fails
    // we still return a successful Bulletin store with `dotMapped: false`, so
    // the user has their CID and gateway URL even if AH-Next refused. The
    // error message is captured on `dotError` so the UI can show what
    // actually went wrong and (where possible) what to do about it.
    let dotMapped = false;
    let dotError: string | null = null;
    // Track the exact sub-step so a failure tells us WHERE (the on-screen hint
    // and host-console only get the message string — the host bridge serializes
    // Errors to `.toString()`, dropping the stack — so we carry both ourselves).
    let dotStep = "starting";
    try {
        dotStep = "getEvmAddress (ReviveApi.address)";
        onStatus("DotNS: resolving owner H160…");
        const ownerEvmAddress = await getEvmAddress(account.address);

        dotStep = "checkDomainAvailability (dry-run recordExists)";
        onStatus("DotNS: checking domain availability…");
        const available = await checkDomainAvailability(finalLabel, account.address);
        if (!available) {
            throw new Error(`Domain ${finalLabel}.dot is already registered. Pick another name.`);
        }

        // Submission gating (host allowances) lives in App.tsx deploy().
        dotStep = "registerDomain (map_account + commit + register)";
        await registerDomain({
            label: finalLabel,
            ownerEvmAddress,
            signerAddress: account.address,
            signer: account.signer,
            onStatus: (s) => {
                dotStep = `registerDomain: ${s}`;
                onStatus(`DotNS register: ${s}`);
            },
        });

        dotStep = "setContentHash";
        await setContentHash({
            label: finalLabel,
            cidString: stored.cid,
            signerAddress: account.address,
            signer: account.signer,
            onStatus: (s) => {
                dotStep = `setContentHash: ${s}`;
                onStatus(`DotNS resolver: ${s}`);
            },
        });

        dotMapped = true;
    } catch (cause) {
        // Log step + full stack AS A STRING. Passing the Error object loses the
        // stack across the host's console bridge (it shows only the message), so
        // serialize `.stack` explicitly. This is what tells a client-side glitch
        // apart from a real on-chain dispatch error.
        const stack = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
        console.error(`DotNS phase failed at step [${dotStep}]:\n${stack}`);
        const rawMessage = cause instanceof Error ? cause.message : String(cause);
        dotError = `[step: ${dotStep}] ${rawMessage}`;
        onStatus(`DotNS step failed — Bulletin store still succeeded. ${rawMessage}`);
        // Don't rethrow: surface the partial-success to the caller so the UI
        // can show the gateway URL even when the name mapping fell over.
    }

    // Phase 3 — playground-registry publish. Best-effort, same philosophy as
    // DotNS: a failure here never masks the successful Bulletin store / domain
    // registration above. On success the deployed profile shows up in
    // playground.dot's registry grid. The account is mapped on-chain during the
    // DotNS registerDomain step; if that was skipped/failed we still attempt
    // (the account may be mapped from a prior run) and just capture any error.
    let listed = false;
    let registryError: string | null = null;
    // Gated on dotMapped: the grid resolves a listing via its .dot name →
    // contenthash, so listing a name that didn't register makes a broken card.
    if (dotMapped) try {
        onStatus("Listing in playground registry…");

        // Metadata JSON — `name` falls back to the domain label when empty so
        // the registry entry always has a usable display name.
        const name = (metadata?.name ?? "").trim() || finalLabel;
        const description = metadata?.description?.trim() || undefined;
        const metadataBytes = new TextEncoder().encode(
            JSON.stringify({ name, description }),
        );

        onStatus("Registry: storing metadata…");
        const meta = await storeBytes({
            bytes: metadataBytes,
            signerAddress: account.address,
            displayName: account.displayName,
            label: "Metadata",
            onStatus: (s) => onStatus(`Registry metadata: ${s}`),
        });

        onStatus("Registry: publishing…");
        const registry = await getRegistryContract();
        // publish(domain, metadata_cid, visibility, owner, modded_from,
        //         is_moddable, is_dev_signer, opts). visibility=1 (public),
        //         owner None, modded_from "", is_moddable false,
        //         is_dev_signer false. Mirrors playground-app's runTx call;
        //         the signer is passed explicitly via the trailing opts. The
        //         contract handle is the generic fallback (codegen hasn't
        //         augmented `publish`), so we type the call narrowly here.
        const publish = (registry as unknown as {
            publish: {
                tx: (
                    domain: string,
                    metadataCid: string,
                    visibility: number,
                    owner: { isSome: boolean; value: string },
                    moddedFrom: string,
                    isModdable: boolean,
                    isDevSigner: boolean,
                    opts: {
                        signer: typeof account.signer;
                        gasLimit?: { ref_time: bigint; proof_size: bigint };
                        storageDepositLimit?: bigint;
                    },
                ) => Promise<{ ok: boolean }>;
            };
        }).publish;
        const result = await publish.tx(
            `${finalLabel}.dot`,
            meta.cid,
            1,
            { isSome: false, value: "0x0000000000000000000000000000000000000000" },
            "",
            false,
            false,
            {
                signer: account.signer,
                // Override ContractManager's auto-estimator: it returns a tight,
                // margin-free weight → the publish (a heavy PolkaVM storage write,
                // comparable to playground-app's setUsername) hit Revive.OutOfGas.
                // Give it (just under) AH-Next's per-normal-extrinsic ceiling
                // (ref_time ~1.599e12 / proof_size ~8.39e6) for maximum headroom;
                // unused weight isn't charged. storageDepositLimit mirrors the
                // proven DotNS register value.
                gasLimit: { ref_time: 1_590_000_000_000n, proof_size: 8_000_000n },
                storageDepositLimit: 2_000_000_000_000n,
            },
        );
        if (!result.ok) throw new Error("Registry publish transaction failed (result.ok=false)");

        listed = true;
    } catch (cause) {
        console.error("Registry phase failed:", cause);
        registryError = cause instanceof Error ? cause.message : String(cause);
        onStatus(`Registry listing failed — site still deployed. ${registryError}`);
        // Don't rethrow: the Bulletin store + domain already succeeded.
    } else {
        registryError =
            "Skipped — the .dot name didn't register, so the registry has nothing to resolve.";
    }

    return {
        kind: "stored",
        bytes: stored.bytes,
        cid: stored.cid,
        domain: finalLabel,
        url: `https://${finalLabel}.dot.li`,
        gatewayUrl: stored.ipfsUrl,
        blockHash: stored.blockHash,
        blockNumber: stored.blockNumber,
        dotMapped,
        dotError,
        listed,
        registryError,
    };
}
