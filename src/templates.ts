// Starter layouts. Each `build()` returns a fresh SiteContent with new block
// IDs so applying the same template twice yields distinct, editable instances.
//
// Invariant: templates are pure data. Everything they emit is a regular block
// the user could add from the + menu and style with the per-block toggles —
// nothing is locked, special-cased, or otherwise unbuildable by hand.

import { type SiteContent } from "./template.ts";

function id(): string {
    return Math.random().toString(36).slice(2, 10);
}

export interface Template {
    id: string;
    name: string;
    description: string;
    build: () => SiteContent;
}

export const TEMPLATES: readonly Template[] = [
    {
        id: "blank",
        name: "Blank",
        description: "Clean slate",
        build: () => ({
            accentColor: "#e6007a",
            background: "#0b0d12",
            fontFamily: "system-ui",
            blocks: [
                { id: id(), type: "heading", text: "Hello, world" },
                {
                    id: id(),
                    type: "paragraph",
                    text: "This is your page. Click anything to make it yours.",
                },
            ],
        }),
    },
    {
        id: "profile",
        name: "Profile",
        description: "Photo, name, bio, and button links",
        build: () => ({
            accentColor: "#b15a3e",
            background: "#faf7f2",
            fontFamily: "system-ui",
            align: "center",
            blocks: [
                {
                    id: id(),
                    type: "image",
                    variant: "small",
                    shape: "circle",
                    url: "https://",
                    alt: "Profile photo",
                },
                { id: id(), type: "heading", text: "Your Name" },
                {
                    id: id(),
                    type: "paragraph",
                    text: "What you do, in one line.",
                },
                // Prefilled to the profile-URL base — the user just appends
                // their username. "X" matches the platform's current name
                // (and what Linktree calls it).
                { id: id(), type: "link", variant: "pill", label: "X", url: "https://x.com/" },
                {
                    id: id(),
                    type: "link",
                    variant: "pill",
                    label: "GitHub",
                    url: "https://github.com/",
                },
                { id: id(), type: "link", variant: "pill", label: "Email me", url: "mailto:" },
            ],
        }),
    },
    {
        id: "post",
        name: "Blog post",
        description: "Title, date, paragraphs, and an image",
        build: () => ({
            accentColor: "#6b4423",
            background: "#f7f3ed",
            fontFamily: "Georgia, serif",
            blocks: [
                { id: id(), type: "heading", text: "Untitled post" },
                { id: id(), type: "paragraph", text: "Draft · today" },
                {
                    id: id(),
                    type: "paragraph",
                    text:
                        "Open with the question or observation that pulled you in. " +
                        "Two or three sentences.",
                },
                {
                    id: id(),
                    type: "paragraph",
                    text:
                        "Then the body — be specific, name things, link out when it " +
                        "helps the reader.",
                },
                { id: id(), type: "divider" },
                {
                    id: id(),
                    type: "image",
                    url: "https://",
                    alt: "Supporting image",
                },
                {
                    id: id(),
                    type: "paragraph",
                    text:
                        "Close with what changed in your thinking and what you'd " +
                        "want a reader to walk away with.",
                },
            ],
        }),
    },
    {
        id: "event",
        name: "Event",
        description: "Title, when / where, big RSVP",
        build: () => ({
            accentColor: "#ff6b9d",
            background: "#2d1f3f",
            fontFamily: "system-ui",
            blocks: [
                { id: id(), type: "heading", text: "Event title" },
                {
                    id: id(),
                    type: "paragraph",
                    text: "Saturday · 7pm · A specific place",
                },
                {
                    id: id(),
                    type: "paragraph",
                    text:
                        "One paragraph on what the event is. Set expectations: " +
                        "BYO drinks, dress code, what to bring.",
                },
                {
                    id: id(),
                    type: "link",
                    variant: "pill",
                    label: "RSVP",
                    url: "mailto:",
                },
                {
                    id: id(),
                    type: "image",
                    variant: "medium",
                    url: "https://",
                    alt: "Location or theme image",
                },
            ],
        }),
    },
];
