import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/literata";
import "./styles.css";
import App from "./App";

async function start() {
  // `npm run dev` in a plain browser: fake the Rust backend so the UI can be worked on without Tauri.
  // Compiled out of production builds.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    await import("./dev/mockBackend").then((m) => m.install());
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
