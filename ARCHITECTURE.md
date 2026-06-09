# Architecture

hello-playground is a pure client-side dApp: no backend, no CORS proxy, no native binaries. Everything — editing, rendering, image optimization, chain interaction — happens in the browser. This document explains how the pieces fit and, more importantly, *why* they're shaped the way they are. Several decisions here were learned empirically against live chains and hosts; those are marked so future maintainers don't re-learn them the hard way.

## The one-sentence model

The block editor produces a `SiteContent` value; `renderHtml(content)` turns it into a complete HTML document string; that string is **simultaneously the live preview and the deploy artifact** — what you see is byte-for-byte what lands on chain.

## Module map

```
src/
├── App.tsx                  # All UI: editor, preview, deploy panel, upload state
├── template.ts              # Block model + renderHtml + escaping (the security boundary)
├── templates.ts             # Starter layouts (pure data — everything buildable by hand)
├── markdown.ts              # Blocks → Markdown serialization + Markdown rendering
├── derive-domain.ts         # Auto-name derivation (dependency-free on purpose)
├── deploy.ts                # Deploy orchestrator (store ∥ commit-reveal pipeline)
├── preflight.ts             # Read-only readiness checks for the deploy panel
├── account.ts               # Three account sources behind one ActiveAccount shape
├── signer.ts                # Host product-account flow (createAccountsProvider)
├── image-resize.ts          # Client-side downscale/re-encode before upload
└── lib/
    ├── host/                # Three-way host detection, RFC-0002 permissions
    ├── polkadot/            # Cached PAPI clients (host-routed AH, WS Bulletin)
    ├── bulletin/            # Storage: host preimage route + direct authorized store
    └── dotns/               # Registrar contracts via pallet-revive (commit-reveal,
                             # ownership, contenthash, dry-run bridge)
```

## Editing: the eject ladder

Three modes, strictly one-way conversions down, state-restoring hops up:

```
blocks ──exact──▶ markdown ──exact──▶ html/css/js
   ◀──restores last block state──┘
```

- **Blocks** is the default: structured data, fully escaped on render, every template reproducible by hand from the + menu.
- **Markdown** is blocks serialized losslessly. Conversion *escapes* `<` and `&` in block text so content that rendered as literal text stays literal — without this, a paragraph containing `<b>` silently became live markup on conversion. Markdown typed directly may contain raw HTML; that's intentional (the next rung grants full HTML anyway).
- **HTML mode** is the deliberate eject: three CodePen-style panes emitted verbatim. The threat model is explicit — the author can only attack their own page, the same capability every mode ultimately grants.

Edit and Preview are **separate views**, so there is no re-render-the-iframe-per-keystroke problem: editing manipulates live DOM/CodeMirror; the iframe `srcDoc` only exists on the Preview tab.

## Rendering and the security boundary

`template.ts` owns escaping. Every interpolation goes through `escapeHtml`; URLs go through an allowlist (`safeUrl`: `https?:`, `mailto:`, `tel:`, relative paths — `javascript:` and `data:` hrefs are rejected to `#`; images additionally allow `data:image/*`).

Two non-obvious cases, both learned in production:

- **`mailto:` must be allowlisted** — the templates themselves ship "Email me" buttons, and the original https-only allowlist silently killed them.
- **Cloudflare rewrites emails at serve time.** The IPFS gateway is CF-fronted with Email Address Obfuscation; it rewrites `mailto:` hrefs to `/cdn-cgi/l/email-protection#…`, and the injected decoder 404s on the displaying origin. Rendered mailto anchors are wrapped in Cloudflare's documented `<!--email_off-->` opt-out so the artifact survives any CF-proxied gateway.

## Accounts: host-first, standalone fallback

`account.ts` exposes one `ActiveAccount` shape from three sources, tried in this order:

| Source | Signer | When |
|--------|--------|------|
| `host` | Product account via `createAccountsProvider` | Inside Polkadot Desktop/Mobile or the dot.li iframe (default) |
| `extension` | `polkadot-api/pjs-signer` | Standalone browser with Talisman/SubWallet/Polkadot.js |
| `dev` | `//Bob` from `product-sdk-tx` | Explicit checkbox; local dev with no wallet |

Decisions that matter (all empirical):

- **`createAccountsProvider`, not `SignerManager`.** `@parity/product-sdk-signer`'s `SignerManager` discovers accounts via `getLegacyAccounts()`, which current desktop/android hosts *reject* — the app sat at "connecting…" forever on Mobile while working on the web host. The accounts-provider path (`getProductAccount`) is what hosts actually support. (Pattern shared with Rock-Paper-Scissors / t3rminal.)
- **The `createTransaction` signer type.** Asset Hub Next's runtime has custom signed extensions (`AuthorizeValueTransfer`, `AsPgas`, …) that the PJS payload format cannot represent — the legacy bridge throws `PJS does not support this signed-extension`. The product signer pinned to `createTransaction` forwards extensions to the host as opaque bytes.
- **Host detection retries.** Mobile webviews inject the host bridge *asynchronously*; a single connect attempt at mount races it and loses. Inside a detected host (three-way detection: webview mark / cross-origin iframe / standalone) the app retries ~6s; standalone gets one fast attempt so the fallback UI isn't delayed.
- **Signed-out is a state, not a failure.** `RequestCredentialsErr.NotConnected` means the host has no dotli session → the UI shows a sign-in CTA wired to `requestLogin`, distinct from "no host available".
- **The identifier scopes the account.** `getProductAccountIdentifier()` maps the hostname to a `.dot` identifier; the derived product account (its address, balance, and domain ownership) follows from it. Changing the derivation scheme silently changes the user's account — treat it as a migration, not a refactor.

## Bulletin storage: two routes

`lib/bulletin/store.ts` branches on account source:

- **Host route** (`preimageManager.submit` + RFC-0002 `PreimageSubmit` permission): no Bulletin RPC connection from the app, no faucet authorization, no transaction signing — which also sidesteps the host signing channel's undocumented "message too big" size limit. The host doesn't report block inclusion; the client-computed CID (blake2b-256, raw codec — matching Bulletin's defaults) is the receipt.
- **Direct route** (extension///Bob): an authorized `TransactionStorage.store`. **Chain semantics learned the hard way:** in the v2 runtime, `AuthorizationExtent.transactions/bytes` count *consumption*, and `*_allowance` carry the caps — the soft counters "saturate upward on every store; never gate" (pallet source). What gates a store is a non-expired authorization existing at all. The original code read consumption as "remaining" and therefore rejected exactly the fresh accounts that were fine, while passing heavily-used ones.

Image uploads adapt to the host bridge: start at a 256 KiB budget and halve + re-encode on each "message too big" rejection (the host rejects before any approval prompt, so retries cost nothing).

## DotNS: commit–reveal, pipelined

Registration is ENS-style commit–reveal against the registrar contracts on Asset Hub Next, called through pallet-revive (`lib/dotns/contracts.ts` is a small dry-run/submit bridge; dry-runs are free and double as pre-flight checks).

The deploy pipeline (`deploy.ts`):

```
prep (dry-runs, commit tx)        ── failure ⇒ store anyway, partial success
        │
        ▼
commitment age (~60s, mandatory)  ║  Bulletin store runs CONCURRENTLY
        │                            ── store failure ⇒ total failure
        ▼
reveal (register) → setContenthash ── failure ⇒ partial success (CID survives)
```

- **Why the wait exists**: the commitment hash (salted with a 32-byte secret) reveals nothing; the minimum age guarantees no mempool observer can front-run the reveal. It's a contract parameter (60s here, read live, +6s buffer for block-timestamp skew).
- **Why pipelined**: the commitment doesn't depend on the stored CID, so the store happens *inside* the mandatory wait instead of before it — a fresh-name deploy is ~90s, dominated by the protocol floor.
- **Owned names skip the ceremony**: if `registry.owner(node)` matches the account's H160, deploy goes straight to `setContenthash` — updates take seconds and cost no registration fee.
- **In-block, not finality**: every transaction resolves at `txBestBlocksState` (the dispatch outcome is known there); finality added ~15–30s per tx for no information. All post-inclusion failure modes here are retryable, and a reorged store re-includes with the same CID. `submitAndWait` accepts `waitFor: "finalized"` for callers where that calculus differs.

**Fees vs value, settled empirically**: host sponsorship (`AsPgas`) covers *fees only*. The domain price and pallet-revive storage deposits are value transfers from the product account's own balance — an unfunded account dispatches `Revive::TransferFailed` at register. The pre-flight funds check reflects this.

## Pre-flight philosophy

`preflight.ts` runs only read-only operations (storage queries, dry-runs), automatically and debounced, so checking is free and continuous. Severity is deliberate:

- **fail** = deploying *would* fail or waste a transaction (no authorization, name taken by someone else, zero balance, invalid label)
- **warn** = degraded or unverifiable (RPC hiccup, low allowance, PoP tier mismatch)
- Nothing hard-blocks the button: failed checks arm a "Deploy anyway?" two-tap confirm. **The chain is the authority; the checklist is advice** — a flaky RPC must never lock a user out of an action the chain would accept.

The auto-derived name is generated once per session and shown in the field, so the name the checklist verifies is byte-for-byte the name the deploy registers.

## Clients and the sandbox

`lib/polkadot/clients.ts` keeps one cached PAPI client per chain. Asset Hub routes through `createPapiProvider(genesis, ws-fallback)` when running as a deployed app inside a host — the host owns the chain follow, keeping signing and permissions coordinated; localhost and standalone go straight to WebSocket (the host refuses follows for unregistered dev domains, and the fallback never fires in that trap). Bulletin stays direct WS — hosts don't follow Bulletin — which only the extension///Bob route touches anyway.

## Performance decisions

- **The chain stack is not in the initial bundle.** polkadot-api client/ws, generated descriptor metadata (~1.1 MB raw), viem, and multiformats load via dynamic `import()` at the four places that need them (preflight, auth query, upload, deploy). CodeMirror was already its own lazy chunk. Anything the editor UI needs from those modules lives in dependency-free files (`derive-domain.ts`, `lib/bulletin/limits.ts`).
- Uploads are keyed by block id in App state, so they run in the background and survive the edit sheet closing.
- Undo is a snapshot stack with ~800ms coalescing; drafts autosave to localStorage debounced, flushed synchronously on `pagehide`.

## Known limitations

- **Image upload on Android hosts**: Polkadot Mobile's webview doesn't implement `WebChromeClient.onShowFileChooser`, so file inputs are silently inert — a host bug, not fixable from web code.
- **Non-Latin auto-names**: Cyrillic/CJK titles fall back to `hello-xxxx12` (transliteration needs a real library; Latin diacritics/ligatures are handled).
- **SDK versions are pinned deliberately** (`@novasamatech/*` at 0.7.9-4 in lockstep): the newest line (`host-api-wrapper` 0.8.x) post-dates the local npm `before` supply-chain pin, and the identifier-derivation change that comes with current Desktop hosts is an account migration (see above), not a drop-in bump.
