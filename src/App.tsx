import React, { useEffect, useMemo, useState } from "react";
import { Editable } from "./Editable.tsx";
import {
    assembleDocument,
    DEFAULT_CONTENT,
    DEFAULT_FONT_SIZE,
    FONT_OPTIONS,
    renderHtml,
    renderHtmlParts,
    siteColors,
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
import { checkBulletinAuthorization, storeBytes } from "./lib/bulletin/store.ts";
import { resizeImageToFit } from "./image-resize.ts";
import { TEMPLATES, type Template } from "./templates.ts";
import {
    blocksToMarkdown,
    renderMarkdownHtml,
    renderMarkdownParts,
} from "./markdown.ts";

type View = "edit" | "preview" | "deploy";
// The one-way "eject" ladder: blocks → markdown → html are exact conversions;
// going back up restores the last block-editor state (kept in memory) and
// discards the text edits — never a lossy parse.
type EditorMode = "blocks" | "markdown" | "html";
// One open menu at a time — a single state slot makes overlap impossible.
type ActionMenu = "layout" | "colors" | "font" | "add" | "mode";
// HTML mode is CodePen-style: three panes assembled into one document.
type HtmlPane = "html" | "css" | "js";
const PANE_GLYPHS: Record<HtmlPane, string> = { html: "<>", css: "{}", js: "JS" };

// <title> for assembled pane documents: first <h1>'s text, falling back to
// the same default the blocks renderer uses. The h1 markup is already
// entity-encoded, so the result is safe for <title> once tags are stripped.
function titleFromHtml(body: string): string {
    const m = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const text = m ? m[1].replace(/<[^>]*>/g, "").trim() : "";
    return text || "hello";
}
type DeployResult = DeployPreview | DeploySuccess;

interface ProgressStep {
    readonly id: string;
    readonly label: string;
}

const DEPLOY_STEPS: readonly ProgressStep[] = [
    { id: "prepare", label: "Prepare" },
    { id: "bulletin", label: "Store" },
    { id: "account", label: "Account" },
    { id: "name", label: "Name" },
    { id: "commit", label: "Commit" },
    { id: "wait", label: "Wait" },
    { id: "register", label: "Register" },
    { id: "link", label: "Link" },
];

const UPLOAD_STEPS: readonly ProgressStep[] = [
    { id: "prepare", label: "Prepare" },
    { id: "sign", label: "Sign" },
    { id: "broadcast", label: "Broadcast" },
    { id: "in-block", label: "In Block" },
    { id: "finalized", label: "Finalized" },
];

function stepForUploadStatus(message: string): number {
    if (message.startsWith("signing")) return 1;
    if (message.startsWith("broadcasting")) return 2;
    if (message.startsWith("in-block")) return 3;
    if (message.startsWith("finalized")) return 4;
    return 0;
}

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
    const [mode, setMode] = useState<EditorMode>("blocks");
    const [markdownText, setMarkdownText] = useState("");
    // HTML mode panes: body markup, stylesheet, script — CodePen-style.
    const [htmlText, setHtmlText] = useState("");
    const [cssText, setCssText] = useState("");
    const [jsText, setJsText] = useState("");
    const [htmlPane, setHtmlPane] = useState<HtmlPane>("html");
    const [view, setView] = useState<View>("edit");
    const [domain, setDomain] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [deployStep, setDeployStep] = useState<number | null>(null);
    const [result, setResult] = useState<DeployResult | null>(null);
    const [deployError, setDeployError] = useState<string | null>(null);
    const [openMenu, setOpenMenu] = useState<ActionMenu | null>(null);
    const toggleMenu = (menu: ActionMenu) =>
        setOpenMenu((prev) => (prev === menu ? null : menu));
    const [undoPayload, setUndoPayload] = useState<{
        prior: SiteContent;
        templateName: string;
    } | null>(null);

    // Signer state — Bob default, owned-account opt-in.
    const [useOwnedAccount, setUseOwnedAccount] = useState(false);
    const [hostAccount, setHostAccount] = useState<ActiveAccount | null>(null);
    const [extensionAccount, setExtensionAccount] = useState<ActiveAccount | null>(null);
    const [resolvingOwned, setResolvingOwned] = useState(false);
    const [ownedError, setOwnedError] = useState<string | null>(null);
    const [maxStoreBytes, setMaxStoreBytes] = useState<number | null>(null);

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

    useEffect(() => {
        const address = activeAccount?.address;
        if (!address) {
            setMaxStoreBytes(null);
            return;
        }
        let cancelled = false;
        checkBulletinAuthorization(address)
            .then((auth) => {
                if (cancelled) return;
                setMaxStoreBytes(auth.authorized ? Number(auth.bytes) : 0);
            })
            .catch(() => {
                if (!cancelled) setMaxStoreBytes(null);
            });
        return () => {
            cancelled = true;
        };
    }, [activeAccount?.address]);

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
        setOpenMenu(null);
    };

    const applyTemplate = (template: Template) => {
        setUndoPayload({ prior: content, templateName: template.name });
        setContent(template.build());
        setOpenMenu(null);
    };
    const undoTemplate = () => {
        if (!undoPayload) return;
        setContent(undoPayload.prior);
        setUndoPayload(null);
    };
    useEffect(() => {
        if (!undoPayload) return;
        const t = setTimeout(() => setUndoPayload(null), 10000);
        return () => clearTimeout(t);
    }, [undoPayload]);

    // The single HTML source of truth — preview and deploy both consume this,
    // so they stay mode-agnostic.
    const currentHtml = (): string => {
        switch (mode) {
            case "blocks":
                return renderHtml(content);
            case "markdown":
                return renderMarkdownHtml(markdownText, content);
            case "html":
                return assembleDocument({
                    title: titleFromHtml(htmlText),
                    css: cssText,
                    bodyHtml: htmlText,
                    js: jsText,
                });
        }
    };

    const convertToMarkdown = () => {
        if (
            !window.confirm(
                "Convert to Markdown?\n\nYour content becomes plain text — headings, lists, and code become possible. You can return to the simple editor later, but text edits won't carry back.",
            )
        )
            return;
        setMarkdownText(blocksToMarkdown(content));
        setMode("markdown");
        setOpenMenu(null);
    };
    const convertToHtml = () => {
        if (
            !window.confirm(
                "Convert to HTML, CSS & JS?\n\nYour page splits into editable HTML, CSS, and JavaScript panes. You can return to the simple editor later, but edits here won't carry back.",
            )
        )
            return;
        const parts =
            mode === "markdown"
                ? renderMarkdownParts(markdownText, content)
                : renderHtmlParts(content);
        setHtmlText(parts.bodyHtml);
        setCssText(parts.css);
        setJsText("");
        setHtmlPane("html");
        setMode("html");
        setOpenMenu(null);
    };
    const backToSimple = () => {
        if (
            !window.confirm(
                "Back to the simple editor?\n\nThis restores your last block-editor state. Your Markdown/HTML edits will be discarded.",
            )
        )
            return;
        setMode("blocks");
        setOpenMenu(null);
    };

    const uploadImage = async (
        file: File,
        onStatus: (msg: string) => void,
    ): Promise<string> => {
        if (!activeAccount) {
            throw new Error(
                "Sign in first — pick //Bob in the Deploy panel, or connect a wallet.",
            );
        }
        let bytes: Uint8Array;
        let label = `Image (${file.name || "untitled"})`;
        if (maxStoreBytes !== null && file.size > maxStoreBytes) {
            onStatus(
                `Resizing ${(file.size / 1024).toFixed(0)} KB → under ${(maxStoreBytes / 1024).toFixed(0)} KB…`,
            );
            const target = Math.floor(maxStoreBytes * 0.95);
            const resized = await resizeImageToFit(file, target);
            bytes = resized.bytes;
            label = `Image (${resized.filename})`;
            onStatus(
                `Resized ${(resized.originalBytes / 1024).toFixed(0)} KB → ${(resized.finalBytes / 1024).toFixed(0)} KB. Uploading…`,
            );
        } else {
            bytes = new Uint8Array(await file.arrayBuffer());
            onStatus("Uploading to Bulletin…");
        }
        const stored = await storeBytes({
            bytes,
            signer: activeAccount.signer,
            signerAddress: activeAccount.address,
            displayName: activeAccount.displayName,
            label,
            onStatus,
        });
        return stored.ipfsUrl;
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
            const html = currentHtml();
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

    const colors = siteColors(content.background);
    const foreground = content.textColor ?? colors.foreground;
    const siteStyle = {
        background: content.background,
        fontFamily: content.fontFamily,
        fontSize: content.fontSize ?? DEFAULT_FONT_SIZE,
        color: foreground,
        "--site-foreground": foreground,
        "--site-divider": colors.divider,
    } as React.CSSProperties;

    const isProfile = content.layout === "profile";
    const avatarIdx = isProfile
        ? content.blocks.findIndex((b) => b.type === "image" && b.variant === "avatar")
        : -1;
    const avatarBlock = avatarIdx >= 0 ? content.blocks[avatarIdx] : null;
    const bodyBlocks = avatarBlock
        ? content.blocks.filter((_, i) => i !== avatarIdx)
        : content.blocks;

    const titleEditable = (
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
    );
    const subheaderEditable = (
        <Editable
            tag="p"
            value={content.subheader}
            onChange={(v) => update("subheader", v)}
            editable={isEditing}
            className="site-subheader"
            ariaLabel="Page subheader"
            placeholder="A short line about you or this page"
        />
    );

    return (
        <>
            {mode !== "blocks" &&
                (isEditing ? (
                    <main className="code-pane">
                        <textarea
                            className="code-editor"
                            value={
                                mode === "markdown"
                                    ? markdownText
                                    : htmlPane === "css"
                                      ? cssText
                                      : htmlPane === "js"
                                        ? jsText
                                        : htmlText
                            }
                            onChange={(e) => {
                                const v = e.target.value;
                                if (mode === "markdown") setMarkdownText(v);
                                else if (htmlPane === "css") setCssText(v);
                                else if (htmlPane === "js") setJsText(v);
                                else setHtmlText(v);
                            }}
                            spellCheck={false}
                            placeholder={
                                mode === "html" && htmlPane === "js"
                                    ? "// Runs at the end of <body>"
                                    : undefined
                            }
                            aria-label={
                                mode === "markdown"
                                    ? "Markdown source"
                                    : `${htmlPane.toUpperCase()} source`
                            }
                        />
                    </main>
                ) : (
                    // Preview IS the deploy artifact. sandbox without
                    // allow-same-origin: pasted scripts run, but in an opaque
                    // origin that can't reach the app (and its signer).
                    <iframe
                        className="site-frame"
                        title="Site preview"
                        srcDoc={currentHtml()}
                        sandbox="allow-scripts allow-popups"
                    />
                ))}

            {mode === "blocks" && (
            <main className={`site ${isEditing ? "is-editing" : ""}`} style={siteStyle}>
                <article className="site-inner">
                    {avatarBlock ? (
                        <header className="profile-header">
                            <BlockView
                                key={avatarBlock.id}
                                block={avatarBlock}
                                accentColor={content.accentColor}
                                editable={isEditing}
                                onUpdate={(b) => updateBlock(avatarBlock.id, () => b)}
                                onRemove={() => removeBlock(avatarBlock.id)}
                                onUploadImage={uploadImage}
                                maxStoreBytes={maxStoreBytes}
                            />
                            <div className="profile-header-text">
                                {titleEditable}
                                {subheaderEditable}
                            </div>
                        </header>
                    ) : (
                        <>
                            {titleEditable}
                            {subheaderEditable}
                        </>
                    )}
                    {bodyBlocks.map((block) => (
                        <BlockView
                            key={block.id}
                            block={block}
                            accentColor={content.accentColor}
                            editable={isEditing}
                            onUpdate={(b) => updateBlock(block.id, () => b)}
                            onRemove={() => removeBlock(block.id)}
                            onUploadImage={uploadImage}
                            maxStoreBytes={maxStoreBytes}
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
            )}

            {undoPayload && (
                <div className="toast" role="status" aria-live="polite">
                    <span>
                        Applied <strong>{undoPayload.templateName}</strong>
                    </span>
                    <button onClick={undoTemplate}>Undo</button>
                </div>
            )}

            {/* Floating action bar — visible only in edit view; sits above the bottom nav pill. */}
            {isEditing && (
                <div className="float-bottom">
                    <div className="action-bar" role="toolbar" aria-label="Site styling">
                        {mode === "blocks" && (
                        <div className="tmpl-wrap action-item">
                            <button
                                className="action-btn"
                                onClick={() => toggleMenu("layout")}
                                aria-haspopup="menu"
                                aria-expanded={openMenu === "layout"}
                                title="Pick a starter layout"
                            >
                                <svg
                                    width="14"
                                    height="14"
                                    viewBox="0 0 14 14"
                                    fill="currentColor"
                                    aria-hidden="true"
                                >
                                    <rect x="0" y="0" width="6" height="6" rx="1" />
                                    <rect x="8" y="0" width="6" height="6" rx="1" />
                                    <rect x="0" y="8" width="6" height="6" rx="1" />
                                    <rect x="8" y="8" width="6" height="6" rx="1" />
                                </svg>
                            </button>
                            {openMenu === "layout" && (
                                <div className="tmpl-menu" role="menu">
                                    {TEMPLATES.map((t) => (
                                        <button
                                            key={t.id}
                                            onClick={() => applyTemplate(t)}
                                            role="menuitem"
                                        >
                                            <span className="tmpl-name">{t.name}</span>
                                            <span className="tmpl-desc">{t.description}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                            <span className="action-label" aria-hidden="true">
                                Layout
                            </span>
                        </div>
                        )}
                        {mode !== "html" && (
                        <>
                        <div className="colors-wrap action-item">
                            <button
                                className="action-btn"
                                onClick={() => toggleMenu("colors")}
                                aria-haspopup="menu"
                                aria-expanded={openMenu === "colors"}
                                title="Colors"
                            >
                                <PaletteIcon />
                            </button>
                            {openMenu === "colors" && (
                                <div className="colors-menu" role="menu">
                                    <StyleRow
                                        label="Accent"
                                        value={content.accentColor}
                                        onChange={(v) => update("accentColor", v)}
                                    />
                                    <StyleRow
                                        label="Background"
                                        value={content.background}
                                        onChange={(v) => update("background", v)}
                                    />
                                    <StyleRow
                                        label="Text"
                                        value={foreground}
                                        onChange={(v) => update("textColor", v)}
                                    >
                                        {content.textColor && (
                                            <button
                                                className="style-auto"
                                                onClick={() =>
                                                    update("textColor", undefined)
                                                }
                                                title="Auto-pick for contrast against the background"
                                            >
                                                Auto
                                            </button>
                                        )}
                                    </StyleRow>
                                </div>
                            )}
                            <span className="action-label" aria-hidden="true">
                                Colors
                            </span>
                        </div>
                        <div className="font-wrap action-item">
                            <button
                                className="action-btn font-btn"
                                onClick={() => toggleMenu("font")}
                                aria-haspopup="menu"
                                aria-expanded={openMenu === "font"}
                                title="Font family"
                            >
                                Aa
                            </button>
                            {openMenu === "font" && (
                                <div className="font-menu" role="menu">
                                    {FONT_OPTIONS.map((opt) => (
                                        <button
                                            key={opt.value}
                                            role="menuitem"
                                            className={
                                                content.fontFamily === opt.value
                                                    ? "is-active"
                                                    : ""
                                            }
                                            style={{ fontFamily: opt.value }}
                                            onClick={() => {
                                                update("fontFamily", opt.value);
                                                setOpenMenu(null);
                                            }}
                                        >
                                            {opt.label}
                                        </button>
                                    ))}
                                    <FontSizeStepper
                                        value={parseInt(
                                            content.fontSize ?? DEFAULT_FONT_SIZE,
                                            10,
                                        )}
                                        onChange={(n) => update("fontSize", `${n}px`)}
                                    />
                                </div>
                            )}
                            <span className="action-label" aria-hidden="true">
                                Font
                            </span>
                        </div>
                        </>
                        )}
                        {mode === "blocks" && (
                        <div className="add-wrap action-item">
                            <button
                                className="action-btn"
                                onClick={() => toggleMenu("add")}
                                aria-haspopup="menu"
                                aria-expanded={openMenu === "add"}
                                title="Add element"
                            >
                                +
                            </button>
                            {openMenu === "add" && (
                                <div className="add-menu" role="menu">
                                    <button onClick={() => addBlock("paragraph")}>
                                        Paragraph
                                    </button>
                                    <button onClick={() => addBlock("link")}>Link</button>
                                    <button onClick={() => addBlock("image")}>Image</button>
                                    <button onClick={() => addBlock("divider")}>Divider</button>
                                </div>
                            )}
                            <span className="action-label" aria-hidden="true">
                                Add
                            </span>
                        </div>
                        )}
                        {mode === "html" &&
                            (["html", "css", "js"] as const).map((pane) => (
                                <div key={pane} className="action-item">
                                    <button
                                        className={`action-btn pane-btn ${
                                            htmlPane === pane ? "is-active" : ""
                                        }`}
                                        onClick={() => setHtmlPane(pane)}
                                        aria-pressed={htmlPane === pane}
                                        title={`Edit ${pane.toUpperCase()}`}
                                    >
                                        {PANE_GLYPHS[pane]}
                                    </button>
                                    <span className="action-label" aria-hidden="true">
                                        {pane.toUpperCase()}
                                    </span>
                                </div>
                            ))}
                        <ModeSwitcher
                            mode={mode}
                            open={openMenu === "mode"}
                            onToggle={() => toggleMenu("mode")}
                            onMarkdown={convertToMarkdown}
                            onHtml={convertToHtml}
                            onSimple={backToSimple}
                        />
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
                        <StepProgress
                            steps={DEPLOY_STEPS}
                            step={deployStep}
                            status={status}
                        />
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
                            setOpenMenu(null);
                        }}
                        icon={<PencilIcon />}
                        label="Edit"
                    />
                    <NavTab
                        active={view === "preview"}
                        onClick={() => {
                            setView("preview");
                            setOpenMenu(null);
                        }}
                        icon={<EyeIcon />}
                        label="Preview"
                    />
                    <NavTab
                        active={view === "deploy"}
                        onClick={() => {
                            setView("deploy");
                            setOpenMenu(null);
                        }}
                        icon={<RocketIcon />}
                        label="Deploy"
                    />
                </div>
            </nav>
        </>
    );
}

function StepProgress({
    steps,
    step,
    status,
}: {
    steps: readonly ProgressStep[];
    step: number;
    status: string;
}) {
    const currentStep = steps[Math.min(step, steps.length - 1)];
    const stepNumber = Math.min(step + 1, steps.length);

    return (
        <div className="deploy-progress" role="status" aria-live="polite">
            <div className="progress-meta">
                <span>{`Step ${stepNumber} of ${steps.length}`}</span>
                <span>{currentStep.label}</span>
            </div>
            <div
                className="progress-bar"
                role="progressbar"
                aria-valuemin={1}
                aria-valuemax={steps.length}
                aria-valuenow={stepNumber}
                aria-valuetext={`${currentStep.label}: ${status}`}
            >
                {steps.map((s, index) => (
                    <span
                        key={s.id}
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

// The eject ladder's UI: downward conversions (exact) plus the revert back to
// the simple editor. Options depend on where you are on the ladder.
function ModeSwitcher({
    mode,
    open,
    onToggle,
    onMarkdown,
    onHtml,
    onSimple,
}: {
    mode: EditorMode;
    open: boolean;
    onToggle: () => void;
    onMarkdown: () => void;
    onHtml: () => void;
    onSimple: () => void;
}) {
    return (
        <div className="mode-wrap action-item">
            <button
                className="action-btn"
                onClick={onToggle}
                aria-haspopup="menu"
                aria-expanded={open}
                title="Editing mode"
            >
                <CodeIcon />
            </button>
            {open && (
                <div className="mode-menu" role="menu">
                    {mode === "blocks" && (
                        <>
                            <button onClick={onMarkdown} role="menuitem">
                                <span className="tmpl-name">Convert to Markdown</span>
                                <span className="tmpl-desc">
                                    Plain text with headings, lists, code. Same site
                                    design.
                                </span>
                            </button>
                            <button onClick={onHtml} role="menuitem">
                                <span className="tmpl-name">Convert to HTML</span>
                                <span className="tmpl-desc">
                                    Separate HTML, CSS &amp; JS panes —
                                    CodePen-style full control.
                                </span>
                            </button>
                        </>
                    )}
                    {mode === "markdown" && (
                        <button onClick={onHtml} role="menuitem">
                            <span className="tmpl-name">Convert to HTML</span>
                            <span className="tmpl-desc">
                                Separate HTML, CSS &amp; JS panes —
                                CodePen-style full control.
                            </span>
                        </button>
                    )}
                    {mode !== "blocks" && (
                        <button onClick={onSimple} role="menuitem">
                            <span className="tmpl-name">Back to Simple editor</span>
                            <span className="tmpl-desc">
                                Restores your last block-editor state. Text edits here
                                are discarded.
                            </span>
                        </button>
                    )}
                </div>
            )}
            <span className="action-label" aria-hidden="true">
                Mode
            </span>
        </div>
    );
}

// − / value / + stepper for the base font size (px). Clicking the number swaps
// it for a text input; Enter or blur commits, Escape cancels.
function FontSizeStepper({
    value,
    onChange,
}: {
    value: number;
    onChange: (next: number) => void;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    const clamp = (n: number) => Math.min(40, Math.max(8, Math.round(n)));
    const commit = () => {
        if (draft !== null) {
            const n = parseInt(draft, 10);
            if (!Number.isNaN(n)) onChange(clamp(n));
        }
        setDraft(null);
    };
    return (
        <div className="font-size-row" role="group" aria-label="Font size">
            <button
                onClick={() => onChange(clamp(value - 1))}
                aria-label="Decrease font size"
            >
                −
            </button>
            {draft !== null ? (
                <input
                    autoFocus
                    inputMode="numeric"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") commit();
                        if (e.key === "Escape") setDraft(null);
                    }}
                    aria-label="Font size in pixels"
                />
            ) : (
                <button
                    className="font-size-value"
                    onClick={() => setDraft(String(value))}
                    title="Click to type a size"
                >
                    {value}
                </button>
            )}
            <button
                onClick={() => onChange(clamp(value + 1))}
                aria-label="Increase font size"
            >
                +
            </button>
        </div>
    );
}

// A labelled color-picker row inside the Colors menu. `children` slots extra
// controls between the label and the swatch (e.g. the Text row's Auto reset).
function StyleRow({
    label,
    value,
    onChange,
    children,
}: {
    label: string;
    value: string;
    onChange: (next: string) => void;
    children?: React.ReactNode;
}) {
    return (
        <div className="style-row">
            <span className="style-row-label">{label}</span>
            {children}
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
        </div>
    );
}

function BlockView({
    block,
    accentColor,
    editable,
    onUpdate,
    onRemove,
    onUploadImage,
    maxStoreBytes,
}: {
    block: Block;
    accentColor: string;
    editable: boolean;
    onUpdate: (next: Block) => void;
    onRemove: () => void;
    onUploadImage: (file: File, onStatus: (msg: string) => void) => Promise<string>;
    maxStoreBytes: number | null;
}) {
    const [uploadStatus, setUploadStatus] = useState<string | null>(null);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const uploading = uploadStatus !== null;
    const handleFile = async (file: File) => {
        if (block.type !== "image") return;
        setUploadStatus("Reading file…");
        setUploadError(null);
        try {
            const url = await onUploadImage(file, setUploadStatus);
            onUpdate({ ...block, url, alt: block.alt || file.name });
        } catch (cause) {
            setUploadError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setUploadStatus(null);
        }
    };
    return (
        <div className={`block ${editable ? "is-editing" : ""} ${block.locked ? "is-locked" : ""}`}>
            {editable && !block.locked && (
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
                <p className={`block-link ${block.variant === "pill" ? "is-pill" : ""}`}>
                    {editable ? (
                        <>
                            <Editable
                                tag="span"
                                value={block.label}
                                onChange={(label) => onUpdate({ ...block, label })}
                                editable
                                className="site-link"
                                style={
                                    block.variant === "pill"
                                        ? {
                                              background: accentColor,
                                              color: siteColors(accentColor).foreground,
                                          }
                                        : { color: accentColor }
                                }
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
                            style={
                                block.variant === "pill"
                                    ? {
                                          background: accentColor,
                                          color: siteColors(accentColor).foreground,
                                      }
                                    : { color: accentColor }
                            }
                        >
                            {block.label}
                        </a>
                    )}
                </p>
            )}
            {block.type === "image" && block.variant === "avatar" && editable && (
                <>
                    <label className="avatar-upload" title="Change avatar">
                        <input
                            type="file"
                            accept="image/*"
                            disabled={uploading}
                            onChange={async (e) => {
                                const file = e.target.files?.[0];
                                e.target.value = "";
                                if (file) await handleFile(file);
                            }}
                        />
                        {block.url && block.url !== "https://" ? (
                            <img
                                className="site-image is-avatar"
                                src={block.url}
                                alt={block.alt}
                            />
                        ) : (
                            <div className="site-image-placeholder is-avatar">
                                {uploading ? "Uploading…" : "Click to upload"}
                            </div>
                        )}
                        {!uploading && block.url && block.url !== "https://" && (
                            <span className="avatar-overlay" aria-hidden="true">
                                Change
                            </span>
                        )}
                    </label>
                    {(uploading || uploadError) && (
                        <div className="avatar-status">
                            {uploading && uploadStatus && (
                                <StepProgress
                                    steps={UPLOAD_STEPS}
                                    step={stepForUploadStatus(uploadStatus)}
                                    status={uploadStatus}
                                />
                            )}
                            {uploadError && (
                                <pre className="image-upload-error">{uploadError}</pre>
                            )}
                        </div>
                    )}
                </>
            )}
            {block.type === "image" && block.variant === "avatar" && !editable && block.url && block.url !== "https://" && (
                <img className="site-image is-avatar" src={block.url} alt={block.alt} />
            )}
            {block.type === "image" && block.variant !== "avatar" && (
                <>
                    {block.url && block.url !== "https://" ? (
                        <img className="site-image" src={block.url} alt={block.alt} />
                    ) : editable ? (
                        <div className="site-image-placeholder">No image URL yet</div>
                    ) : null}
                    {editable && (
                        <div className="image-controls">
                            <label className="image-upload">
                                <input
                                    type="file"
                                    accept="image/*"
                                    disabled={uploading}
                                    onChange={async (e) => {
                                        const file = e.target.files?.[0];
                                        e.target.value = "";
                                        if (file) await handleFile(file);
                                    }}
                                />
                                <span>
                                    {uploading
                                        ? "Uploading…"
                                        : maxStoreBytes !== null && maxStoreBytes > 0
                                          ? `Upload image (auto-resize → ≤${Math.floor(maxStoreBytes / 1024)} KB)`
                                          : "Upload image"}
                                </span>
                            </label>
                            {uploading && uploadStatus && (
                                <StepProgress
                                    steps={UPLOAD_STEPS}
                                    step={stepForUploadStatus(uploadStatus)}
                                    status={uploadStatus}
                                />
                            )}
                            <Editable
                                tag="span"
                                value={block.url}
                                onChange={(url) => onUpdate({ ...block, url })}
                                editable
                                className="site-link-url"
                                placeholder="https:// or upload above"
                            />
                            {uploadError && (
                                <pre className="image-upload-error">{uploadError}</pre>
                            )}
                        </div>
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
function PaletteIcon() {
    return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2a10 10 0 1 0 0 20c1 0 1.6-.75 1.6-1.7 0-.44-.17-.84-.44-1.13-.26-.29-.43-.68-.43-1.12a1.65 1.65 0 0 1 1.67-1.67h2c3.05 0 5.6-2.5 5.6-5.55C22 6 17.5 2 12 2z" />
            <circle cx="7" cy="11" r="0.5" fill="currentColor" />
            <circle cx="10" cy="7" r="0.5" fill="currentColor" />
            <circle cx="15" cy="7" r="0.5" fill="currentColor" />
        </svg>
    );
}
function CodeIcon() {
    return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
        </svg>
    );
}
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
