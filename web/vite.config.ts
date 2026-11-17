import { Agent } from "node:http";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { mockMedia } from "./mock-media";

// No keep-alive to the backend: Node's global agent reuses idle sockets that uvicorn has already closed
// (keep-alive timeout 5 s), which surfaced as sporadic ECONNRESET proxy errors and hung requests.
const agent = new Agent({ keepAlive: false });

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const mock = env.VITE_MOCK === "1";
  // CLIPPER_API overrides the backend the dev proxy talks to (e.g. a second server on :8766 for testing).
  const API = env.CLIPPER_API || "http://127.0.0.1:8765";
  return {
    plugins: [react(), ...(mock ? [mockMedia()] : [])],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
      port: 5173,
      strictPort: true,
      host: "127.0.0.1",
      // In mock mode the dev-only media middleware answers /media and the thumbnail/poster routes.
      proxy: mock
        ? undefined
        : {
            "/api": { target: API, changeOrigin: false, agent },
            "/media": { target: API, changeOrigin: false, agent },
          },
    },
    build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 900 },
  };
});
