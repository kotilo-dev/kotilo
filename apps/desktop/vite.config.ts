/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
import brand from "../../brand.json" with { type: "json" };
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";
// @ts-expect-error type error without @types/node package
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
// Browser e2e mode (`vite --mode e2e`): loads src/e2e/setup.ts (Tauri IPC mocks + fake hub)
// before the app. Never active in `tauri dev` / `tauri build`.
function e2eSetup(mode: string) {
  return {
    name: "agenthub-e2e-setup",
    transformIndexHtml(html: string) {
      if (mode !== "e2e") return html;
      return html.replace(
        '<script type="module" src="/src/main.tsx"></script>',
        '<script type="module" src="/src/e2e/setup.ts"></script>\n    <script type="module" src="/src/main.tsx"></script>',
      );
    },
  };
}

// M5 brand switch: the window/page title comes from the repo's brand.json (index.html has a
// `__BRAND_NAME__` placeholder).
function brandTitle() {
  const escaped = brand.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    name: "agenthub-brand-title",
    transformIndexHtml(html: string) {
      return html.replace("__BRAND_NAME__", escaped);
    },
  };
}

// M5 About → open-source licenses: the repo-root THIRD_PARTY_NOTICES as a virtual module
// (`virtual:third-party-notices`, default export = the text). A plain `?raw` import of the
// extensionless file is served untransformed by the dev server; the virtual module works in
// dev, e2e and build, and the lazy `import()` keeps it in its own chunk.
function thirdPartyNotices(): Plugin {
  const id = "virtual:third-party-notices";
  const resolved = `\0${id}`;
  const file = fileURLToPath(new URL("../../THIRD_PARTY_NOTICES", import.meta.url));
  return {
    name: "agenthub-third-party-notices",
    resolveId(source: string) {
      return source === id ? resolved : null;
    },
    load(loadId: string) {
      if (loadId !== resolved) return null;
      this.addWatchFile(file);
      return `export default ${JSON.stringify(readFileSync(file, "utf8"))};`;
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), e2eSetup(mode), brandTitle(), thirdPartyNotices()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // The project root plus the repo's brand.json, which `src/app/constants.ts` imports.
    fs: { allow: [".", "../../brand.json"] },
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`. faz7-spec §12.9: `**/docs/**` was removed —
      // `docs/*.md` are now bundled into the app via `?raw` (`src/features/help/helpDocs.ts`), so
      // dev-server HMR should react to doc edits like any other imported source file.
      ignored: ["**/src-tauri/**", "**/target/**", "**/tasks/**"],
    },
  },

  // Monaco worker'ları ES module olarak derlenir (faz3-spec §5.19); Vite'ın varsayılanı
  // "iife"dir ama monaco worker dosyaları içeride `import` kullanır.
  worker: {
    format: "es",
  },

  // Vitest config (frontend unit tests)
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // Playwright specs live in e2e/ and run with `npm run e2e`, not Vitest.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
}));
