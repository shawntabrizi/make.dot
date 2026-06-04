// Deploy orchestrator. Threads the three phases together:
//   1. Bulletin TransactionStorage.store (data → CID)
//   2. DotNS register (label → owned)
//   3. DotNS setContenthash (CID ↔ label)
//
// All account sources (host / extension / dev) submit for real — readiness
// is judged up front by src/preflight.ts, not by gating the deploy path.

import { storeHTML, type StoreHTMLResult } from "./lib/bulletin/store.ts";
import { getEvmAddress } from "./lib/dotns/address.ts";
import { ensureAccountMapped } from "./lib/dotns/contracts.ts";
import {
    checkDomainAvailability,
    commitDomain,
    finishRegistration,
    getDomainOwner,
} from "./lib/dotns/register.ts";
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

// Latin letters that DON'T decompose to base+combining under NFD, so the
// diacritic strip can't reach them. Non-Latin scripts (Cyrillic, CJK, …)
// have no cheap transliteration and fall through to the "hello" fallback.
const LATIN_SPECIALS: Record<string, string> = {
    ø: "o", ß: "ss", æ: "ae", œ: "oe", đ: "d", ð: "d", ħ: "h",
    ł: "l", ŋ: "n", þ: "th", ŧ: "t", ı: "i", ĸ: "k",
};

// Auto-derive a NoStatus-shape label from the rendered header text. Matches
// `dot decentralize`'s rule: base ≥9 + exactly 2 trailing digits → NoStatus.
export function deriveDomain(seed: string): string {
    let s = seed
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // strip diacritics: café → cafe, not caf-
        .toLowerCase()
        .replace(/[øßæœđðħłŋþŧıĸ]/g, (c) => LATIN_SPECIALS[c] ?? c)
        .replace(/['’‘`´ʼ]/g, "") // sveta's → svetas, not sveta-s
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
    // Pipelined: the DotNS commitment doesn't depend on the stored CID, so
    // for fresh names the Bulletin store runs CONCURRENTLY with the
    // protocol-mandated ~60s commitment age — removing the store entirely
    // from the critical path. Invariant preserved from the sequential
    // version: a store failure is a total failure (throw), while any DotNS
    // failure still returns partial success (`dotMapped: false`) so the
    // user keeps their CID and gateway URL.
    const doStore = (): Promise<StoreHTMLResult> => {
        onStatus("Bulletin: connecting…");
        return storeHTML({
            html,
            signer: account.signer,
            signerAddress: account.address,
            displayName: account.displayName,
            viaHost: account.source === "host",
            onStatus: (s) => onStatus(`Bulletin: ${s}`),
        });
    };
    const waitCommitmentAge = async (seconds: number) => {
        for (let remaining = seconds; remaining > 0; remaining--) {
            onStatus(`DotNS register: Waiting ${remaining}s for commitment age…`);
            await new Promise((r) => setTimeout(r, 1000));
        }
    };

    let stored: StoreHTMLResult;
    let dotMapped = false;
    let dotError: string | null = null;

    // ── Phase 1: DotNS prep (cheap dry-runs + commit tx). A failure here —
    // including "name belongs to someone else" — still delivers the bytes:
    // run the store and return partial success, matching the sequential
    // version's behavior.
    let commitment: Awaited<ReturnType<typeof commitDomain>> | null = null;
    try {
        onStatus("DotNS: resolving owner H160…");
        const ownerEvmAddress = await getEvmAddress(account.address);

        onStatus("DotNS: checking domain availability…");
        const available = await checkDomainAvailability(finalLabel, account.address);

        if (!available) {
            // Taken — but if it's taken by THIS account, this is a content
            // update: skip the commit-reveal registration (and its 60s+
            // wait) and go straight to repointing the contenthash.
            const currentOwner = await getDomainOwner(finalLabel, account.address);
            if (!currentOwner || currentOwner.toLowerCase() !== ownerEvmAddress.toLowerCase()) {
                throw new Error(
                    `Domain ${finalLabel}.dot is already registered` +
                        (currentOwner ? ` to ${currentOwner}` : "") +
                        ` (your account maps to ${ownerEvmAddress}). Pick another name.`,
                );
            }
            onStatus("DotNS: name already yours — updating content…");
            // commitDomain normally handles the one-time H160 mapping;
            // the update path needs it ensured before the resolver call.
            await ensureAccountMapped(account.address, account.signer);
        } else {
            commitment = await commitDomain({
                label: finalLabel,
                ownerEvmAddress,
                signerAddress: account.address,
                signer: account.signer,
                onStatus: (s) => onStatus(`DotNS register: ${s}`),
            });
        }
    } catch (cause) {
        dotError = cause instanceof Error ? cause.message : String(cause);
        stored = await doStore();
        onStatus(`DotNS step failed — Bulletin store still succeeded. ${dotError}`);
        return {
            kind: "stored",
            bytes: stored.bytes,
            cid: stored.cid,
            domain: finalLabel,
            url: `https://${finalLabel}.${DOT_HOST}`,
            gatewayUrl: stored.ipfsUrl,
            blockHash: stored.blockHash,
            blockNumber: stored.blockNumber,
            dotMapped: false,
            dotError,
        };
    }

    // ── Phase 2: the store. For fresh names it runs CONCURRENTLY with the
    // commitment-age wait. A store failure here propagates as a TOTAL
    // failure (same contract as before) — the spent commitment expires
    // harmlessly on-chain.
    if (commitment) {
        [, stored] = await Promise.all([
            waitCommitmentAge(commitment.totalWait),
            doStore(),
        ]);
    } else {
        stored = await doStore();
    }

    // ── Phase 3: reveal + point the name. Failures are partial success —
    // the user keeps their CID and gateway URL.
    try {
        if (commitment) {
            await finishRegistration({
                commitment,
                signerAddress: account.address,
                signer: account.signer,
                onStatus: (s) => onStatus(`DotNS register: ${s}`),
            });
        }
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
