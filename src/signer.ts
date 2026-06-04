// Host account flow — direct against @novasamatech/product-sdk, following
// the Rock-Paper-Scissors / t3rminal reference pattern.
//
// We intentionally avoid @parity/product-sdk-signer here: its SignerManager
// discovers accounts via getLegacyAccounts(), which current desktop/android
// hosts REJECT — the app sat in "connecting…" forever on Polkadot Mobile.
// createAccountsProvider().getProductAccount is the supported path, and its
// "createTransaction" signerType routes through the host's
// host_create_transaction RPC, bypassing the PJS adapter and its static
// signed-extension whitelist — AH-Next's custom extensions (AsPgas,
// AuthorizeValueTransfer, …) pass through to the host as raw bytes.
// Requires Polkadot Desktop ≥ 0.3.10 / a current Mobile build.

import { useSyncExternalStore } from "react";
import {
    createAccountsProvider,
    type ProductAccount,
} from "@novasamatech/product-sdk";
import { RequestCredentialsErr } from "@novasamatech/host-api";
import { AccountId, type PolkadotSigner } from "polkadot-api";

const DEFAULT_PRODUCT_ACCOUNT_DOT_NS = "hello-playground.dot";
const PRODUCT_ACCOUNT_DERIVATION_INDEX = 0;

function isLoopback(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function getProductAccountIdentifier(): string {
    const configured = import.meta.env.VITE_PRODUCT_ACCOUNT_ID?.trim();
    if (configured) return configured;

    const { host, hostname } = window.location;
    if (isLoopback(hostname)) return host;

    // dotli exposes hosted products as `<name>.<gateway>` (e.g.
    // `hello-playground.dot.li`). Map back to the canonical `<name>.dot`
    // identifier the host signs against.
    const labels = hostname.toLowerCase().split(".");
    if (labels.length === 3) return `${labels[0]}.dot`;

    if (hostname.endsWith(".dot")) return hostname;
    return DEFAULT_PRODUCT_ACCOUNT_DOT_NS;
}

export interface HostAccount {
    /** SS58 string derived from the host's product public key. */
    address: string;
    publicKey: Uint8Array;
    /** dotli primary username, when the host exposes one. */
    displayName: string | null;
    /** PAPI signer routed via host_create_transaction. */
    signer: PolkadotSigner;
}

export type HostStatus = "idle" | "connecting" | "ready" | "signed-out" | "error";

export interface HostState {
    status: HostStatus;
    account: HostAccount | null;
    error: string | null;
}

let state: HostState = { status: "idle", account: null, error: null };
const listeners = new Set<() => void>();

function setState(next: HostState) {
    state = next;
    for (const cb of listeners) cb();
}

const accountsProvider = createAccountsProvider();
const accountIdCodec = AccountId();

function describeProviderError(error: unknown): string {
    const e = error as { tag?: string; value?: { reason?: string } } | null;
    return `${e?.tag ?? "Unknown"}: ${e?.value?.reason ?? String(error)}`;
}

/**
 * Resolve the app-scoped product account from the host. Distinguishes
 * "host has no dotli session" (→ `signed-out`, fixable via signInToHost)
 * from "host unavailable / failed" (→ `error`).
 */
export async function connectHostAccount(): Promise<HostState> {
    if (state.status === "connecting") return state;
    setState({ status: "connecting", account: null, error: null });

    try {
        const identifier = getProductAccountIdentifier();
        const result = await accountsProvider.getProductAccount(
            identifier,
            PRODUCT_ACCOUNT_DERIVATION_INDEX,
        );
        if (result.isErr()) {
            if (result.error instanceof RequestCredentialsErr.NotConnected) {
                setState({ status: "signed-out", account: null, error: null });
                return state;
            }
            setState({
                status: "error",
                account: null,
                error: describeProviderError(result.error),
            });
            return state;
        }

        const { publicKey } = result.value;
        const productAccount: ProductAccount = {
            dotNsIdentifier: identifier,
            derivationIndex: PRODUCT_ACCOUNT_DERIVATION_INDEX,
            publicKey,
        };
        const signer = accountsProvider.getProductAccountSigner(
            productAccount,
            "createTransaction",
        );
        const address = accountIdCodec.dec(publicKey);

        let displayName: string | null = null;
        try {
            const userId = await accountsProvider.getUserId();
            if (userId.isOk()) {
                displayName =
                    (userId.value as { primaryUsername?: string }).primaryUsername ?? null;
            }
        } catch {
            // optional nicety — address fallback is fine
        }

        setState({
            status: "ready",
            account: { address, publicKey, displayName, signer },
            error: null,
        });
    } catch (cause) {
        setState({
            status: "error",
            account: null,
            error: cause instanceof Error ? cause.message : String(cause),
        });
    }
    return state;
}

/** Open the host's sign-in UI, then re-resolve the product account. */
export async function signInToHost(): Promise<HostState> {
    await accountsProvider.requestLogin("Sign in to deploy with hello-playground");
    return connectHostAccount();
}

export function getHostState(): HostState {
    return state;
}

export function useHostState(): HostState {
    return useSyncExternalStore(
        (cb) => {
            listeners.add(cb);
            return () => {
                listeners.delete(cb);
            };
        },
        () => state,
    );
}
