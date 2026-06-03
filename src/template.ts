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

export const FONT_OPTIONS = [
    { value: "system-ui", label: "System" },
    { value: "Georgia, serif", label: "Serif" },
    { value: "'Courier New', monospace", label: "Mono" },
    { value: "'Comic Sans MS', cursive", label: "Comic Sans" },
    { value: "Impact, sans-serif", label: "Impact" },
] as const;

const escape = (s: string): string =>
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
    if (/^https?:\/\//i.test(v)) return escape(v);
    if (v.startsWith("/") || v.startsWith("./") || v.startsWith("#")) return escape(v);
    return "#";
}

function renderBlock(block: Block): string {
    switch (block.type) {
        case "paragraph":
            return `<p>${escape(block.text)}</p>`;
        case "link": {
            const wrap = block.variant === "pill" ? ' class="pill"' : "";
            return `<p${wrap}><a href="${safeUrl(block.url)}" target="_blank" rel="noopener">${escape(block.label)}</a></p>`;
        }
        case "image": {
            const cls = block.variant === "avatar" ? ' class="avatar"' : "";
            return `<img${cls} src="${safeUrl(block.url)}" alt="${escape(block.alt)}">`;
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
}

// The shared page chrome: full HTML document with inline CSS, wrapping
// whatever body markup the caller produced (rendered blocks or markdown).
export function renderShell(title: string, bodyHtml: string, theme: PageTheme): string {
    const accent = escape(theme.accentColor);
    const background = escape(theme.background);
    const font = escape(theme.fontFamily);
    const colors = siteColors(theme.background);
    const accentContrast = siteColors(theme.accentColor).foreground;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
:root { color-scheme: ${colors.colorScheme}; }
* { box-sizing: border-box; }
body {
    margin: 0;
    padding: 64px 24px;
    background: ${background};
    color: ${colors.foreground};
    font-family: ${font};
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
.subheader { margin: 0 0 32px; font-size: 18px; opacity: 0.85; }
h2, h3 { letter-spacing: -0.01em; line-height: 1.2; margin: 32px 0 12px; }
h2 { font-size: 28px; }
h3 { font-size: 22px; }
p { margin: 0 0 16px; }
ul, ol { margin: 0 0 16px; padding-left: 24px; }
li { margin: 4px 0; }
blockquote { margin: 0 0 16px; padding-left: 16px; border-left: 3px solid ${accent}; opacity: 0.85; }
code { font-family: ui-monospace, Menlo, monospace; font-size: 0.9em; background: ${colors.divider}; padding: 2px 5px; border-radius: 4px; }
pre { margin: 0 0 16px; padding: 16px; background: ${colors.divider}; border-radius: 12px; overflow-x: auto; }
pre code { background: none; padding: 0; }
a { color: ${accent}; text-decoration: underline; text-underline-offset: 3px; }
a:hover { opacity: 0.8; }
img { max-width: 100%; height: auto; border-radius: 12px; margin: 16px 0; }
img.avatar {
    width: 160px; height: 160px;
    border-radius: 50%;
    object-fit: cover;
    margin: 24px auto;
    display: block;
}
p.pill { text-align: center; margin: 20px 0; }
p.pill a {
    display: inline-block;
    min-width: 200px;
    padding: 14px 24px;
    background: ${accent};
    color: ${accentContrast};
    border-radius: 12px;
    text-decoration: none;
    font-weight: 600;
}
hr { border: 0; border-top: 1px solid ${colors.divider}; margin: 32px 0; }
footer { margin-top: 64px; opacity: 0.4; font-size: 12px; }
.profile-header {
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
}
</style>
</head>
<body>
<main>
    ${bodyHtml}
    <footer>made with <a href="https://github.com/shawntabrizi/hello-playground" target="_blank" rel="noopener">hello-playground</a></footer>
</main>
</body>
</html>
`;
}

export function renderHtml(content: SiteContent): string {
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
            <h1>${escape(content.header)}</h1>
            <p class="subheader">${escape(content.subheader)}</p>
        </div>
    </header>`
        : `<h1>${escape(content.header)}</h1>
    <p class="subheader">${escape(content.subheader)}</p>`;

    return renderShell(content.header || "hello", `${headerHtml}\n    ${blocks}`, content);
}
