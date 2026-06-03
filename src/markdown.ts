// Markdown mode: blocks serialize DOWN to markdown losslessly (the one-way
// "eject" ladder — blocks → markdown → html), and markdown renders through
// the same document shell as the simple editor, so theme controls
// (accent/bg/font) keep working.

import { marked } from "marked";
import {
    assembleDocument,
    escapeHtml,
    shellCss,
    wrapMain,
    type DocumentParts,
    type PageTheme,
    type SiteContent,
} from "./template.ts";

// Exact downgrade of the block model. Header/subheader become the leading
// heading + paragraph; the profile layout's avatar treatment is the one thing
// markdown can't express, so an avatar block becomes a plain image.
export function blocksToMarkdown(content: SiteContent): string {
    const parts: string[] = [];
    if (content.header) parts.push(`# ${content.header}`);
    if (content.subheader) parts.push(content.subheader);
    for (const b of content.blocks) {
        switch (b.type) {
            case "paragraph":
                parts.push(b.text);
                break;
            case "link":
                parts.push(`[${b.label}](${b.url})`);
                break;
            case "image":
                parts.push(`![${b.alt}](${b.url})`);
                break;
            case "divider":
                parts.push("---");
                break;
        }
    }
    return parts.join("\n\n") + "\n";
}

// <title> comes from the first ATX heading, mirroring renderHtml's
// `content.header || "hello"` fallback.
function titleFromMarkdown(markdown: string): string {
    const m = markdown.match(/^#{1,6}\s+(.+)$/m);
    return m ? m[1].trim() : "hello";
}

export function renderMarkdownParts(markdown: string, theme: PageTheme): DocumentParts {
    const body = marked.parse(markdown, { async: false });
    return {
        title: escapeHtml(titleFromMarkdown(markdown)),
        css: shellCss(theme, ["markdown"]),
        bodyHtml: wrapMain(body),
    };
}

export function renderMarkdownHtml(markdown: string, theme: PageTheme): string {
    return assembleDocument(renderMarkdownParts(markdown, theme));
}
