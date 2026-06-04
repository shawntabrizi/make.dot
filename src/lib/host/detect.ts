// Canonical three-way host detection (per the polkadot-triangle skill — the
// one and only place this logic lives). Desktop/Mobile webview hosts set the
// mark; the web host (dot.li) loads products in a cross-origin iframe.

export type HostEnvironment = "desktop-webview" | "web-iframe" | "standalone";

export function detectHostEnvironment(): HostEnvironment {
    if (typeof window === "undefined") return "standalone";
    // Webview hosts set this flag — check FIRST (window.parent === window there)
    if ((window as { __HOST_WEBVIEW_MARK__?: boolean }).__HOST_WEBVIEW_MARK__) {
        return "desktop-webview";
    }
    // Web host loads the product in an iframe — cross-origin access can throw
    try {
        if (window !== window.top) return "web-iframe";
    } catch {
        return "web-iframe"; // SecurityError → cross-origin iframe → host
    }
    return "standalone";
}

export function isInHost(): boolean {
    return detectHostEnvironment() !== "standalone";
}
