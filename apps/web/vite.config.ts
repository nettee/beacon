import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:46183",
      "/runs/": "http://127.0.0.1:46183",
    },
  },
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
    assetsDir: "assets",
  },
});
