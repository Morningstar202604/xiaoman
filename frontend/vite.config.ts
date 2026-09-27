import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// 开发期：vite 跑 5199，/api 反代到后端 8787（避免跨域）
// 生产期：vite build 出 dist，由 FastAPI 直接托管（单端口，无跨域）
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5199,
    host: "127.0.0.1",
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    // 按依赖族分包：echarts / markdown 渲染 / react 各自独立缓存，应用主包保持轻
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/echarts") || id.includes("node_modules/zrender")) return "echarts";
          if (
            id.includes("node_modules/react-markdown") ||
            id.includes("node_modules/remark-gfm") ||
            id.includes("node_modules/remark-parse") ||
            id.includes("node_modules/micromark") ||
            id.includes("node_modules/mdast-util") ||
            id.includes("node_modules/hast-util") ||
            id.includes("node_modules/unified") ||
            id.includes("node_modules/vfile")
          )
            return "markdown";
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
          return undefined;
        },
      },
    },
  },
});
