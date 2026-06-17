import React from "react";
import ReactDOM from "react-dom/client";
import { attachConsole } from "@tauri-apps/plugin-log";
import App from "./App";
import { start as startUpdater } from "./updater";

// Forward webview console.* into the Rust log plugin so it lands in the
// on-disk log file (and stdout), making prod debugging possible without
// devtools. Best-effort: ignore failures (e.g. running outside Tauri).
void attachConsole().catch(() => {});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

startUpdater();
