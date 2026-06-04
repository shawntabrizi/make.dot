// RFC-0002 host permissions — idempotent per session, one host prompt each
// at most. Callers request the narrowest tag for the operation at hand:
// ChainSubmit before host-mediated transaction submission, PreimageSubmit
// before host-mediated Bulletin preimage storage.

import { requestPermission } from "@novasamatech/product-sdk";

type PermissionTag = "ChainSubmit" | "PreimageSubmit" | "StatementSubmit";

const granted = new Set<PermissionTag>();

export async function ensureHostPermission(tag: PermissionTag): Promise<void> {
    if (granted.has(tag)) return;
    try {
        const result = await requestPermission({ tag, value: undefined });
        if (result.isOk() && result.value) {
            granted.add(tag);
        }
    } catch {
        // Host without RFC-0002 — the operation itself will prompt or fail loud.
    }
}
