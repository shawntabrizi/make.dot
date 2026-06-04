// Account resolution across three signing modes. Wraps host / extension /
// //Bob (dev) into a single ActiveAccount shape so the UI and deploy code
// don't need to branch on source.
//
// Per the polkadot-triangle skill's "host-first, standalone-fallback" rule:
// the app tries the Host API first (Polkadot Desktop / Mobile) and only
// surfaces the extension/dev paths to the user when host is unavailable.
//
// All three sources carry a real PAPI `PolkadotSigner` usable with
// `signSubmitAndWatch`. The host's product-account signer is pinned to the
// `createTransaction` signer type in product-sdk, so unknown signed
// extensions (e.g. AsPgas on Paseo Next) survive end-to-end.

import { ss58Encode, truncateAddress } from "@parity/product-sdk-address";
import { createDevSigner, getDevPublicKey } from "@parity/product-sdk-tx";
import { connectInjectedExtension, getInjectedExtensions } from "polkadot-api/pjs-signer";
import type { PolkadotSigner } from "polkadot-api";
import { isInHost } from "./lib/host/detect.ts";
import { connectHostAccount, getHostState } from "./signer.ts";

export type AccountSource = "host" | "extension" | "dev";

export interface ActiveAccount {
    source: AccountSource;
    address: string;
    displayName: string;
    /** Underlying PAPI signer — used by the deploy flow once chain calls land. */
    signer: PolkadotSigner;
}

const DEV_ACCOUNT_NAME = "Bob";

/**
 * Synchronous — `//Bob` requires no network, just a deterministic derivation.
 * The toggleable dev fallback in the UI.
 */
export function getDevAccount(): ActiveAccount {
    return {
        source: "dev",
        address: ss58Encode(getDevPublicKey(DEV_ACCOUNT_NAME)),
        displayName: `${DEV_ACCOUNT_NAME} (dev)`,
        signer: createDevSigner(DEV_ACCOUNT_NAME),
    };
}

/**
 * Resolve the Host API product account (Polkadot Desktop / Mobile). Returns
 * null when the host isn't available, errored, or has no dotli session —
 * inspect the signer wrapper's HostState (`useHostState`) to tell
 * "signed-out" (show a sign-in CTA) apart from "no host at all".
 */
export async function tryHostAccount(): Promise<ActiveAccount | null> {
    const state = await connectHostAccount();
    if (state.status !== "ready" || !state.account) return null;
    return {
        source: "host",
        address: state.account.address,
        displayName:
            state.account.displayName ?? truncateAddress(state.account.address),
        // The createTransaction product signer IS a PAPI PolkadotSigner —
        // routed via host_create_transaction, so AH-Next's custom signed
        // extensions pass through as raw bytes.
        signer: state.account.signer,
    };
}

/**
 * Resolve the host account with retries. Mobile webviews inject the host
 * bridge ASYNCHRONOUSLY — a single connect attempt at mount races the
 * injection and loses (works on Desktop/web-iframe, fails on Mobile).
 * Inside a detected host environment we retry for ~6s, matching the
 * polkadot-triangle boot sequence (10× / 500ms); standalone gets one fast
 * attempt so the fallback UI isn't delayed in a plain browser.
 */
export async function resolveHostAccount(): Promise<ActiveAccount | null> {
    const attempts = isInHost() ? 12 : 1;
    for (let i = 0; i < attempts; i++) {
        const account = await tryHostAccount();
        if (account) return account;
        // Definitive "signed out" needs user action (signInToHost) —
        // retrying won't change it.
        if (getHostState().status === "signed-out") return null;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500));
    }
    return null;
}

/** Discover whether any browser-wallet extension is injected on this page. */
export function hasInjectedExtension(): boolean {
    try {
        return getInjectedExtensions().length > 0;
    } catch {
        return false;
    }
}

/**
 * Connect to the first available injected extension (Talisman, Polkadot.js,
 * SubWallet, etc.) and pick its first account. A future UI iteration can let
 * the user pick a specific extension and account.
 */
export async function tryExtensionAccount(): Promise<ActiveAccount | null> {
    const names = getInjectedExtensions();
    if (names.length === 0) return null;

    const extension = await connectInjectedExtension(names[0], "hello-playground");
    const accounts = extension.getAccounts();
    if (accounts.length === 0) return null;

    const account = accounts[0];
    return {
        source: "extension",
        address: account.address,
        displayName: account.name ?? truncateAddress(account.address),
        signer: account.polkadotSigner,
    };
}
