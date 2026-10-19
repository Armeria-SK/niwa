import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { applyLanguage, rememberedLanguage } from "./i18n-react.js";
import "@fontsource-variable/noto-sans-jp";
import "@fontsource/zen-maru-gothic/700.css";
import "./styles.css";
import "./pages/Members.css";
import "./themes.css";
import "./design.css";

const root = createRoot(document.getElementById("root"));
// 前に選んだ言語の辞書を読み込んでから描く（ほかの言語のときに、日本語の文言が一瞬出ないように）。
void applyLanguage(rememberedLanguage()).finally(() => root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
));
