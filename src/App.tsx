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

type DeployResult = DeployPreview | DeploySuccess;

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
    const [editMode, setEditMode] = useState(true); // Land in edit mode so the affordances are immediately discoverable.
    const [domain, setDomain] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [result, setResult] = useState<DeployResult | null>(null);
    const [deployError, setDeployError] = useState<string | null>(null);
    const [addMenuOpen, setAddMenuOpen] = useState(false);
    const [showSettings, setShowSettings] = useState(false);

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
        setStatus(null);
        try {
            const html = renderHtml(content);
            if (activeAccount?.source === "dev") {
                const stored = await deployFull(html, domain || null, activeAccount, setStatus);
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
        }
    };

    const canDeploy = !busy && activeAccount !== null;
    const showOwnedHint =
        useOwnedAccount && !hostAccount && !extensionAccount && !resolvingOwned;

    // Site styles — applied to the live editing surface AND honoured by the
    // deploy serializer (template.ts::renderHtml). Single source of truth.
    const siteStyle = {
        background: content.background,
        fontFamily: content.fontFamily,
    } as const;

    return (
        <>
            <main className={`site ${editMode ? "is-editing" : ""}`} style={siteStyle}>
                <article className="site-inner">
                    <Editable
                        tag="h1"
                        value={content.header}
                        onChange={(v) => update("header", v)}
                        editable={editMode}
                        className="site-header"
                        style={{ color: content.accentColor }}
                        ariaLabel="Page header"
                        placeholder="Your big heading"
                    />
                    <Editable
                        tag="p"
                        value={content.subheader}
                        onChange={(v) => update("subheader", v)}
                        editable={editMode}
                        className="site-subheader"
                        ariaLabel="Page subheader"
                        placeholder="Subheader text"
                    />
                    {content.blocks.map((block) => (
                        <BlockView
                            key={block.id}
                            block={block}
                            accentColor={content.accentColor}
                            editable={editMode}
                            onUpdate={(b) => updateBlock(block.id, () => b)}
                            onRemove={() => removeBlock(block.id)}
                        />
                    ))}
                    {editMode && content.blocks.length === 0 && (
                        <p className="site-tip">
                            Tip: click any text to edit. Use the + button in the corner to
                            add sections.
                        </p>
                    )}
                </article>
            </main>

            {/* Top-right floating: Edit ↔ Done toggle + action bar (edit only) */}
            <div className="float-top">
                <button
                    className="pill pill-toggle"
                    onClick={() => {
                        setEditMode((v) => !v);
                        setAddMenuOpen(false);
                    }}
                    aria-pressed={editMode}
                >
                    {editMode ? "Done" : "Edit"}
                </button>
                {editMode && (
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
                        <button
                            className={`action-btn ${showSettings ? "is-active" : ""}`}
                            onClick={() => setShowSettings((v) => !v)}
                            aria-pressed={showSettings}
                            title="Settings"
                        >
                            ⚙
                        </button>
                    </div>
                )}
            </div>

            {/* Bottom-right floating: Deploy. Visible in both modes. */}
            <div className="float-bottom">
                <button
                    className="pill pill-primary"
                    onClick={deploy}
                    disabled={!canDeploy}
                >
                    {busy ? "Deploying…" : "Deploy"}
                </button>
            </div>

            {/* Settings sheet — slides up bottom-right (desktop) / full-width (mobile) */}
            {showSettings && (
                <div className="settings-sheet" role="dialog" aria-label="Settings">
                    <div className="settings-row">
                        <label className="field">
                            <span className="field-label">.dot name</span>
                            <input
                                type="text"
                                placeholder="auto-generated if blank"
                                value={domain}
                                onChange={(e) => setDomain(e.target.value.trim())}
                            />
                        </label>
                    </div>
                    <div className="settings-row">
                        <span className="account-chip">
                            <span className={`source-dot source-${activeAccount?.source ?? "none"}`} />
                            {activeAccount
                                ? `${activeAccount.displayName} (${activeAccount.source})`
                                : resolvingOwned
                                  ? "connecting…"
                                  : "no signer"}
                        </span>
                    </div>
                    <div className="settings-row">
                        <label className="checkbox">
                            <input
                                type="checkbox"
                                checked={useOwnedAccount}
                                onChange={(e) => setUseOwnedAccount(e.target.checked)}
                            />
                            <span>
                                Sign with my own account
                                <span className="checkbox-hint"> — default is //Bob</span>
                            </span>
                        </label>
                    </div>
                    {useOwnedAccount && !hostAccount && !extensionAccount && (
                        <div className="settings-row">
                            <button
                                className="pill pill-secondary"
                                onClick={connectExtension}
                                disabled={!hasInjectedExtension() || resolvingOwned}
                            >
                                Connect browser wallet
                            </button>
                        </div>
                    )}
                    {showOwnedHint && (
                        <p className="hint">
                            No host signer detected. Open this app in{" "}
                            <strong>Polkadot Desktop</strong> or{" "}
                            <strong>Polkadot Mobile</strong>, click{" "}
                            <strong>Connect browser wallet</strong>, or untick the box to
                            deploy as //Bob.
                        </p>
                    )}
                    {ownedError && <p className="hint subtle">{ownedError}</p>}
                </div>
            )}

            {(busy || result || deployError) && (
                <DeployOverlay
                    busy={busy}
                    status={status}
                    result={result}
                    error={deployError}
                    account={activeAccount}
                    onDismiss={() => {
                        setResult(null);
                        setDeployError(null);
                    }}
                />
            )}
        </>
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

function DeployOverlay({
    busy,
    status,
    result,
    error,
    account,
    onDismiss,
}: {
    busy: boolean;
    status: string | null;
    result: DeployResult | null;
    error: string | null;
    account: ActiveAccount | null;
    onDismiss: () => void;
}) {
    return (
        <div className="overlay" role="dialog" aria-live="polite">
            <div className="overlay-card">
                {busy && (
                    <>
                        <h3>Deploying…</h3>
                        <p className="status">{status ?? "Starting up"}</p>
                    </>
                )}
                {!busy && result && (
                    <>
                        <h3>{result.kind === "stored" ? "Deployed" : "Preview"}</h3>
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
                            <Row label="block">#{result.blockNumber.toLocaleString()}</Row>
                        )}
                        <Row label="signed by">
                            {account
                                ? `${account.displayName} (${account.source})`
                                : "— no signer —"}
                        </Row>
                        {result.kind === "stored" && result.dotMapped ? (
                            <p className="result-note success">
                                Live on{" "}
                                <a href={result.url} target="_blank" rel="noopener">
                                    {result.url}
                                </a>
                                . Resolution may take a few seconds to propagate.
                            </p>
                        ) : result.kind === "stored" ? (
                            <p className="result-note">
                                Stored on Bulletin ✓. The <code>.dot.li</code> mapping
                                step failed — see status banner for details. Bytes still
                                retrievable via the gateway link above.
                            </p>
                        ) : (
                            <p className="result-note">
                                Preview only — chain submission for{" "}
                                {account?.source ?? "this signer"} isn't wired. Untick
                                "Sign with my own account" to deploy as //Bob.
                            </p>
                        )}
                        <button className="pill pill-secondary" onClick={onDismiss}>
                            Close
                        </button>
                    </>
                )}
                {!busy && error && (
                    <>
                        <h3>Deploy failed</h3>
                        <pre className="error error-block">{error}</pre>
                        <button className="pill pill-secondary" onClick={onDismiss}>
                            Close
                        </button>
                    </>
                )}
            </div>
        </div>
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
