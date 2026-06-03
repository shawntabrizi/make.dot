// The site model + the renderer. `renderHtml(content)` returns a complete,
// self-contained HTML document — inline CSS, no external assets, no JS — so
// the result is a single byte blob we can hash and store in one
// TransactionStorage.store call.

export type ImageVariant = "default" | "avatar";
export type LinkVariant = "default" | "pill";

export type Block =
    | { id: string; type: "paragraph"; text: string; locked?: boolean }
    | {
          id: string;
          type: "link";
          label: string;
          url: string;
          variant?: LinkVariant;
          locked?: boolean;
      }
    | {
          id: string;
          type: "image";
          url: string;
          alt: string;
          variant?: ImageVariant;
          locked?: boolean;
      }
    | { id: string; type: "divider"; locked?: boolean };

export type Layout = "default" | "profile";

export interface SiteContent {
    header: string;
    subheader: string;
    accentColor: string;
    background: string;
    fontFamily: string;
    /** Base body font size. Unset = 16px. */
    fontSize?: string;
    /** Body text color. Unset = auto-picked for WCAG contrast against the background. */
    textColor?: string;
    layout?: Layout;
    blocks: Block[];
}

export const DEFAULT_CONTENT: SiteContent = {
    header: "Hello, world",
    subheader: "This is your page. Click anything to make it yours.",
    accentColor: "#e6007a",
    background: "#0b0d12",
    fontFamily: "system-ui",
    blocks: [],
};

export const DEFAULT_FONT_SIZE = "16px";

export const FONT_OPTIONS = [
    { value: "system-ui", label: "System" },
    { value: "Georgia, serif", label: "Serif" },
    { value: "'Courier New', monospace", label: "Mono" },
    { value: "'Comic Sans MS', cursive", label: "Comic Sans" },
    { value: "Impact, sans-serif", label: "Impact" },
] as const;

export const escapeHtml = (s: string): string =>
    s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

// Pick a body text color that meets WCAG contrast against the background.
// 0.179 is the standard sRGB relative-luminance crossover where black vs.
// white text trade contrast dominance. If the user typed a non-hex value
// (e.g. a CSS keyword the picker doesn't produce), default to dark-mode.
export function isLightBackground(bg: string): boolean {
    const m = bg.replace("#", "").match(/^[0-9a-f]{6}$/i) ? bg.replace("#", "") : null;
    if (!m) return false;
    const parts = m.match(/.{2}/g);
    if (!parts) return false;
    const [r, g, b] = parts.map((h) => parseInt(h, 16) / 255);
    const lin = (c: number) =>
        c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return lum >= 0.179;
}

export interface SiteColors {
    foreground: string;
    divider: string;
    colorScheme: "dark" | "light";
}

export function siteColors(background: string): SiteColors {
    const light = isLightBackground(background);
    return {
        foreground: light ? "#0b0d12" : "#f5f5f5",
        divider: light ? "rgba(0,0,0,0.15)" : "rgba(255,255,255,0.15)",
        colorScheme: light ? "light" : "dark",
    };
}

// URL-allowlist guard so an image/link block can't smuggle a javascript: URL
// into the produced page. http(s) and relative paths only.
function safeUrl(raw: string): string {
    const v = raw.trim();
    if (!v) return "#";
    if (/^https?:\/\//i.test(v)) return escapeHtml(v);
    if (v.startsWith("/") || v.startsWith("./") || v.startsWith("#")) return escapeHtml(v);
    return "#";
}

function renderBlock(block: Block): string {
    switch (block.type) {
        case "paragraph":
            return `<p>${escapeHtml(block.text)}</p>`;
        case "link": {
            const wrap = block.variant === "pill" ? ' class="pill"' : "";
            return `<p${wrap}><a href="${safeUrl(block.url)}" target="_blank" rel="noopener">${escapeHtml(block.label)}</a></p>`;
        }
        case "image": {
            const cls = block.variant === "avatar" ? ' class="avatar"' : "";
            return `<img${cls} src="${safeUrl(block.url)}" alt="${escapeHtml(block.alt)}">`;
        }
        case "divider":
            return `<hr>`;
    }
}

// The theme inputs the document shell needs — a subset of SiteContent so the
// markdown renderer can reuse the shell without a full block model.
export interface PageTheme {
    accentColor: string;
    background: string;
    fontFamily: string;
    fontSize?: string;
    textColor?: string;
}

// Optional CSS chunks, keyed by feature. Only the chunks a page actually uses
// are emitted — keeps layout-specific rules from bleeding into the document
// handed to the raw-HTML editor, and trims bytes off the deploy artifact.
export type ShellFeature = "subheader" | "markdown" | "avatar" | "pill" | "profile";

interface FeatureCssContext {
    accent: string;
    accentContrast: string;
    divider: string;
}

const FEATURE_CSS: Record<ShellFeature, (ctx: FeatureCssContext) => string> = {
    subheader: () => `.subheader { margin: 0 0 32px; font-size: 18px; opacity: 0.85; }`,
    markdown: ({ accent, divider }) => `h2, h3 { letter-spacing: -0.01em; line-height: 1.2; margin: 32px 0 12px; }
h2 { font-size: 28px; }
h3 { font-size: 22px; }
ul, ol { margin: 0 0 16px; padding-left: 24px; }
li { margin: 4px 0; }
blockquote { margin: 0 0 16px; padding-left: 16px; border-left: 3px solid ${accent}; opacity: 0.85; }
code { font-family: ui-monospace, Menlo, monospace; font-size: 0.9em; background: ${divider}; padding: 2px 5px; border-radius: 4px; }
pre { margin: 0 0 16px; padding: 16px; background: ${divider}; border-radius: 12px; overflow-x: auto; }
pre code { background: none; padding: 0; }`,
    avatar: () => `img.avatar {
    width: 160px; height: 160px;
    border-radius: 50%;
    object-fit: cover;
    margin: 24px auto;
    display: block;
}`,
    pill: ({ accent, accentContrast }) => `p.pill { text-align: center; margin: 20px 0; }
p.pill a {
    display: inline-block;
    min-width: 200px;
    padding: 14px 24px;
    background: ${accent};
    color: ${accentContrast};
    border-radius: 12px;
    text-decoration: none;
    font-weight: 600;
}`,
    profile: () => `.profile-header {
    display: flex;
    align-items: center;
    gap: 24px;
    margin: 0 0 32px;
}
.profile-header img.avatar { margin: 0; flex-shrink: 0; }
.profile-header-text { flex: 1; min-width: 0; }
.profile-header-text h1 { margin: 0 0 8px; }
.profile-header-text .subheader { margin: 0; }
@media (max-width: 480px) {
    .profile-header { flex-direction: column; text-align: center; gap: 16px; }
    .profile-header img.avatar { margin: 0 auto; }
}`,
};

// The shell's stylesheet for a theme: base rules plus the requested feature
// chunks. This is what lands in the CSS pane when a site converts to HTML.
export function shellCss(theme: PageTheme, features: readonly ShellFeature[] = []): string {
    const accent = escapeHtml(theme.accentColor);
    const background = escapeHtml(theme.background);
    const font = escapeHtml(theme.fontFamily);
    const colors = siteColors(theme.background);
    const fontSize = theme.fontSize ? escapeHtml(theme.fontSize) : DEFAULT_FONT_SIZE;
    const foreground = theme.textColor ? escapeHtml(theme.textColor) : colors.foreground;
    const accentContrast = siteColors(theme.accentColor).foreground;
    const featureCss = features
        .map((f) => FEATURE_CSS[f]({ accent, accentContrast, divider: colors.divider }))
        .join("\n");

    return `:root { color-scheme: ${colors.colorScheme}; }
* { box-sizing: border-box; }
body {
    margin: 0;
    padding: 64px 24px;
    background: ${background};
    color: ${foreground};
    font-family: ${font};
    font-size: ${fontSize};
    line-height: 1.5;
}
main { max-width: 640px; margin: 0 auto; }
h1 {
    margin: 0 0 16px;
    font-size: clamp(36px, 8vw, 56px);
    font-weight: 800;
    letter-spacing: -0.02em;
    color: ${accent};
    line-height: 1.1;
}
p { margin: 0 0 16px; }
a { color: ${accent}; text-decoration: underline; text-underline-offset: 3px; }
a:hover { opacity: 0.8; }
img { max-width: 100%; height: auto; border-radius: 12px; margin: 16px 0; }
hr { border: 0; border-top: 1px solid ${colors.divider}; margin: 32px 0; }
footer { margin-top: 64px; opacity: 0.4; font-size: 12px; }
${featureCss}`;
}

// The three CodePen-style panes plus the <title>. `title` must already be
// HTML-safe (entity-encoded); css/bodyHtml/js are emitted verbatim.
export interface DocumentParts {
    title: string;
    css: string;
    bodyHtml: string;
    js?: string;
}

// Assemble panes into the final single-file artifact. The <script> tag is
// omitted entirely when there's no JS, so blocks/markdown output stays JS-free.
export function assembleDocument({ title, css, bodyHtml, js }: DocumentParts): string {
    const script = js && js.trim() ? `\n<script>\n${js}\n</script>` : "";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${css}
</style>
</head>
<body>
${bodyHtml}${script}
</body>
</html>
`;
}

// Body wrapper shared by the blocks and markdown renderers: the centered
// column plus the attribution footer.
export function wrapMain(inner: string): string {
    return `<main>
    ${inner}
    <footer>made with <a href="https://github.com/shawntabrizi/hello-playground" target="_blank" rel="noopener">hello-playground</a></footer>
</main>`;
}

export function renderHtmlParts(content: SiteContent): DocumentParts {
    // Profile layout: lift the first avatar block out of the body and put it
    // beside the header/subheader in a two-column row. Falls back to default
    // single-column flow if no avatar block is found.
    const isProfile = content.layout === "profile";
    const avatarIdx = isProfile
        ? content.blocks.findIndex((b) => b.type === "image" && b.variant === "avatar")
        : -1;
    const avatarBlock = avatarIdx >= 0 ? content.blocks[avatarIdx] : null;
    const bodyBlocks = avatarBlock
        ? content.blocks.filter((_, i) => i !== avatarIdx)
        : content.blocks;
    const blocks = bodyBlocks.map(renderBlock).join("\n        ");

    const headerHtml = avatarBlock
        ? `<header class="profile-header">
        ${renderBlock(avatarBlock)}
        <div class="profile-header-text">
            <h1>${escapeHtml(content.header)}</h1>
            <p class="subheader">${escapeHtml(content.subheader)}</p>
        </div>
    </header>`
        : `<h1>${escapeHtml(content.header)}</h1>
    <p class="subheader">${escapeHtml(content.subheader)}</p>`;

    const features: ShellFeature[] = ["subheader"];
    if (content.blocks.some((b) => b.type === "image" && b.variant === "avatar"))
        features.push("avatar");
    if (content.blocks.some((b) => b.type === "link" && b.variant === "pill"))
        features.push("pill");
    if (avatarBlock) features.push("profile");

    return {
        title: escapeHtml(content.header || "hello"),
        css: shellCss(content, features),
        bodyHtml: wrapMain(`${headerHtml}\n    ${blocks}`),
    };
}

export function renderHtml(content: SiteContent): string {
    return assembleDocument(renderHtmlParts(content));
}
