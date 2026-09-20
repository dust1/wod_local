import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  define: {
    __WOD_ADMIN_MODE__: JSON.stringify(false),
  },
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    // 根目录下的 data/（约 5 万个 JSON）、docs/（含 1.9 GB 源库）、dist/ 无需参与 HMR 监听。
    // 不排除时 chokidar 首次爬取要几十秒，并阻塞事件循环，导致首屏请求长时间排队。
    watch: {
      ignored: ["**/data/**", "**/docs/**", "**/dist/**"],
    },
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
