// Account for the deploy flow. The app signs every chain submission with the
// //Bob dev account — the host/extension signing options were removed.
//
// `signer` is the underlying PAPI signer the deploy flow submits through.

import { ss58Encode } from "@parity/product-sdk-address";
import { createDevSigner, getDevPublicKey } from "@parity/product-sdk-tx";
import type { PolkadotSigner } from "polkadot-api";

export type AccountSource = "dev";

export interface ActiveAccount {
    source: AccountSource;
    address: string;
    displayName: string;
    /** Underlying PAPI signer — used by the deploy flow once chain calls land. */
    signer: PolkadotSigner;
}

const DEV_ACCOUNT_NAME = "Bob";

// The currently-active account, mirrored at module scope so non-React code
// (the CloudStorageClient's lazy signer in lib/bulletin/store.ts) can read the
// //Bob dev account's signer. App pushes it here via `setCurrentAccount` on
// mount.
let currentAccount: ActiveAccount | null = null;

export function setCurrentAccount(account: ActiveAccount | null): void {
    currentAccount = account;
}

export function getCurrentAccount(): ActiveAccount | null {
    return currentAccount;
}

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
