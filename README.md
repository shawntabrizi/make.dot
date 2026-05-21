# hello-playground

A single-page WYSIWYG site builder that runs as a `.dot.li` app and deploys what you type — straight to IPFS (via Bulletin Chain) and a `.dot` name. Built for the "open a thing, type two fields, tap deploy, you have a website" demo.

The deployer itself is meant to be hosted at `hello-playground.dot` (or wherever) and accessed inside Polkadot Desktop / Polkadot Mobile. Everything runs in-browser — no backend, no CORS proxy, no native binaries.

## What's here

```
hello-playground/
├── index.html
├── package.json           # React 19 + Vite + product-sdk + multiformats + @noble/hashes
├── tsconfig.json
├── vite.config.ts
└── src/
    ├── main.tsx           # entry
    ├── App.tsx            # layout: editor pane (left) + iframe preview (right)
    ├── App.css            # plain CSS, mobile-first via media query at 720px
    ├── Editor.tsx         # form fields (header, subheader, accent, background, font) + add-block menu
    ├── Preview.tsx        # iframe with srcDoc = renderHtml(content) — byte-for-byte the deploy artifact
    ├── template.ts        # the bare HTML template + renderHtml(siteContent) + Block model
    ├── signer.ts          # Host API SignerManager wrapper, adapted from playground-app-template
    └── deploy.ts          # CID compute + auto-name derivation; chain submission is TODO
```

## What's wired

- **Editor + preview.** A form with header / subheader / accent / background / font fields, plus an "Add element" button for extra paragraphs, links, images, and dividers. The iframe preview renders `renderHtml(content)` live — **the exact bytes that would be uploaded.**
- **Three signing modes via `src/account.ts`** — `ActiveAccount` is the uniform shape; sources are wired independently so toggling between them never tears down the others:
  - `host` — Polkadot Desktop / Mobile via `@parity/product-sdk-signer` (same pattern as the template). Tried automatically on mount.
  - `extension` — Talisman / SubWallet / Polkadot.js via `polkadot-api/pjs-signer`. Surfaced as a "Connect browser wallet" button when host is unavailable.
  - `dev` — `//Bob` via `createDevSigner` from `@parity/product-sdk-tx`. Always wins when the checkbox is ticked, so a local dev session works with no wallet at all.
- **CID computation.** Blake2b-256 + raw codec (`0x55`) — matches Bulletin's default per the [bulletin-storage skill](https://publicsuffix.org/list/public_suffix_list.dat) [^1]. Computed client-side from `@noble/hashes` + `multiformats`. Pressing Deploy shows the bytes, the CID, and the `.dot.li` URL you'd land at.
- **Auto-name.** Leave the `.dot name` field blank and the deployer picks a NoStatus-shape label (matches `dot decentralize`'s rule: base ≥9 chars + exactly 2 trailing digits, so any signer without PoP can register it).

[^1]: Inline reference for the protocol detail — not the actual link. See the skill in `~/.claude/skills/bulletin-storage` for the authoritative version.

## End-to-end deploy

When //Bob is selected, "Deploy" runs the full chain dance via direct `pallet-revive` contract calls — no `bulletin-deploy`, no Kubo, no backend. Architecture ported from [dotvillages / dotdot-deployer](https://github.com/paritytech/dotdot-deployer) and re-pointed at paseo-next-v2 endpoints + contracts.

Three phases, surfaced live in the status banner:

1. **Bulletin store** — `TransactionStorage.Authorizations` check → `TransactionStorage.store({ data: bytes })` → wait for inclusion. Yields CID + block.
2. **DotNS register** (ENS-style commit-reveal):
   - `Revive.map_account()` (one-shot, cached per session)
   - `REGISTRAR_CONTROLLER.makeCommitment(...)` (read-only)
   - `REGISTRAR_CONTROLLER.commit(commitment)` (extrinsic)
   - Wait `minCommitmentAge` (~60 s) — front-running protection, mandatory
   - `POP_RULES.priceWithoutCheck(label, ownerH160)` → price × 1.1 / NATIVE_TO_ETH_RATIO
   - `REGISTRAR_CONTROLLER.register(registration)` (extrinsic, with payment value)
3. **Content hash bind** — `CONTENT_RESOLVER.setContenthash(namehash("<label>.dot"), encodeIpfsContenthash(cid))`

The DotNS phase is **best-effort**: if any of register / setContenthash fails (most commonly because //Bob has no PAS for fees on Asset Hub Next), the result card still shows the successful Bulletin store + gateway URL. The status banner surfaces the exact reason.

### Lib layout

```
src/lib/
├── polkadot/
│   ├── constants.ts        ← Bulletin + AH-Next RPCs, 5 DotNS contract addresses, NATIVE_TO_ETH_RATIO
│   └── clients.ts          ← Cached PAPI clients (direct WS today; createPapiProvider for host follow-up)
├── bulletin/
│   ├── submit-and-wait.ts  ← Observable → Promise tx helper (handles signed/broadcast/inBlock/finalized)
│   ├── cid.ts              ← Blake2b-256 raw-codec CID
│   └── store.ts            ← Authorization check + TransactionStorage.store
└── dotns/
    ├── abis.ts             ← REGISTRY / REGISTRAR_CONTROLLER / CONTENT_RESOLVER / POP_RULES Solidity-style fragments
    ├── namehash.ts         ← viem namehash wrapper
    ├── address.ts          ← SS58 → H160 via ReviveApi.address (cached)
    ├── contracts.ts        ← ensureAccountMapped + dryRunContractCall + submitContractCall
    ├── register.ts         ← Commit-reveal flow
    └── content-hash.ts     ← encodeIpfsContenthash + setContenthash submission
```

### Prereqs for the //Bob path to actually succeed

- **Bulletin authorization for //Bob's SS58 address** (`5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty`). One-time via [the self-serve faucet](https://paritytech.github.io/polkadot-bulletin-chain/authorizations?tab=faucet).
- **PAS on Asset Hub Next** for //Bob's mapped H160. Contract calls aren't feeless — register + setContenthash + the initial map_account all need fees. Use [the PAS faucet](https://faucet.polkadot.io/) — pick "Paseo Asset Hub Next". (A future iteration could auto-top-up from Alice, mirroring `bulletin-deploy.attemptTestnetTopUp`.)
- **Bunch of patience for the ~60 s commitment age** between commit and register. Protocol-mandated.

Host (Polkadot Desktop) and extension (Talisman / Polkadot.js / SubWallet) paths today fall back to **preview-only** — the chain submission still needs:

- Host signer's `signBytes` to map through `signerManager.signRaw` instead of the stub PAPI signer
- Either same prereqs as //Bob (Bulletin + PAS) or a fresh session signer with allocations granted via `requestResourceAllocation`

## Run

```sh
npm install
npm run dev
```

Open the dev server. The editor + preview should both render with the default content. The Deploy button works against the in-memory preview today — wire up the chain submission next.

## Deploy this app to `hello-playground.dot.li`

The deployer itself ships via [playground-cli](https://github.com/paritytech/playground-cli) (the `dot` command). It builds `dist/`, uploads the static bundle to Bulletin, and registers `hello-playground.dot` on DotNS — pointing at the resulting CID.

```sh
# one-time: install + provision session keys
curl -fsSL https://raw.githubusercontent.com/paritytech/playground-cli/main/install.sh | bash
dot init

# every release: build is auto-run by the CLI
npm run deploy:dot -- --signer phone
```

For unattended / CI deploys, swap the signer for a dev keypair:

```sh
npm run deploy:dot -- --signer dev --suri //Alice
```

Useful flags to pass through (`npm run deploy:dot -- ...`):

- `--playground` — publish to the Playground registry so it appears in users' "my apps".
- `--moddable` — publish the source repo URL so others can `dot mod hello-playground`.
- `--no-build` — skip the Vite build (assume `dist/` is already current).
- `--env <paseo-next-v2|testnet|mainnet>` — target network (default matches what the app talks to in-browser).

The signer hostname mapping in `src/signer.ts::getProductAccountIdentifier` already collapses `hello-playground.dot.li` back to the `hello-playground.dot` product identifier, so host-signed flows keep working under the deployed origin.

## Conventions

- React 19 + Vite + TypeScript. Plain CSS with custom-property tokens (not Tailwind — see "design system" note below).
- **Three-way signer resolution.** Host API first, then injected extension, with `//Bob` as a one-tick override for "I just want to test the flow without setting anything up." Per the polkadot-triangle skill's host-first / standalone-fallback rule. The host signer's `signBytes` is stubbed today — chain submission will call `signerManager.signRaw(...)` directly via the source-specific path, not the bare PAPI signer.
- HTML escaping in `template.ts::escape` covers all five XML entities. URLs in image/link blocks go through `safeUrl()` which rejects anything that isn't `http(s)`, relative, or a fragment — so a user can't smuggle a `javascript:` URL into the produced page.
- The preview iframe uses `sandbox="allow-popups allow-popups-to-escape-sandbox"`. No `allow-scripts`, no `allow-same-origin` — the generated HTML can't reach back into the editor or call `window.parent`.

### Design system note

This project intentionally **does not** adopt the Tailwind-based `polkadot-design-system` skill yet. The parent template (`playground-app-template`) uses plain CSS with custom-property tokens, and matching it is more important during scaffolding than enforcing the full design system. A future migration to the design system is one of the open follow-ups.

## Open follow-ups

- [ ] Empirically test whether `.dot.li` resolves raw-codec CIDs or requires UnixFS directory wrapping. Decide the storage shape.
- [ ] Wire `TransactionStorage.store` with the right Observable handling (per `bulletin-storage` skill: `.subscribe()`, `txBestBlocksState && found`, unsubscribe on both paths).
- [ ] Wire DotNS register + setContenthash via `product-sdk-contracts`.
- [ ] Gate "Deploy" on a confirmed `Allocated` outcome for both `BulletInAllowance` and `SmartContractAllowance`.
- [ ] Account-picker UI for the extension path — today we auto-pick the first extension's first account.
- [ ] Resolve the host `signer` stub so chain submission can use a uniform `PolkadotSigner` across all three sources (or branch on `source` at submit time).
- [ ] Tiptap or contenteditable for richer in-place editing if the structured-form pattern turns out to be too limiting.
- [ ] Migrate styling to the Tailwind-based `polkadot-design-system` once a few more usage patterns settle.
