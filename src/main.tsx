import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./App.css";
import App from "./App.tsx";

// Track the slice of the layout viewport obscured by mobile browser chrome
// (Firefox Android's bottom URL bar is the case that motivated this — it
// overlays `position: fixed` content and is *not* reflected in
// `env(safe-area-inset-bottom)`). Other browsers report 0 here.
const vv = window.visualViewport;
if (vv) {
    const update = () => {
        const obscured = window.innerHeight - (vv.offsetTop + vv.height);
        document.documentElement.style.setProperty(
            "--vv-bottom",
            `${Math.max(0, Math.round(obscured))}px`,
        );
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
}

// When embedded (e.g. dot.li wraps the app in a sandboxed iframe), in-frame
// scrolls don't propagate to the host browser, so the URL bar stays pinned —
// and visualViewport inside the iframe reports the iframe's own viewport, not
// the device's. Reserve a fixed safety margin in that case.
if (window.self !== window.top) {
    document.documentElement.classList.add("in-iframe");
}

// A deploy replaces every content-hashed chunk, and on content-addressed
// hosting the old chunks don't go stale — they cease to exist. An
// already-open page that lazy-loads a chunk from the previous deploy gets a
// 404, which Vite surfaces as `vite:preloadError`. Reload once to pick up
// the new index (drafts survive via the localStorage autosave); the
// session-scoped guard stops a reload loop when the failure is real network
// trouble rather than a version skew.
window.addEventListener("vite:preloadError", (event) => {
    const KEY = "hello-playground:chunk-reload-at";
    const last = Number(sessionStorage.getItem(KEY) ?? "0");
    if (Date.now() - last < 30_000) return; // recently reloaded — surface the error
    sessionStorage.setItem(KEY, String(Date.now()));
    event.preventDefault();
    window.location.reload();
});

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
