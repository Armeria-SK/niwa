import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "@fontsource-variable/noto-sans-jp";
import "@fontsource/zen-maru-gothic/700.css";
import "./styles.css";
import "./pages/Members.css";
import "./themes.css";
import "./design.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
