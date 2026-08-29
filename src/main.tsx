import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

const root = document.getElementById("root")!;
const frame = document.getElementById("chsyp-frame") as HTMLIFrameElement | null;

function renderChat() {
  frame?.remove();
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

function launchInFrame(target: HTMLIFrameElement) {
  const moduleScript = document.querySelector<HTMLScriptElement>('script[type="module"]');
  if (!moduleScript) {
    renderChat();
    return;
  }

  // Production inlines the module; development keeps the Vite module URL.
  const bootScript = moduleScript.src
    ? `<script type="module" src="${moduleScript.src}"><\/script>`
    : `<script type="module">${(moduleScript.textContent ?? "").replace(/<\/script/gi, "<\\/script")}<\/script>`;
  const styles = Array.from(document.head.querySelectorAll("style, link[rel='stylesheet']"))
    .map((node) => node.outerHTML)
    .join("");

  // Resolve the stored theme before first paint so dark mode never flashes white.
  const themeScript = `<script>try{var t=localStorage.getItem('chsyp-theme-v1')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';}catch(e){}<\/script>`;

  target.srcdoc = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>Chasy P</title>
    ${themeScript}
    ${styles}
  </head>
  <body>
    <div id="root"></div>
    ${bootScript}
  </body>
</html>`;
  target.hidden = false;
  root.remove();
}

// When this document is already embedded, it *is* the app frame.
if (window.self !== window.top || !frame) renderChat();
else launchInFrame(frame);
