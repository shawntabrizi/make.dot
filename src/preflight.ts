// Pre-flight checks for the deploy flow. Everything here is read-only —
// storage queries and pallet-revive dry-runs — so the checklist can run
// automatically (and repeatedly) at zero cost before the user commits to
// the irreversible deploy transactions.
//
// Severity model: "fail" blocks the Deploy button (deploying WOULD fail or
// waste a transaction), "warn" does not (we couldn't verify, or deploy can
// recover — e.g. the one-time map_account setup). A flaky RPC must never
// lock the user out of deploying: checks that throw degrade to "warn" and
// the deploy path re-verifies everything authoritatively anyway.

import type { ActiveAccount } from "./account.ts";
import { computeCID } from "./lib/bulletin/cid.ts";
import { checkBulletinAuthorization, MAX_TX_BYTES } from "./lib/bulletin/store.ts";
import { getEvmAddress } from "./lib/dotns/address.ts";
import { isAccountMapped } from "./lib/dotns/contracts.ts";
import { checkDomainAvailability, quoteDomain } from "./lib/dotns/register.ts";
import { getAssetHubClient } from "./lib/polkadot/clients.ts";
import {
    BULLETIN_FAUCET_URL,
    BULLETIN_GATEWAY,
    DOT_HOST,
    NATIVE_TO_ETH_RATIO,
    PAS_FAUCET_URL,
} from "./lib/polkadot/constants.ts";

export type CheckState = "ok" | "warn" | "fail";

export interface PreflightCheck {
    id: "size" | "bulletin" | "name" | "funds" | "mapped";
    label: string;
    state: CheckState;
    detail: string | null;
    /** Actionable link (faucet etc.) rendered next to the detail. */
    link: string | null;
}

export interface PreflightReport {
    checks: PreflightCheck[];
    /** True when nothing is "fail" — warns don't block the Deploy button. */
    ok: boolean;
    bytes: number;
    cid: string;
    label: string;
    url: string;
    gatewayUrl: string;
    /** Registration price in native units, when the quote succeeded. */
    priceNative: bigint | null;
}

// 12-decimals per the 2 PAS == 2_000_000_000_000 convention in contracts.ts.
const PAS = 1_000_000_000_000n;
// Rough headroom for fees + the two contract storage deposits. Deliberately
// coarse — exact estimation needs per-tx query_info and isn't worth it.
const FEE_MARGIN = 5n * PAS;

export function formatPas(native: bigint): string {
    const whole = native / PAS;
    const frac = ((native % PAS) * 10_000n) / PAS;
    return frac === 0n
        ? `${whole} PAS`
        : `${whole}.${frac.toString().padStart(4, "0").replace(/0+$/, "")} PAS`;
}

/** Client-side label rules — same shape the chain-side PoP rules expect. */
export function validateLabel(label: string): string | null {
    if (!label) return "Name is empty";
    if (!/^[a-z0-9-]+$/.test(label))
        return "Use lowercase letters, digits, and hyphens only";
    if (label.startsWith("-") || label.endsWith("-"))
        return "Can't start or end with a hyphen";
    if (label.length < 3) return "Must be at least 3 characters";
    if (label.length > 63) return "Must be at most 63 characters";
    return null;
}

const verifyLater = (id: PreflightCheck["id"], label: string): PreflightCheck => ({
    id,
    label,
    state: "warn",
    detail: "Couldn't verify (network error) — deploy will check this for real",
    link: null,
});

export async function runPreflight(params: {
    html: string;
    label: string;
    account: ActiveAccount;
}): Promise<PreflightReport> {
    const { html, label, account } = params;

    const bytes = new TextEncoder().encode(html);
    const cid = computeCID(bytes).toString();

    // ── size: local, exact ───────────────────────────────────────────────
    const sizeCheck: PreflightCheck = {
        id: "size",
        label: "Site size",
        state: bytes.length <= MAX_TX_BYTES ? "ok" : "fail",
        detail:
            bytes.length <= MAX_TX_BYTES
                ? `${bytes.length.toLocaleString()} B (max ${(MAX_TX_BYTES / 1024 / 1024).toFixed(0)} MiB)`
                : `${bytes.length.toLocaleString()} B exceeds the ${(MAX_TX_BYTES / 1024 / 1024).toFixed(0)} MiB per-transaction cap`,
        link: null,
    };

    // ── bulletin: a non-expired authorization is the actual store gate;
    //    the byte allowance is a soft priority signal (warn, never fail) ──
    const bulletinCheck = async (): Promise<PreflightCheck> => {
        const auth = await checkBulletinAuthorization(account.address);
        if (!auth.authorized) {
            return {
                id: "bulletin",
                label: "Bulletin storage",
                state: "fail",
                detail: auth.expired
                    ? `Authorization expired at block #${auth.expiresAt?.toLocaleString()} — re-up at the faucet`
                    : `${account.displayName} has no Bulletin storage authorization`,
                link: BULLETIN_FAUCET_URL,
            };
        }
        const remaining = auth.bytesAllowance - auth.bytesUsed;
        if (remaining < BigInt(bytes.length)) {
            return {
                id: "bulletin",
                label: "Bulletin storage",
                state: "warn",
                detail: `${(remaining > 0n ? remaining : 0n).toLocaleString()} B of ${auth.bytesAllowance.toLocaleString()} B allowance left — store still works, but at degraded priority`,
                link: BULLETIN_FAUCET_URL,
            };
        }
        return {
            id: "bulletin",
            label: "Bulletin storage",
            state: "ok",
            detail: `${remaining.toLocaleString()} B of ${auth.bytesAllowance.toLocaleString()} B allowance remaining`,
            link: null,
        };
    };

    // ── name: local validity → availability → PoP quote ─────────────────
    let priceNative: bigint | null = null;
    const nameCheck = async (): Promise<PreflightCheck> => {
        const invalid = validateLabel(label);
        if (invalid) {
            return { id: "name", label: ".dot name", state: "fail", detail: invalid, link: null };
        }
        const available = await checkDomainAvailability(label, account.address);
        if (!available) {
            return {
                id: "name",
                label: ".dot name",
                state: "fail",
                detail: `${label}.dot is already registered — pick another name`,
                link: null,
            };
        }
        const ownerEvm = await getEvmAddress(account.address);
        const quote = await quoteDomain(label, ownerEvm, account.address);
        if (quote.price !== null) priceNative = quote.price / NATIVE_TO_ETH_RATIO;
        const priceText = priceNative !== null ? ` · price ${formatPas(priceNative)}` : "";
        // The message is a classification, present even on success
        // ("Available to all"). The actual verdict is the tier comparison:
        // the account can register iff userStatus >= status.
        if (
            quote.status !== null &&
            quote.userStatus !== null &&
            quote.userStatus < quote.status
        ) {
            return {
                id: "name",
                label: ".dot name",
                state: "warn",
                detail: `Available, but "${quote.message ?? "restricted"}" — this account's verification tier (${quote.userStatus}) is below the name's requirement (${quote.status})${priceText}`,
                link: null,
            };
        }
        return {
            id: "name",
            label: ".dot name",
            state: "ok",
            detail: `${label}.dot is available${priceText}`,
            link: null,
        };
    };

    // ── funds: host allowance, or on-chain balance for extension/dev ────
    let freeNative: bigint | null = null;
    const fundsCheck = async (): Promise<PreflightCheck> => {
        if (account.source === "host") {
            // Host-mediated transactions are fee-sponsored (AsPgas) — the
            // ChainSubmit permission prompt at deploy time is the real gate,
            // and there's no API to pre-query it.
            return {
                id: "funds",
                label: "Transaction fees",
                state: "ok",
                detail: "Sponsored by the host",
                link: null,
            };
        }
        const { api } = getAssetHubClient();
        const info = await api.query.System.Account.getValue(account.address);
        freeNative = info.data.free;
        if (freeNative === 0n) {
            return {
                id: "funds",
                label: "Transaction fees",
                state: "fail",
                detail: `${account.displayName} has no PAS on Asset Hub`,
                link: PAS_FAUCET_URL,
            };
        }
        return {
            id: "funds",
            label: "Transaction fees",
            state: "ok",
            detail: `${formatPas(freeNative)} free on Asset Hub`,
            link: null,
        };
    };

    // ── mapped: read-only revive probe ───────────────────────────────────
    const mappedCheck = async (): Promise<PreflightCheck> => {
        const mapped = await isAccountMapped(account.address);
        return mapped
            ? { id: "mapped", label: "Account setup", state: "ok", detail: "Mapped on Asset Hub", link: null }
            : {
                  id: "mapped",
                  label: "Account setup",
                  state: "warn",
                  detail: "One-time map_account transaction will run during deploy",
                  link: null,
              };
    };

    const [bulletin, name, funds, mapped] = await Promise.all([
        bulletinCheck().catch(() => verifyLater("bulletin", "Bulletin storage")),
        nameCheck().catch(() => verifyLater("name", ".dot name")),
        fundsCheck().catch(() => verifyLater("funds", "Transaction fees")),
        mappedCheck().catch(() => verifyLater("mapped", "Account setup")),
    ]);

    // Cross-check once both sides are known: balance vs price + headroom.
    if (
        funds.state === "ok" &&
        account.source !== "host" &&
        priceNative !== null &&
        freeNative !== null &&
        freeNative < priceNative + FEE_MARGIN
    ) {
        funds.state = "warn";
        funds.detail = `${formatPas(freeNative)} free may not cover price ${formatPas(priceNative)} + fees`;
        funds.link = PAS_FAUCET_URL;
    }

    const checks = [sizeCheck, bulletin, name, funds, mapped];
    return {
        checks,
        ok: checks.every((c) => c.state !== "fail"),
        bytes: bytes.length,
        cid,
        label,
        url: `https://${label}.${DOT_HOST}`,
        gatewayUrl: `${BULLETIN_GATEWAY}${cid}`,
        priceNative,
    };
}
