// Deploy orchestrator. Threads the three phases together:
//   1. Bulletin TransactionStorage.store (data → CID)
//   2. DotNS register (label → owned)
//   3. DotNS setContenthash (CID ↔ label)
//
// All account sources (host / extension / dev) submit for real — readiness
// is judged up front by src/preflight.ts, not by gating the deploy path.

import { storeHTML } from "./lib/bulletin/store.ts";
import { getEvmAddress } from "./lib/dotns/address.ts";
import { registerDomain, checkDomainAvailability } from "./lib/dotns/register.ts";
import { setContentHash } from "./lib/dotns/content-hash.ts";
import { DOT_HOST } from "./lib/polkadot/constants.ts";
import type { ActiveAccount } from "./account.ts";

export interface DeploySuccess {
    kind: "stored";
    bytes: number;
    cid: string;
    domain: string;
    url: string;
    gatewayUrl: string;
    /** Null on the host preimage route — the host doesn't report inclusion. */
    blockHash: string | null;
    blockNumber: number | null;
    /** True iff DotNS register + setContenthash both succeeded — `<name>.dot.li` resolves. */
    dotMapped: boolean;
    /** Reason DotNS failed, if it did. Null when dotMapped===true. */
    dotError: string | null;
}

export type StatusFn = (message: string) => void;

// ── Common helpers ──────────────────────────────────────────────────────────

// Auto-derive a NoStatus-shape label from the rendered header text. Matches
// `dot decentralize`'s rule: base ≥9 + exactly 2 trailing digits → NoStatus.
export function deriveDomain(seed: string): string {
    let s = seed
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // strip diacritics: café → cafe, not caf-
        .toLowerCase()
        .replace(/['’`´]/g, "") // sveta's → svetas, not sveta-s
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

// ── Real end-to-end deploy ──────────────────────────────────────────────────

// `finalLabel` is the already-resolved label (typed or auto-derived) — the
// caller resolves it once so pre-flight checks and the deploy agree on the
// exact name being registered.
export async function deployFull(
    html: string,
    finalLabel: string,
    account: ActiveAccount,
    onStatus: StatusFn,
): Promise<DeploySuccess> {
    // Phase 1 — Bulletin store
    onStatus("Bulletin: connecting…");
    const stored = await storeHTML({
        html,
        signer: account.signer,
        signerAddress: account.address,
        displayName: account.displayName,
        viaHost: account.source === "host",
        onStatus: (s) => onStatus(`Bulletin: ${s}`),
    });

    // Phase 2 — DotNS register + setContenthash. Best-effort: if either fails
    // we still return a successful Bulletin store with `dotMapped: false`, so
    // the user has their CID and gateway URL even if AH-Next refused. The
    // error message is captured on `dotError` so the UI can show what
    // actually went wrong and (where possible) what to do about it.
    let dotMapped = false;
    let dotError: string | null = null;
    try {
        onStatus("DotNS: resolving owner H160…");
        const ownerEvmAddress = await getEvmAddress(account.address);

        onStatus("DotNS: checking domain availability…");
        const available = await checkDomainAvailability(finalLabel, account.address);
        if (!available) {
            throw new Error(`Domain ${finalLabel}.dot is already registered. Pick another name.`);
        }

        await registerDomain({
            label: finalLabel,
            ownerEvmAddress,
            signerAddress: account.address,
            signer: account.signer,
            onStatus: (s) => onStatus(`DotNS register: ${s}`),
        });

        await setContentHash({
            label: finalLabel,
            cidString: stored.cid,
            signerAddress: account.address,
            signer: account.signer,
            onStatus: (s) => onStatus(`DotNS resolver: ${s}`),
        });

        dotMapped = true;
    } catch (cause) {
        dotError = cause instanceof Error ? cause.message : String(cause);
        onStatus(`DotNS step failed — Bulletin store still succeeded. ${dotError}`);
        // Don't rethrow: surface the partial-success to the caller so the UI
        // can show the gateway URL even when the name mapping fell over.
    }

    return {
        kind: "stored",
        bytes: stored.bytes,
        cid: stored.cid,
        domain: finalLabel,
        url: `https://${finalLabel}.${DOT_HOST}`,
        gatewayUrl: stored.ipfsUrl,
        blockHash: stored.blockHash,
        blockNumber: stored.blockNumber,
        dotMapped,
        dotError,
    };
}
