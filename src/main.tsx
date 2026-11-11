import "./platform/polyfills";
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
import App from "./app/App";
import Tooltip from "./ui/Tooltip";
import "./styles.css";
// iOS zooms into a focused text field under 16px, such as the 15px document
// text, and stays zoomed after editing, cutting off both edges. maximum-scale
// stops that zoom while iOS still lets people pinch-zoom; other browsers would
// lose pinch-zoom, so only iOS WebKit (the one with touch callouts) gets it.
if (CSS.supports("-webkit-touch-callout", "none"))
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute(
      "content",
      "width=device-width, initial-scale=1.0, maximum-scale=1",
    );
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <Tooltip />
  </React.StrictMode>,
);
