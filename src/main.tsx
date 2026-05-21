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

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
