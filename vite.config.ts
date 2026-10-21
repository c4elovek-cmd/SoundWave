import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";
import renderer from "vite-plugin-electron-renderer";
import path from "path";

// В режиме Tauri сборка Electron не нужна: собирается только фронтенд.
// Флаг ставится скриптом `tauri:dev` / `tauri:build`.
const isTauri = process.env.SOUNDWAVE_TAURI?.trim() === "1";

export default defineConfig({
  plugins: [
    react(),
    ...(isTauri
      ? []
      : [
          electron([
            {
              entry: "electron/main.ts",
              vite: {
                build: {
                  outDir: "dist-electron",
                  rollupOptions: {
                    external: ["electron", "electron-store", "electron-log"],
                  },
                },
              },
            },
            {
              entry: "electron/preload.ts",
              onstart(options) {
                options.reload();
              },
              vite: {
                build: {
                  outDir: "dist-electron",
                  // preload грузится в sandbox без ESM — собираем как CommonJS
                  lib: {
                    entry: "electron/preload.ts",
                    formats: ["cjs"],
                    fileName: () => "preload.cjs",
                  },
                  rollupOptions: {
                    external: ["electron"],
                  },
                },
              },
            },
          ]),
          renderer(),
        ]),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Папка сборки Rust меняется во время `cargo build` — за ней
      // нельзя следить: файлы блокируются запущенным приложением.
      ignored: ["**/src-tauri/target/**"],
    },
  },
});