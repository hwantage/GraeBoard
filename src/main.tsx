import "./polyfills";
import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/noto-sans-kr/400.css";
import "@fontsource/noto-sans-kr/500.css";
import "@fontsource/noto-sans-kr/600.css";
import "@fontsource/noto-sans-kr/700.css";
import "@fontsource/noto-serif-kr/400.css";
import "@fontsource/nanum-gothic-coding/400.css";
import "@fontsource/pretendard/400.css";
import "@fontsource/pretendard/500.css";
import "@fontsource/pretendard/600.css";
import "@fontsource/pretendard/700.css";
import App from "./App";
import Tooltip from "./Tooltip";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <Tooltip />
  </React.StrictMode>,
);
