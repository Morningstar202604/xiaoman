import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./lib/theme";
import { I18nProvider } from "./lib/i18n";
import { ToastProvider } from "./lib/toast";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
    <ThemeProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ThemeProvider>
    </I18nProvider>
  </React.StrictMode>,
);

// PWA：生产环境注册 Service Worker（离线打开 + 添加到主屏幕）；开发模式跳过避免干扰 HMR
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* 注册失败不影响正常使用 */
    });
  });
}
