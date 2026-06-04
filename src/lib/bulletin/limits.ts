// Chain caps as plain constants — dependency-free so UI code can import them
// without dragging the PAPI client/descriptors into the initial bundle.

/** Per-transaction chain cap — applies regardless of account authorization. */
export const MAX_TX_BYTES = 2 * 1024 * 1024; // 2 MiB on Paseo Next (8 MiB on Polkadot Bulletin)
