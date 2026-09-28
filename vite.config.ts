import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri 三个窗口各是一个独立的 HTML 入口，构建时打成一个多页应用。
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Tauri CLI 自己会打印编译进度，别让 Vite 把屏幕清掉。
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // src-tauri 由 cargo 监视，Vite 再盯一遍会重复触发。
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    rollupOptions: {
      // 相对路径按 Vite 的 root（即本文件所在目录）解析，
      // 于是不必引 node:path，也就不用额外装 @types/node。
      input: {
        main: "index.html",
        panel: "panel.html",
        float: "float.html",
      },
    },
  },
});
