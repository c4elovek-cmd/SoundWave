import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/common/ErrorBoundary";
import { installTauriBridge } from "./lib/tauriBridge";
import "./stores/waveStore";
import "./styles/global.css";
import "material-symbols/rounded.css";
import "./styles/icons.css";

// Под Tauri интерфейс обращается к тем же window.electronAPI —
// мост ставится до первого рендера, чтобы компоненты ничего не знали о Rust.
installTauriBridge();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
