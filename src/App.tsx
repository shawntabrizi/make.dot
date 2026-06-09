import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editable } from "./Editable.tsx";

// Lazy: CodeMirror is its own chunk, fetched only when md/html mode is opened.
const CodeEditor = React.lazy(() => import("./CodeEditor.tsx"));
import type { EditorHandle } from "./CodeEditor.tsx";
import {
    assembleDocument,
    DEFAULT_CONTENT,
    DEFAULT_FONT_SIZE,
    FONT_OPTIONS,
    renderHtml,
    renderHtmlParts,
    imageShape,
    imageSize,
    siteColors,
    type Block,
    type ImageShape,
    type ImageVariant,
    type SiteContent,
    type TextAlign,
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
    setCurrentAccount,
} from "./account.ts";
import { isInsideContainerSync } from "@parity/product-sdk-host";
import { TEMPLATES, type Template } from "./templates.ts";
import {
    blocksToMarkdown,
    renderMarkdownHtml,
    renderMarkdownParts,
} from "./markdown.ts";
import { useHostTheme } from "./theme.ts";

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

// Registry metadata derived from the structured site content: name = first
// heading, description = first paragraph. Both fall back to the rendered HTML's
// <title> so markdown/html modes (no blocks) still get a name. An empty name is
// fine — deployFull falls back to the domain label.
function deriveMetadata(content: SiteContent, html: string): { name: string; description?: string } {
    const headingBlock = content.blocks.find((b) => b.type === "heading");
    const paragraphBlock = content.blocks.find((b) => b.type === "paragraph");
    const name =
        (headingBlock && "text" in headingBlock ? headingBlock.text : "").trim() ||
        titleFromHtml(html);
    const description =
        paragraphBlock && "text" in paragraphBlock ? paragraphBlock.text.trim() : "";
    return { name, description: description || undefined };
}

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
    // Registry publish is the final phase — keep it on the last segment.
    if (
        message.startsWith("Listing in playground registry") ||
        message.startsWith("Registry") ||
        message.startsWith("Registry listing failed")
    ) {
        return 7;
    }
    return 0;
}

function makeBlockId(): string {
    return Math.random().toString(36).slice(2, 10);
}

// Draft autosave: the full editing state, debounced into localStorage so a
// refresh/crash never loses work. Undo history is session-only by design.
const STORAGE_KEY = "hello-playground.draft.v1";

interface Draft {
    mode: EditorMode;
    content: SiteContent;
    markdownText: string;
    htmlText: string;
    cssText: string;
    jsText: string;
}

// Older drafts had fixed `header`/`subheader` fields (now heading/paragraph
// blocks) and an `avatar` image variant (now size `small` via imageSize()).
function migrateContent(c: SiteContent & { header?: string; subheader?: string }): SiteContent {
    const lead: Block[] = [];
    if (typeof c.header === "string" && c.header)
        lead.push({ id: makeBlockId(), type: "heading", text: c.header });
    if (typeof c.subheader === "string" && c.subheader)
        lead.push({ id: makeBlockId(), type: "paragraph", text: c.subheader });
    if (lead.length === 0) return c;
    const { header: _h, subheader: _s, ...rest } = c;
    return { ...rest, blocks: [...lead, ...c.blocks] };
}

function loadDraft(): Draft | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const d = JSON.parse(raw) as Draft;
        if (!d || typeof d !== "object") return null;
        if (!d.content || !Array.isArray(d.content.blocks)) return null;
        if (!["blocks", "markdown", "html"].includes(d.mode)) return null;
        return { ...d, content: migrateContent(d.content) };
    } catch {
        // Unavailable storage (private mode, sandbox) or corrupt JSON.
        return null;
    }
}

const initialDraft = loadDraft();

// Add-menu entries. Link and Button are presented as two separate components
// (a Button is a pill-styled link under the hood — no toggle between them).
const BLOCK_PRESETS = {
    heading: () => ({ id: makeBlockId(), type: "heading", text: "Heading" }),
    paragraph: () => ({ id: makeBlockId(), type: "paragraph", text: "Write something here…" }),
    link: () => ({ id: makeBlockId(), type: "link", label: "Link text", url: "https://" }),
    button: () => ({
        id: makeBlockId(),
        type: "link",
        variant: "pill",
        label: "Button text",
        url: "https://",
    }),
    image: () => ({ id: makeBlockId(), type: "image", url: "https://", alt: "" }),
    divider: () => ({ id: makeBlockId(), type: "divider" }),
} satisfies Record<string, () => Block>;
type BlockPreset = keyof typeof BLOCK_PRESETS;

export default function App() {
    const [content, setContent] = useState<SiteContent>(
        initialDraft?.content ?? DEFAULT_CONTENT,
    );
    const [mode, setMode] = useState<EditorMode>(initialDraft?.mode ?? "blocks");
    const [markdownText, setMarkdownText] = useState(initialDraft?.markdownText ?? "");
    // HTML mode panes: body markup, stylesheet, script — CodePen-style.
    const [htmlText, setHtmlText] = useState(initialDraft?.htmlText ?? "");
    const [cssText, setCssText] = useState(initialDraft?.cssText ?? "");
    const [jsText, setJsText] = useState(initialDraft?.jsText ?? "");
    const [htmlPane, setHtmlPane] = useState<HtmlPane>("html");
    const [view, setView] = useState<View>("edit");
    const [domain, setDomain] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [deployStep, setDeployStep] = useState<number | null>(null);
    const [result, setResult] = useState<DeployResult | null>(null);
    const [deployError, setDeployError] = useState<string | null>(null);
    const [openMenu, setOpenMenu] = useState<ActionMenu | null>(null);
    // Which structured block (link/button/image) has its bottom sheet open.
    const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
    const toggleMenu = (menu: ActionMenu) =>
        setOpenMenu((prev) => (prev === menu ? null : menu));

    // Transient toast (e.g. "Link copied"). Auto-clears after a moment; a ref to
    // the pending timer prevents overlapping toasts from cutting each other off.
    const [toast, setToast] = useState<string | null>(null);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const showToast = useCallback((message: string) => {
        setToast(message);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 1800);
    }, []);

    // Mirror the host's light/dark theme onto <html data-theme>. No-op (stays
    // dark) when running standalone with no host transport.
    useHostTheme();

    // Signer — always the //Bob dev account. (The host/extension signing
    // options were removed; deploy signs with //Bob.)
    const activeAccount: ActiveAccount = useMemo(() => getDevAccount(), []);

    // Mirror the active account into the module-level holder so the
    // CloudStorageClient's lazy signer (lib/bulletin/store.ts) picks it up.
    useEffect(() => {
        setCurrentAccount(activeAccount);
    }, [activeAccount]);

    // Debounced draft autosave — every edit lands in localStorage shortly after.
    const draft: Draft = { mode, content, markdownText, htmlText, cssText, jsText };
    const draftRef = useRef(draft);
    draftRef.current = draft;
    useEffect(() => {
        const t = setTimeout(() => {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
            } catch {
                // Storage full/unavailable — autosave is best-effort.
            }
        }, 500);
        return () => clearTimeout(t);
    }, [mode, content, markdownText, htmlText, cssText, jsText]);
    // Flush synchronously when the page is leaving/backgrounding, so an edit
    // made within the debounce window survives a reload or mobile app-switch.
    useEffect(() => {
        const flush = () => {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(draftRef.current));
            } catch {
                // best-effort
            }
        };
        const onVisibility = () => {
            if (document.visibilityState === "hidden") flush();
        };
        window.addEventListener("pagehide", flush);
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            window.removeEventListener("pagehide", flush);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, []);

    // Blocks-mode undo: a snapshot stack over SiteContent. Snapshots are taken
    // OUTSIDE setState updaters (StrictMode double-invokes those) and rapid
    // keystrokes coalesce into one entry per ~800ms burst.
    const contentRef = useRef(content);
    contentRef.current = content;
    const undoStack = useRef<SiteContent[]>([]);
    const redoStack = useRef<SiteContent[]>([]);
    const lastEditAt = useRef(0);
    const snapshotContent = (force = false) => {
        const now = Date.now();
        if (force || now - lastEditAt.current > 800) {
            undoStack.current.push(contentRef.current);
            if (undoStack.current.length > 100) undoStack.current.shift();
        }
        lastEditAt.current = now;
        redoStack.current = [];
    };
    const undoBlocks = () => {
        const prev = undoStack.current.pop();
        if (!prev) return;
        redoStack.current.push(contentRef.current);
        lastEditAt.current = 0; // next edit starts a fresh undo group
        setContent(prev);
    };
    const redoBlocks = () => {
        const next = redoStack.current.pop();
        if (!next) return;
        undoStack.current.push(contentRef.current);
        lastEditAt.current = 0;
        setContent(next);
    };

    // Undo/redo for the CodeMirror editor (markdown/html modes), surfaced by
    // the lazy component once its view mounts.
    const [editorHandle, setEditorHandle] = useState<EditorHandle | null>(null);

    const update = <K extends keyof SiteContent>(key: K, value: SiteContent[K]) => {
        snapshotContent();
        setContent((prev) => ({ ...prev, [key]: value }));
    };
    const updateBlock = (id: string, patcher: (b: Block) => Block) => {
        snapshotContent();
        setContent((prev) => ({
            ...prev,
            blocks: prev.blocks.map((b) => (b.id === id ? patcher(b) : b)),
        }));
    };
    const removeBlock = (id: string) => {
        snapshotContent(true);
        setContent((prev) => ({ ...prev, blocks: prev.blocks.filter((b) => b.id !== id) }));
    };
    const addBlock = (type: BlockPreset) => {
        snapshotContent(true);
        setContent((prev) => ({ ...prev, blocks: [...prev.blocks, BLOCK_PRESETS[type]()] }));
        setOpenMenu(null);
    };

    // Applying a template snapshots into the undo stack like any other edit —
    // the floating Undo button is the recovery path (no separate toast).
    const applyTemplate = (template: Template) => {
        snapshotContent(true);
        setContent(template.build());
        setOpenMenu(null);
    };

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
                "Back to the simple editor?\n\nThis restores your last simple editor state. Your Markdown/HTML edits will be discarded.",
            )
        )
            return;
        setMode("blocks");
        setOpenMenu(null);
    };
    // Upward hop html → markdown: restore the last markdown state, or derive a
    // fresh one from the block content if markdown was never visited.
    const backToMarkdown = () => {
        if (
            !window.confirm(
                "Back to Markdown?\n\nThis restores your last Markdown state. Your HTML edits will be discarded.",
            )
        )
            return;
        if (!markdownText) setMarkdownText(blocksToMarkdown(content));
        setMode("markdown");
        setOpenMenu(null);
    };
    // The Mode menu always lists all three modes; route the transition.
    const switchMode = (target: EditorMode) => {
        if (target === mode) {
            setOpenMenu(null);
            return;
        }
        if (target === "blocks") backToSimple();
        else if (target === "markdown") {
            if (mode === "blocks") convertToMarkdown();
            else backToMarkdown();
        } else {
            convertToHtml();
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

            // Chain access (Bulletin store + DotNS) is host-routed and requires
            // running inside a Polkadot host. Show a clear message instead of
            // letting the SDK throw the raw "Host provider unavailable" error.
            if (!isInsideContainerSync()) {
                const preview = await previewDeploy(html, domain || null);
                setResult(preview);
                setDeployError(
                    "Deploy requires running inside a Polkadot host (Desktop or Mobile). " +
                        "You're previewing standalone — the CID and gateway URL above are " +
                        "computed locally but nothing was submitted to the chain. " +
                        "Open this app inside Polkadot Desktop or Mobile to publish.",
                );
                return;
            }

            // //Bob signs the real chain submissions (Bulletin store + DotNS).
            // PAS funds / Bulletin authorization are checked at submit time
            // inside deployFull, which throws clear errors on failure.
            const stored = await deployFull(
                html,
                domain || null,
                activeAccount,
                updateDeployStatus,
                deriveMetadata(content, html),
            );
            setResult(stored);
        } catch (cause) {
            setDeployError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setBusy(false);
            setStatus(null);
            setDeployStep(null);
        }
    };

    const isEditing = view === "edit";
    const editingBlock =
        isEditing && mode === "blocks"
            ? content.blocks.find((b) => b.id === editingBlockId) ?? null
            : null;
    const canDeploy = !busy;

    const colors = siteColors(content.background);
    const foreground = content.textColor ?? colors.foreground;
    const siteStyle = {
        background: content.background,
        fontFamily: content.fontFamily,
        fontSize: content.fontSize ?? DEFAULT_FONT_SIZE,
        textAlign: content.align ?? "left",
        color: foreground,
        "--site-foreground": foreground,
        "--site-divider": colors.divider,
    } as React.CSSProperties;

    return (
        <>
            {toast && (
                <div className="toast" role="status" aria-live="polite">
                    {toast}
                </div>
            )}
            {mode !== "blocks" &&
                (isEditing ? (
                    <main className="code-pane">
                        <div className="code-card">
                            <div className="code-card-header" aria-hidden="true">
                                {mode === "markdown"
                                    ? "README.md"
                                    : htmlPane === "css"
                                      ? "styles.css"
                                      : htmlPane === "js"
                                        ? "script.js"
                                        : "index.html"}
                            </div>
                        <React.Suspense
                            fallback={
                                <div className="code-editor-loading">
                                    Loading editor…
                                </div>
                            }
                        >
                            <CodeEditor
                                language={mode === "markdown" ? "markdown" : htmlPane}
                                value={
                                    mode === "markdown"
                                        ? markdownText
                                        : htmlPane === "css"
                                          ? cssText
                                          : htmlPane === "js"
                                            ? jsText
                                            : htmlText
                                }
                                onChange={(v) => {
                                    if (mode === "markdown") setMarkdownText(v);
                                    else if (htmlPane === "css") setCssText(v);
                                    else if (htmlPane === "js") setJsText(v);
                                    else setHtmlText(v);
                                }}
                                placeholder={
                                    mode === "html" && htmlPane === "js"
                                        ? "// Runs at the end of <body>"
                                        : undefined
                                }
                                ariaLabel={
                                    mode === "markdown"
                                        ? "Markdown source"
                                        : `${htmlPane.toUpperCase()} source`
                                }
                                onHandle={setEditorHandle}
                            />
                        </React.Suspense>
                        </div>
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
                    {content.blocks.map((block) => (
                        <BlockView
                            key={block.id}
                            block={block}
                            accentColor={content.accentColor}
                            editable={isEditing}
                            onUpdate={(b) => updateBlock(block.id, () => b)}
                            onRemove={() => removeBlock(block.id)}
                            onEdit={() => setEditingBlockId(block.id)}
                            onToast={showToast}
                        />
                    ))}
                    {isEditing && content.blocks.length === 0 && (
                        <p className="site-tip">
                            Click any text to edit. Use the + button below to add
                            paragraphs, links, or images — make it your own.
                        </p>
                    )}
                    {/* Mirrors the footer wrapMain() bakes into the artifact. */}
                    <footer className="site-footer">
                        made with{" "}
                        <a
                            href="https://github.com/shawntabrizi/hello-playground"
                            target="_blank"
                            rel="noopener"
                            style={{ color: content.accentColor }}
                        >
                            hello-playground
                        </a>
                    </footer>
                </article>
            </main>
            )}

            {/* Floating action bar — visible only in edit view; sits above the bottom nav pill. */}
            {isEditing && (
                <div className="float-bottom">
                    {/* Undo/redo satellites: same spot in every mode, thumb-zone
                        reachable, 40px touch targets. */}
                    <button
                        className="float-circle"
                        onClick={
                            mode === "blocks" ? undoBlocks : () => editorHandle?.undo()
                        }
                        disabled={
                            mode === "blocks"
                                ? undoStack.current.length === 0
                                : !editorHandle?.canUndo()
                        }
                        title="Undo"
                        aria-label="Undo"
                    >
                        <UndoIcon />
                    </button>
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
                                    <div
                                        className="font-size-row font-align-row"
                                        role="group"
                                        aria-label="Text alignment"
                                    >
                                        {(["left", "center"] as const).map((a) => (
                                            <button
                                                key={a}
                                                className={
                                                    (content.align ?? "left") === a
                                                        ? "is-active"
                                                        : ""
                                                }
                                                onClick={() =>
                                                    update("align", a as TextAlign)
                                                }
                                            >
                                                {a === "left" ? "Left" : "Center"}
                                            </button>
                                        ))}
                                    </div>
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
                                    <button onClick={() => addBlock("heading")}>
                                        Heading
                                    </button>
                                    <button onClick={() => addBlock("paragraph")}>
                                        Paragraph
                                    </button>
                                    <button onClick={() => addBlock("link")}>Link</button>
                                    <button onClick={() => addBlock("button")}>
                                        Button
                                    </button>
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
                            onSelect={switchMode}
                        />
                    </div>
                    <button
                        className="float-circle"
                        onClick={
                            mode === "blocks" ? redoBlocks : () => editorHandle?.redo()
                        }
                        disabled={
                            mode === "blocks"
                                ? redoStack.current.length === 0
                                : !editorHandle?.canRedo()
                        }
                        title="Redo"
                        aria-label="Redo"
                    >
                        <RedoIcon />
                    </button>
                </div>
            )}

            {editingBlock && (
                <BlockEditSheet
                    block={editingBlock}
                    onUpdate={(b) => updateBlock(editingBlock.id, () => b)}
                    onDelete={() => {
                        removeBlock(editingBlock.id);
                        setEditingBlockId(null);
                    }}
                    onClose={() => setEditingBlockId(null)}
                />
            )}

            {/* Deploy panel — visible only in deploy view. */}
            {view === "deploy" && (
                <div className="deploy-panel" role="region" aria-label="Deploy">
                    <h2 className="deploy-title">Deploy your site</h2>

                    <div className="deploy-field">
                        <span className="field-label">Account</span>
                        <span className="account-chip">
                            <span
                                className={`source-dot source-${activeAccount.source}`}
                            />
                            {`${activeAccount.displayName} (${activeAccount.source})`}
                        </span>
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
                                    Preview only — the CID and gateway URL are computed
                                    locally but nothing was submitted. Deploy requires
                                    running inside Polkadot Desktop or Mobile (chain
                                    access is host-routed).
                                </p>
                            )}
                            {result.kind === "stored" &&
                                (result.listed ? (
                                    <p className="result-note success">
                                        Listed in playground registry ✓ — your site
                                        appears in the playground.dot grid.
                                    </p>
                                ) : (
                                    <div className="result-note">
                                        <p>
                                            Not listed in the playground registry —
                                            the listing step failed. Your site is still
                                            deployed and reachable via the links above.
                                        </p>
                                        {result.registryError && (
                                            <pre className="error-block">
                                                {result.registryError}
                                            </pre>
                                        )}
                                    </div>
                                ))}
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

// The eject ladder's UI: all three modes are always listed with the current
// one marked. Descriptions signal direction — downward hops are exact
// conversions, upward hops revert and discard — and the confirm dialog
// remains the consent step for any switch that loses edits.
const MODE_NAMES: Record<EditorMode, string> = {
    blocks: "Simple",
    markdown: "Markdown",
    html: "HTML",
};

function modeDescription(target: EditorMode, current: EditorMode): string {
    if (target === current) {
        return {
            blocks: "Visual editing with menus for layout and style.",
            markdown: "Plain-text editing with the same site design.",
            html: "CodePen-style HTML, CSS & JS panes.",
        }[target];
    }
    switch (target) {
        case "blocks":
            return current === "markdown"
                ? "By converting back to Simple, you will lose changes made in Markdown mode."
                : "By converting back to Simple, you will lose changes made in HTML mode.";
        case "markdown":
            return current === "blocks"
                ? "Text, links, and images convert to Markdown. Image sizing and button styling become plain."
                : "By converting back to Markdown, you will lose changes made in HTML mode.";
        case "html":
            return current === "blocks"
                ? "All simple layouts can be converted to HTML."
                : "All Markdown can be converted to HTML.";
    }
}

function ModeSwitcher({
    mode,
    open,
    onToggle,
    onSelect,
}: {
    mode: EditorMode;
    open: boolean;
    onToggle: () => void;
    onSelect: (target: EditorMode) => void;
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
                    {(["blocks", "markdown", "html"] as const).map((target) => (
                        <button
                            key={target}
                            onClick={() => onSelect(target)}
                            role="menuitemradio"
                            aria-checked={target === mode}
                            className={target === mode ? "is-active" : ""}
                        >
                            <span className="tmpl-name">
                                {MODE_NAMES[target]}
                                {target === mode && (
                                    <span className="mode-current"> ✓ current</span>
                                )}
                            </span>
                            <span className="tmpl-desc">
                                {modeDescription(target, mode)}
                            </span>
                        </button>
                    ))}
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

// In edit mode, text blocks stay directly editable inline (the WYSIWYG core);
// structured blocks (link/button/image) render exactly like the preview and
// open the bottom-sheet property editor on tap.
function BlockView({
    block,
    accentColor,
    editable,
    onUpdate,
    onRemove,
    onEdit,
    onToast,
}: {
    block: Block;
    accentColor: string;
    editable: boolean;
    onUpdate: (next: Block) => void;
    onRemove: () => void;
    onEdit: () => void;
    onToast: (message: string) => void;
}) {
    const linkStyle =
        block.type === "link" && block.variant === "pill"
            ? {
                  background: accentColor,
                  color: siteColors(accentColor).foreground,
              }
            : { color: accentColor };
    const structured = block.type === "link" || block.type === "image";
    return (
        <div className={`block ${editable ? "is-editing" : ""}`}>
            {editable && structured && (
                <button
                    className="block-corner block-edit"
                    onClick={onEdit}
                    aria-label={`Edit ${block.type}`}
                    title="Edit"
                >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
                    </svg>
                </button>
            )}
            {editable && (
                <button
                    className="block-corner block-remove"
                    onClick={onRemove}
                    aria-label={`Remove ${block.type}`}
                    title="Remove"
                >
                    ×
                </button>
            )}
            {block.type === "heading" && (
                <Editable
                    tag="h1"
                    value={block.text}
                    onChange={(text) => onUpdate({ ...block, text })}
                    editable={editable}
                    className="site-header"
                    style={{ color: accentColor }}
                    placeholder="Heading"
                />
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
                        <span
                            className="site-link block-tap"
                            style={linkStyle}
                            onClick={onEdit}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => e.key === "Enter" && onEdit()}
                        >
                            {block.label || "Link text"}
                        </span>
                    ) : (
                        <a
                            href={block.url}
                            target="_blank"
                            rel="noopener"
                            className="site-link"
                            style={linkStyle}
                            // In preview (and inside a host webview) `target=_blank`
                            // navigation is blocked, so a click would do nothing.
                            // Copy the URL + toast instead — the same fallback the
                            // deployed page uses.
                            onClick={(e) => {
                                e.preventDefault();
                                const url = block.type === "link" ? block.url : "";
                                navigator.clipboard
                                    ?.writeText(url)
                                    .then(() => onToast("Link copied"))
                                    .catch(() => onToast(url));
                            }}
                        >
                            {block.label}
                        </a>
                    )}
                </p>
            )}
            {block.type === "image" &&
                (block.url && block.url !== "https://" ? (
                    <img
                        className={`site-image is-${imageSize(block.variant)} is-${imageShape(block)} ${editable ? "block-tap" : ""}`}
                        src={block.url}
                        alt={block.alt}
                        onClick={editable ? onEdit : undefined}
                    />
                ) : editable ? (
                    <div
                        className={`site-image-placeholder is-${imageSize(block.variant)} is-${imageShape(block)} block-tap`}
                        onClick={onEdit}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => e.key === "Enter" && onEdit()}
                    >
                        No image yet — tap to edit
                    </div>
                ) : null)}
            {block.type === "divider" && <hr className="site-divider" />}
        </div>
    );
}

// Bottom-sheet property editor for structured blocks. Labeled form fields,
// live updates (the page behind reflects edits as you type), Delete as the
// destructive footer action.
function BlockEditSheet({
    block,
    onUpdate,
    onDelete,
    onClose,
}: {
    block: Block;
    onUpdate: (next: Block) => void;
    onDelete: () => void;
    onClose: () => void;
}) {
    const kind =
        block.type === "link"
            ? block.variant === "pill"
                ? "Button"
                : "Link"
            : "Image";

    return (
        <div className="sheet-backdrop" onClick={onClose}>
            <div
                className="sheet"
                role="dialog"
                aria-label={`Edit ${kind}`}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="sheet-title">Edit {kind}</div>
                {block.type === "link" && (
                    <>
                        <label className="sheet-field">
                            <span>Label</span>
                            <input
                                type="text"
                                value={block.label}
                                onChange={(e) =>
                                    onUpdate({ ...block, label: e.target.value })
                                }
                                placeholder={kind === "Button" ? "Button text" : "Link text"}
                            />
                        </label>
                        <label className="sheet-field">
                            <span>URL</span>
                            <input
                                type="url"
                                value={block.url}
                                onChange={(e) =>
                                    onUpdate({ ...block, url: e.target.value })
                                }
                                placeholder="https://"
                            />
                        </label>
                    </>
                )}
                {block.type === "image" && (
                    <>
                        <label className="sheet-field">
                            <span>Image link</span>
                            <input
                                type="url"
                                value={block.url}
                                onChange={(e) =>
                                    onUpdate({ ...block, url: e.target.value })
                                }
                                placeholder="https://"
                            />
                        </label>
                        <label className="sheet-field">
                            <span>Alt text</span>
                            <input
                                type="text"
                                value={block.alt}
                                onChange={(e) =>
                                    onUpdate({ ...block, alt: e.target.value })
                                }
                                placeholder="Describe the image"
                            />
                        </label>
                        <div className="sheet-field">
                            <span>Size</span>
                            <VariantToggle
                                label="Image size"
                                options={[
                                    { value: "small", name: "Small · 256px" },
                                    { value: "medium", name: "Medium · 512px" },
                                    { value: "large", name: "Large · full" },
                                ]}
                                value={imageSize(block.variant)}
                                onChange={(variant) =>
                                    onUpdate({
                                        ...block,
                                        variant: variant as ImageVariant,
                                        // Pin the shape so changing size never
                                        // silently changes corners.
                                        shape: imageShape(block),
                                    })
                                }
                            />
                        </div>
                        <div className="sheet-field">
                            <span>Shape</span>
                            <VariantToggle
                                label="Image shape"
                                options={[
                                    { value: "circle", name: "Circle" },
                                    { value: "rounded", name: "Rounded" },
                                    { value: "square", name: "Square" },
                                ]}
                                value={imageShape(block)}
                                onChange={(shape) =>
                                    onUpdate({
                                        ...block,
                                        shape: shape as ImageShape,
                                    })
                                }
                            />
                        </div>
                    </>
                )}
                <div className="sheet-actions">
                    <button className="sheet-delete" onClick={onDelete}>
                        Delete
                    </button>
                    <button className="sheet-done" onClick={onClose}>
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
}

// Tiny segmented control for per-block style variants — what makes every
// template block reproducible by hand (avatar images, button links).
function VariantToggle({
    label,
    options,
    value,
    onChange,
}: {
    label: string;
    options: { value: string; name: string }[];
    value: string;
    onChange: (value: string) => void;
}) {
    return (
        <span className="variant-toggle" role="group" aria-label={label}>
            {options.map((opt) => (
                <button
                    key={opt.value}
                    type="button"
                    className={value === opt.value ? "is-active" : ""}
                    aria-pressed={value === opt.value}
                    onClick={() => onChange(opt.value)}
                >
                    {opt.name}
                </button>
            ))}
        </span>
    );
}

// Heuristic hint mapping common DotNS failures to actionable next steps.
// Most strings are pallet-revive dispatch errors (JSON-serialised in
// submit-and-wait, so they're greppable) — but NOT all. Client-side
// transaction-tracking glitches surface here too, and mislabelling those as
// on-chain dispatch errors is what made this screen useless. So we detect the
// client-side signature first, before assuming pallet-revive.
function DotErrorHint({ message }: { message: string }) {
    const lower = message.toLowerCase();

    // Client-side chainHead race in polkadot-api's tx-follower (track-tx):
    // a tracked block gets pruned mid-search and an unguarded `.children`
    // access throws. NOT an on-chain failure — the extrinsic may well have
    // landed. We ship a patch (patches/…observable-client….patch) that guards
    // it; this hint covers any residual transient chainHead hiccup.
    if (
        lower.includes("reading 'children'") ||
        lower.includes("reading \"children\"") ||
        lower.includes("blocks.get")
    ) {
        return (
            <p className="hint">
                <strong>Likely cause:</strong> a transient chain-follower glitch in
                the client (a tracked block was pruned mid-search) — <em>not</em> an
                on-chain failure, so your extrinsic may have actually landed. Just
                retry; if the name now shows as taken, it went through.
            </p>
        );
    }

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
            Unknown failure. The message above may be a pallet-revive dispatch error
            (insufficient PAS, name already taken) <em>or</em> a client/RPC glitch —
            pasting the full text (and the browser console stack trace) into chat
            will help diagnose. Retrying is usually safe.
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
function UndoIcon() {
    return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7v6h6" />
            <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
        </svg>
    );
}
function RedoIcon() {
    return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 7v6h-6" />
            <path d="M3 17a9 9 0 0 1 15-6.7L21 13" />
        </svg>
    );
}
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
