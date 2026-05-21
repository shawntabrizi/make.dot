import { useEffect, useMemo, useState } from "react";
import { Editable } from "./Editable.tsx";
import {
    DEFAULT_CONTENT,
    FONT_OPTIONS,
    renderHtml,
    type Block,
    type SiteContent,
} from "./template.ts";
import {
    deployFull,
    previewDeploy,
    type DeployPreview,
    type DeploySuccess,
} from "./deploy.ts";
import {
    type ActiveAccount,
    getDevAccount,
    hasInjectedExtension,
    tryExtensionAccount,
    tryHostAccount,
} from "./account.ts";

type View = "edit" | "preview" | "deploy";
type DeployResult = DeployPreview | DeploySuccess;

const DEPLOY_STEPS = [
    { id: "prepare", label: "Prepare" },
    { id: "bulletin", label: "Store" },
    { id: "account", label: "Account" },
    { id: "name", label: "Name" },
    { id: "commit", label: "Commit" },
    { id: "wait", label: "Wait" },
    { id: "register", label: "Register" },
    { id: "link", label: "Link" },
] as const;

function stepForDeployStatus(message: string): number {
    if (message.startsWith("Bulletin:")) return 1;
    if (message.startsWith("DotNS: resolving owner")) return 2;
    if (message.startsWith("DotNS: checking domain")) return 3;
    if (message.startsWith("DotNS register: Waiting")) return 5;
    if (
        message.startsWith("DotNS register: Pricing") ||
        message.startsWith("DotNS register: Signing registration") ||
        message.startsWith("DotNS register: Domain registered")
    ) {
        return 6;
    }
    if (message.startsWith("DotNS register:")) return 4;
    if (message.startsWith("DotNS resolver:")) return 7;
    if (message.startsWith("DotNS step failed")) return 7;
    return 0;
}

function makeBlockId(): string {
    return Math.random().toString(36).slice(2, 10);
}

const BLOCK_PRESETS: Record<Block["type"], () => Block> = {
    paragraph: () => ({ id: makeBlockId(), type: "paragraph", text: "Write something here…" }),
    link: () => ({ id: makeBlockId(), type: "link", label: "Link text", url: "https://" }),
    image: () => ({ id: makeBlockId(), type: "image", url: "https://", alt: "" }),
    divider: () => ({ id: makeBlockId(), type: "divider" }),
};

export default function App() {
    const [content, setContent] = useState<SiteContent>(DEFAULT_CONTENT);
    const [view, setView] = useState<View>("edit");
    const [domain, setDomain] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [deployStep, setDeployStep] = useState<number | null>(null);
    const [result, setResult] = useState<DeployResult | null>(null);
    const [deployError, setDeployError] = useState<string | null>(null);
    const [addMenuOpen, setAddMenuOpen] = useState(false);

    // Signer state — Bob default, owned-account opt-in.
    const [useOwnedAccount, setUseOwnedAccount] = useState(false);
    const [hostAccount, setHostAccount] = useState<ActiveAccount | null>(null);
    const [extensionAccount, setExtensionAccount] = useState<ActiveAccount | null>(null);
    const [resolvingOwned, setResolvingOwned] = useState(false);
    const [ownedError, setOwnedError] = useState<string | null>(null);

    const devAccount = useMemo(() => getDevAccount(), []);
    const activeAccount: ActiveAccount | null = useOwnedAccount
        ? extensionAccount ?? hostAccount
        : devAccount;

    useEffect(() => {
        if (!useOwnedAccount || hostAccount || extensionAccount) return;
        setResolvingOwned(true);
        setOwnedError(null);
        tryHostAccount()
            .then((account) => {
                if (account) setHostAccount(account);
            })
            .catch((cause) => {
                setOwnedError(cause instanceof Error ? cause.message : String(cause));
            })
            .finally(() => setResolvingOwned(false));
    }, [useOwnedAccount, hostAccount, extensionAccount]);

    const update = <K extends keyof SiteContent>(key: K, value: SiteContent[K]) =>
        setContent((prev) => ({ ...prev, [key]: value }));
    const updateBlock = (id: string, patcher: (b: Block) => Block) =>
        setContent((prev) => ({
            ...prev,
            blocks: prev.blocks.map((b) => (b.id === id ? patcher(b) : b)),
        }));
    const removeBlock = (id: string) =>
        setContent((prev) => ({ ...prev, blocks: prev.blocks.filter((b) => b.id !== id) }));
    const addBlock = (type: Block["type"]) => {
        setContent((prev) => ({ ...prev, blocks: [...prev.blocks, BLOCK_PRESETS[type]()] }));
        setAddMenuOpen(false);
    };

    const connectExtension = async () => {
        setOwnedError(null);
        try {
            const account = await tryExtensionAccount();
            if (account) setExtensionAccount(account);
            else
                setOwnedError(
                    "No browser wallet found. Install Talisman, SubWallet, or Polkadot.js — or untick the box to deploy as //Bob.",
                );
        } catch (cause) {
            setOwnedError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    const deploy = async () => {
        setBusy(true);
        setResult(null);
        setDeployError(null);
        setDeployStep(0);
        setStatus("Preparing deploy…");
        const updateDeployStatus = (message: string) => {
            setStatus(message);
            setDeployStep(stepForDeployStatus(message));
        };
        try {
            const html = renderHtml(content);
            if (activeAccount?.source === "dev") {
                const stored = await deployFull(
                    html,
                    domain || null,
                    activeAccount,
                    updateDeployStatus,
                );
                setResult(stored);
            } else {
                const preview = await previewDeploy(html, domain || null);
                setResult(preview);
            }
        } catch (cause) {
            setDeployError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setBusy(false);
            setStatus(null);
            setDeployStep(null);
        }
    };

    const isEditing = view === "edit";
    const canDeploy = !busy && activeAccount !== null;
    const showOwnedHint =
        useOwnedAccount && !hostAccount && !extensionAccount && !resolvingOwned;

    const siteStyle = {
        background: content.background,
        fontFamily: content.fontFamily,
    } as const;

    return (
        <>
            <main className={`site ${isEditing ? "is-editing" : ""}`} style={siteStyle}>
                <article className="site-inner">
                    <Editable
                        tag="h1"
                        value={content.header}
                        onChange={(v) => update("header", v)}
                        editable={isEditing}
                        className="site-header"
                        style={{ color: content.accentColor }}
                        ariaLabel="Page header"
                        placeholder="Your page title"
                    />
                    <Editable
                        tag="p"
                        value={content.subheader}
                        onChange={(v) => update("subheader", v)}
                        editable={isEditing}
                        className="site-subheader"
                        ariaLabel="Page subheader"
                        placeholder="A short line about you or this page"
                    />
                    {content.blocks.map((block) => (
                        <BlockView
                            key={block.id}
                            block={block}
                            accentColor={content.accentColor}
                            editable={isEditing}
                            onUpdate={(b) => updateBlock(block.id, () => b)}
                            onRemove={() => removeBlock(block.id)}
                        />
                    ))}
                    {isEditing && content.blocks.length === 0 && (
                        <p className="site-tip">
                            Click any text to edit. Use the + button below to add
                            paragraphs, links, or images — make it your own.
                        </p>
                    )}
                </article>
            </main>

            {/* Floating action bar — visible only in edit view; sits above the bottom nav pill. */}
            {isEditing && (
                <div className="float-bottom">
                    <div className="action-bar" role="toolbar" aria-label="Site styling">
                        <ColorSwatch
                            label="Accent"
                            value={content.accentColor}
                            onChange={(v) => update("accentColor", v)}
                        />
                        <ColorSwatch
                            label="Bg"
                            value={content.background}
                            onChange={(v) => update("background", v)}
                        />
                        <select
                            className="action-select"
                            value={content.fontFamily}
                            onChange={(e) => update("fontFamily", e.target.value)}
                            aria-label="Font family"
                        >
                            {FONT_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                </option>
                            ))}
                        </select>
                        <div className="add-wrap">
                            <button
                                className="action-btn"
                                onClick={() => setAddMenuOpen((v) => !v)}
                                aria-haspopup="menu"
                                aria-expanded={addMenuOpen}
                                title="Add element"
                            >
                                +
                            </button>
                            {addMenuOpen && (
                                <div className="add-menu" role="menu">
                                    <button onClick={() => addBlock("paragraph")}>
                                        Paragraph
                                    </button>
                                    <button onClick={() => addBlock("link")}>Link</button>
                                    <button onClick={() => addBlock("image")}>Image</button>
                                    <button onClick={() => addBlock("divider")}>Divider</button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Deploy panel — visible only in deploy view. */}
            {view === "deploy" && (
                <div className="deploy-panel" role="region" aria-label="Deploy">
                    <h2 className="deploy-title">Deploy your site</h2>

                    <div className="deploy-field">
                        <span className="field-label">Account</span>
                        <span className="account-chip">
                            <span
                                className={`source-dot source-${activeAccount?.source ?? "none"}`}
                            />
                            {activeAccount
                                ? `${activeAccount.displayName} (${activeAccount.source})`
                                : resolvingOwned
                                  ? "connecting…"
                                  : "no signer"}
                        </span>
                        <label className="checkbox">
                            <input
                                type="checkbox"
                                checked={useOwnedAccount}
                                onChange={(e) => setUseOwnedAccount(e.target.checked)}
                                disabled={busy}
                            />
                            <span>
                                Sign with my own account
                                <span className="checkbox-hint"> — default is //Bob</span>
                            </span>
                        </label>
                        {useOwnedAccount && !hostAccount && !extensionAccount && (
                            <button
                                className="pill pill-secondary"
                                onClick={connectExtension}
                                disabled={!hasInjectedExtension() || resolvingOwned || busy}
                            >
                                Connect browser wallet
                            </button>
                        )}
                        {showOwnedHint && (
                            <p className="hint">
                                No host signer detected. Open in{" "}
                                <strong>Polkadot Desktop</strong> or{" "}
                                <strong>Polkadot Mobile</strong>, connect a browser wallet,
                                or untick to deploy as //Bob.
                            </p>
                        )}
                        {ownedError && <p className="hint subtle">{ownedError}</p>}
                    </div>

                    <div className="deploy-field">
                        <label className="field">
                            <span className="field-label">.dot name</span>
                            <input
                                type="text"
                                placeholder="auto-generated if blank"
                                value={domain}
                                onChange={(e) => setDomain(e.target.value.trim())}
                                disabled={busy}
                            />
                        </label>
                    </div>

                    <div className="deploy-field">
                        <span className="field-label">URL</span>
                        <span className="url-preview">
                            {`https://${domain || "<auto>"}.dot.li`}
                        </span>
                    </div>

                    <button
                        className="pill pill-primary pill-wide"
                        onClick={deploy}
                        disabled={!canDeploy}
                    >
                        {busy ? "Deploying…" : "Deploy"}
                    </button>

                    {busy && status && deployStep !== null && (
                        <DeployProgress step={deployStep} status={status} />
                    )}

                    {result && (
                        <div className={`result result-${result.kind}`}>
                            <Row label="bytes">{result.bytes.toLocaleString()} B</Row>
                            <Row label="CID" mono>
                                {result.cid}
                            </Row>
                            <Row label="gateway">
                                <a href={result.gatewayUrl} target="_blank" rel="noopener">
                                    {result.gatewayUrl}
                                </a>
                            </Row>
                            {result.kind === "stored" && (
                                <Row label="block">
                                    #{result.blockNumber.toLocaleString()}
                                </Row>
                            )}
                            {result.kind === "stored" && result.dotMapped ? (
                                <p className="result-note success">
                                    Live on{" "}
                                    <a href={result.url} target="_blank" rel="noopener">
                                        {result.url}
                                    </a>
                                    . Resolution may take a few seconds to propagate.
                                </p>
                            ) : result.kind === "stored" ? (
                                <div className="result-note">
                                    <p>
                                        Stored on Bulletin ✓. The <code>.dot.li</code>{" "}
                                        mapping step failed. Bytes still retrievable via
                                        the gateway link.
                                    </p>
                                    {result.dotError && (
                                        <pre className="error-block">
                                            {result.dotError}
                                        </pre>
                                    )}
                                    {result.dotError && (
                                        <DotErrorHint message={result.dotError} />
                                    )}
                                </div>
                            ) : (
                                <p className="result-note">
                                    Preview only — chain submission for{" "}
                                    {activeAccount?.source ?? "this signer"} isn't wired.
                                    Untick "Sign with my own account" to deploy as //Bob.
                                </p>
                            )}
                        </div>
                    )}
                    {deployError && (
                        <pre className="error error-block">{deployError}</pre>
                    )}
                </div>
            )}

            {/* Bottom centered nav — 3 tabs, always visible. */}
            <nav className="bottom-nav" aria-label="View">
                <div className="bottom-nav-pill">
                    <NavTab
                        active={view === "edit"}
                        onClick={() => {
                            setView("edit");
                            setAddMenuOpen(false);
                        }}
                        icon={<PencilIcon />}
                        label="Edit"
                    />
                    <NavTab
                        active={view === "preview"}
                        onClick={() => {
                            setView("preview");
                            setAddMenuOpen(false);
                        }}
                        icon={<EyeIcon />}
                        label="Preview"
                    />
                    <NavTab
                        active={view === "deploy"}
                        onClick={() => {
                            setView("deploy");
                            setAddMenuOpen(false);
                        }}
                        icon={<RocketIcon />}
                        label="Deploy"
                    />
                </div>
            </nav>
        </>
    );
}

function DeployProgress({ step, status }: { step: number; status: string }) {
    const currentStep = DEPLOY_STEPS[Math.min(step, DEPLOY_STEPS.length - 1)];
    const stepNumber = Math.min(step + 1, DEPLOY_STEPS.length);

    return (
        <div className="deploy-progress" role="status" aria-live="polite">
            <div className="progress-meta">
                <span>{`Step ${stepNumber} of ${DEPLOY_STEPS.length}`}</span>
                <span>{currentStep.label}</span>
            </div>
            <div
                className="progress-bar"
                role="progressbar"
                aria-valuemin={1}
                aria-valuemax={DEPLOY_STEPS.length}
                aria-valuenow={stepNumber}
                aria-valuetext={`${currentStep.label}: ${status}`}
            >
                {DEPLOY_STEPS.map((deployStep, index) => (
                    <span
                        key={deployStep.id}
                        className={[
                            "progress-segment",
                            index < step ? "is-complete" : "",
                            index === step ? "is-active" : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        aria-hidden="true"
                    />
                ))}
            </div>
            <div className="status">{status}</div>
        </div>
    );
}

function NavTab({
    active,
    onClick,
    icon,
    label,
}: {
    active: boolean;
    onClick: () => void;
    icon: React.ReactNode;
    label: string;
}) {
    return (
        <button
            type="button"
            className={`nav-tab ${active ? "is-active" : ""}`}
            onClick={onClick}
            aria-pressed={active}
        >
            {icon}
            <span className="nav-tab-label">{label}</span>
        </button>
    );
}

function ColorSwatch({
    label,
    value,
    onChange,
}: {
    label: string;
    value: string;
    onChange: (next: string) => void;
}) {
    return (
        <label
            className="swatch"
            title={`${label}: ${value}`}
            style={{ background: value }}
        >
            <span className="sr-only">{label}</span>
            <input
                type="color"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                aria-label={`${label} color`}
            />
        </label>
    );
}

function BlockView({
    block,
    accentColor,
    editable,
    onUpdate,
    onRemove,
}: {
    block: Block;
    accentColor: string;
    editable: boolean;
    onUpdate: (next: Block) => void;
    onRemove: () => void;
}) {
    return (
        <div className={`block ${editable ? "is-editing" : ""}`}>
            {editable && (
                <button
                    className="block-remove"
                    onClick={onRemove}
                    aria-label={`Remove ${block.type}`}
                    title="Remove"
                >
                    ×
                </button>
            )}
            {block.type === "paragraph" && (
                <Editable
                    tag="p"
                    value={block.text}
                    onChange={(text) => onUpdate({ ...block, text })}
                    editable={editable}
                    className="site-paragraph"
                    placeholder="Paragraph text"
                />
            )}
            {block.type === "link" && (
                <p className="block-link">
                    {editable ? (
                        <>
                            <Editable
                                tag="span"
                                value={block.label}
                                onChange={(label) => onUpdate({ ...block, label })}
                                editable
                                className="site-link"
                                style={{ color: accentColor }}
                                placeholder="Link text"
                            />
                            <Editable
                                tag="span"
                                value={block.url}
                                onChange={(url) => onUpdate({ ...block, url })}
                                editable
                                className="site-link-url"
                                placeholder="https://"
                            />
                        </>
                    ) : (
                        <a
                            href={block.url}
                            target="_blank"
                            rel="noopener"
                            className="site-link"
                            style={{ color: accentColor }}
                        >
                            {block.label}
                        </a>
                    )}
                </p>
            )}
            {block.type === "image" && (
                <>
                    {block.url && block.url !== "https://" ? (
                        <img className="site-image" src={block.url} alt={block.alt} />
                    ) : editable ? (
                        <div className="site-image-placeholder">No image URL yet</div>
                    ) : null}
                    {editable && (
                        <Editable
                            tag="span"
                            value={block.url}
                            onChange={(url) => onUpdate({ ...block, url })}
                            editable
                            className="site-link-url"
                            placeholder="https:// image URL"
                        />
                    )}
                </>
            )}
            {block.type === "divider" && <hr className="site-divider" />}
        </div>
    );
}

// Heuristic hint mapping common DotNS failures to actionable next steps.
// The error strings come from pallet-revive dispatch errors, JSON-serialised
// in submit-and-wait, so they're greppable.
function DotErrorHint({ message }: { message: string }) {
    const lower = message.toLowerCase();

    if (
        lower.includes("balance") ||
        lower.includes("fundsunavailable") ||
        lower.includes("inability to pay") ||
        lower.includes("storage deposit")
    ) {
        return (
            <p className="hint">
                <strong>Likely cause:</strong> //Bob has no PAS on Asset Hub Next to
                pay contract fees. Hit the{" "}
                <a
                    href="https://faucet.polkadot.io/?parachain=1500"
                    target="_blank"
                    rel="noopener"
                >
                    Paseo Asset Hub Next faucet
                </a>{" "}
                (paste //Bob's address:{" "}
                <code>5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty</code>) and
                retry.
            </p>
        );
    }

    if (lower.includes("already registered") || lower.includes("already taken")) {
        return (
            <p className="hint">
                <strong>Likely cause:</strong> someone else already registered this
                name. Pick a different <code>.dot</code> name and retry.
            </p>
        );
    }

    if (lower.includes("accountunmapped") || lower.includes("mapping did not propagate")) {
        return (
            <p className="hint">
                <strong>Likely cause:</strong> //Bob's SS58 → H160 mapping hasn't
                landed yet. Wait ~30 s and retry — the map_account extrinsic needs to
                finalise before contracts will accept calls.
            </p>
        );
    }

    if (lower.includes("commitment") && lower.includes("not found")) {
        return (
            <p className="hint">
                <strong>Likely cause:</strong> the commitment expired between the
                two-step register. Just retry — the commit-reveal flow restarts from
                scratch.
            </p>
        );
    }

    if (lower.includes("priceofcommitmenttoolow") || lower.includes("invalidpayment")) {
        return (
            <p className="hint">
                <strong>Likely cause:</strong> the price the contract demanded
                exceeded our 10 % buffer (PoP rules may have changed mid-flight).
                Retry — the price is re-quoted each attempt.
            </p>
        );
    }

    return (
        <p className="hint">
            Unknown failure. The dispatch-error JSON above is from pallet-revive —
            pasting it into chat will help diagnose. Common culprits: //Bob has no
            PAS for fees, name already taken, or the AH-Next RPC choked.
        </p>
    );
}

function Row({
    label,
    children,
    mono,
}: {
    label: string;
    children: React.ReactNode;
    mono?: boolean;
}) {
    return (
        <div className="row-line">
            <span className="row-label">{label}</span>
            <span className={`row-value${mono ? " mono" : ""}`}>{children}</span>
        </div>
    );
}

// Inline SVG icons. Lightweight, no dep.
function PencilIcon() {
    return (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
        </svg>
    );
}
function EyeIcon() {
    return (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
        </svg>
    );
}
function RocketIcon() {
    return (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
            <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
            <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
            <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
        </svg>
    );
}
