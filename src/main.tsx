import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./sunny-preview.css";
import "./liquid-glass.css";
import "./mo-extra.css";
import "./apple-hig.css";
import { configureAppearance } from "./AppearancePicker";

// Sunny UI 2.0 四维外观系统：明暗 / 质感 / 配色 / 圆角
configureAppearance({ storagePrefix: "mole-ui" });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
