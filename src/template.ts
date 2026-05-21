// The site model + the renderer. `renderHtml(content)` returns a complete,
// self-contained HTML document — inline CSS, no external assets, no JS — so
// the result is a single byte blob we can hash and store in one
// TransactionStorage.store call.

export type Block =
    | { id: string; type: "paragraph"; text: string }
    | { id: string; type: "link"; label: string; url: string }
    | { id: string; type: "image"; url: string; alt: string }
    | { id: string; type: "divider" };

export interface SiteContent {
    header: string;
    subheader: string;
    accentColor: string;
    background: string;
    fontFamily: string;
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
        case "link":
            return `<p><a href="${safeUrl(block.url)}" target="_blank" rel="noopener">${escape(
                block.label,
            )}</a></p>`;
        case "image":
            return `<img src="${safeUrl(block.url)}" alt="${escape(block.alt)}">`;
        case "divider":
            return `<hr>`;
    }
}

export function renderHtml(content: SiteContent): string {
    const title = content.header || "hello";
    const accent = escape(content.accentColor);
    const background = escape(content.background);
    const font = escape(content.fontFamily);
    const blocks = content.blocks.map(renderBlock).join("\n        ");

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
    margin: 0;
    padding: 64px 24px;
    background: ${background};
    color: #f5f5f5;
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
p { margin: 0 0 16px; }
a { color: ${accent}; text-decoration: underline; text-underline-offset: 3px; }
a:hover { opacity: 0.8; }
img { max-width: 100%; height: auto; border-radius: 12px; margin: 16px 0; }
hr { border: 0; border-top: 1px solid rgba(255,255,255,0.15); margin: 32px 0; }
footer { margin-top: 64px; opacity: 0.4; font-size: 12px; }
</style>
</head>
<body>
<main>
    <h1>${escape(content.header)}</h1>
    <p class="subheader">${escape(content.subheader)}</p>
    ${blocks}
    <footer>made with hello-playground</footer>
</main>
</body>
</html>
`;
}
