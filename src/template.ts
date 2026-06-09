// The site model + the renderer. `renderHtml(content)` returns a complete,
// self-contained HTML document — inline CSS, no external assets — so the result
// is a single byte blob we can hash and store in one TransactionStorage.store
// call. The only script is a tiny link-click fallback (LINK_FALLBACK_JS): inside
// a Polkadot host webview `target="_blank"` navigation is blocked and a tapped
// link would do nothing, so we copy the URL + toast instead. Normal web visitors
// still navigate as usual.

/** Image sizes — always rendered centered. small=256px, medium=512px, large=full width. */
export type ImageVariant = "small" | "medium" | "large";
/** Corner treatment. "circle" also crops to a 1:1 square. */
export type ImageShape = "circle" | "rounded" | "square";
export type LinkVariant = "default" | "pill";
export type TextAlign = "left" | "center";

// Every block is a regular, user-creatable component: anything a template
// emits can be built by hand from a blank page, and edited or removed after.
// The page title/description are heading/paragraph blocks like everything
// else — there is no fixed header.
export type Block =
    | { id: string; type: "heading"; text: string }
    | { id: string; type: "paragraph"; text: string }
    | {
          id: string;
          type: "link";
          label: string;
          url: string;
          variant?: LinkVariant;
      }
    | {
          id: string;
          type: "image";
          url: string;
          alt: string;
          variant?: ImageVariant;
          shape?: ImageShape;
      }
    | { id: string; type: "divider" };

export interface SiteContent {
    accentColor: string;
    background: string;
    fontFamily: string;
    /** Base body font size. Unset = 16px. */
    fontSize?: string;
    /** Body text color. Unset = auto-picked for WCAG contrast against the background. */
    textColor?: string;
    /** Page text alignment. Unset = left. */
    align?: TextAlign;
    blocks: Block[];
}

// Normalize an image block's size, mapping legacy variants ("avatar" → small,
// "default"/unset → large) so old drafts keep rendering.
export function imageSize(variant?: string): ImageVariant {
    if (variant === "small" || variant === "avatar") return "small";
    if (variant === "medium") return "medium";
    return "large";
}

// Shape with legacy default: small images used to be circles (pfp), so an
// unset shape on a small image stays a circle; everything else is rounded.
export function imageShape(block: { variant?: string; shape?: ImageShape }): ImageShape {
    if (block.shape) return block.shape;
    return imageSize(block.variant) === "small" ? "circle" : "rounded";
}

export const DEFAULT_CONTENT: SiteContent = {
    accentColor: "#e6007a",
    background: "#0b0d12",
    fontFamily: "system-ui",
    blocks: [
        { id: "default-heading", type: "heading", text: "Hello, world" },
        {
            id: "default-paragraph",
            type: "paragraph",
            text: "This is your page. Click anything to make it yours.",
        },
    ],
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

// Link-click fallback injected into the deployed page. On click we try a normal
// new-tab navigation; if the host blocks it (`window.open` returns null inside a
// webview), we copy the URL to the clipboard and flash a toast — so social/
// profile links are never a dead tap inside the Polkadot app. In a regular
// browser `window.open` succeeds and nothing is copied. Kept tiny + dependency-
// free; the toast element is created and styled inline on demand.
export const LINK_FALLBACK_JS = `(function(){
  function toast(msg){
    var t=document.createElement('div');
    t.textContent=msg;
    t.setAttribute('role','status');
    t.style.cssText='position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;max-width:calc(100vw - 32px);padding:10px 16px;background:rgba(20,22,28,0.95);color:#fff;border-radius:12px;font:600 14px/1.3 system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.35);pointer-events:none;';
    document.body.appendChild(t);
    setTimeout(function(){t.remove();},1800);
  }
  document.addEventListener('click',function(e){
    var a=e.target&&e.target.closest&&e.target.closest('a[href]');
    if(!a)return;
    var href=a.getAttribute('href');
    if(!href||href.charAt(0)==='#')return;
    e.preventDefault();
    var win=null;
    try{win=window.open(href,'_blank','noopener');}catch(_){}
    if(win)return;
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(href).then(function(){toast('Link copied');},function(){toast(href);});
    }else{toast(href);}
  });
})();`;

function renderBlock(block: Block): string {
    switch (block.type) {
        case "heading":
            return `<h1>${escapeHtml(block.text)}</h1>`;
        case "paragraph":
            return `<p>${escapeHtml(block.text)}</p>`;
        case "link": {
            const wrap = block.variant === "pill" ? ' class="pill"' : "";
            return `<p${wrap}><a href="${safeUrl(block.url)}" target="_blank" rel="noopener">${escapeHtml(block.label)}</a></p>`;
        }
        case "image": {
            const size = imageSize(block.variant);
            const shape = imageShape(block);
            const classes = [
                ...(size !== "large" ? [`img-${size}`] : []),
                ...(shape !== "rounded" ? [`img-${shape}`] : []),
            ];
            const cls = classes.length ? ` class="${classes.join(" ")}"` : "";
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
    align?: TextAlign;
}

// Optional CSS chunks, keyed by feature. Only the chunks a page actually uses
// are emitted — keeps layout-specific rules from bleeding into the document
// handed to the raw-HTML editor, and trims bytes off the deploy artifact.
export type ShellFeature =
    | "markdown"
    | "img-small"
    | "img-medium"
    | "img-circle"
    | "img-square"
    | "pill";

interface FeatureCssContext {
    accent: string;
    accentContrast: string;
    divider: string;
}

const FEATURE_CSS: Record<ShellFeature, (ctx: FeatureCssContext) => string> = {
    markdown: ({ accent, divider }) => `h2, h3 { letter-spacing: -0.01em; line-height: 1.2; margin: 32px 0 12px; }
h2 { font-size: 28px; }
h3 { font-size: 22px; }
ul, ol { margin: 0 0 16px; padding-left: 24px; }
li { margin: 4px 0; }
blockquote { margin: 0 0 16px; padding-left: 16px; border-left: 3px solid ${accent}; opacity: 0.85; }
code { font-family: ui-monospace, Menlo, monospace; font-size: 0.9em; background: ${divider}; padding: 2px 5px; border-radius: 4px; }
pre { margin: 0 0 16px; padding: 16px; background: ${divider}; border-radius: 12px; overflow-x: auto; }
pre code { background: none; padding: 0; }`,
    "img-small": () => `img.img-small { width: min(256px, 100%); }`,
    "img-medium": () => `img.img-medium { width: min(512px, 100%); }`,
    "img-circle": () => `img.img-circle {
    aspect-ratio: 1;
    object-fit: cover;
    border-radius: 50%;
}`,
    "img-square": () => `img.img-square { border-radius: 0; }`,
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
    const align = theme.align === "center" ? "\n    text-align: center;" : "";
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
    line-height: 1.5;${align}
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
img { display: block; max-width: 100%; height: auto; border-radius: 12px; margin: 16px auto; }
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
    const blocks = content.blocks.map(renderBlock).join("\n    ");

    const features: ShellFeature[] = [];
    const images = content.blocks.filter((b) => b.type === "image");
    const sizes = images.map((b) => imageSize(b.variant));
    const shapes = images.map((b) => imageShape(b));
    if (sizes.includes("small")) features.push("img-small");
    if (sizes.includes("medium")) features.push("img-medium");
    if (shapes.includes("circle")) features.push("img-circle");
    if (shapes.includes("square")) features.push("img-square");
    if (content.blocks.some((b) => b.type === "link" && b.variant === "pill"))
        features.push("pill");

    const firstHeading = content.blocks.find((b) => b.type === "heading");
    return {
        title: escapeHtml(firstHeading?.text || "hello"),
        css: shellCss(content, features),
        bodyHtml: wrapMain(blocks),
        // Link-click fallback so links aren't a dead tap inside a host webview.
        // Always present (the footer link alone justifies it).
        js: LINK_FALLBACK_JS,
    };
}

export function renderHtml(content: SiteContent): string {
    return assembleDocument(renderHtmlParts(content));
}
