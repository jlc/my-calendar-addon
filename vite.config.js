import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [
    react(),
    viteSingleFile({
      // Optional: remove the extra Vite loader wrapper if you want a cleaner HTML
      removeViteModuleLoader: true,
      // Inline all assets (default behavior)
    }),
  ],
  build: {
    // We do NOT use library mode here → we want app mode + single file
    rollupOptions: {
      output: {
        // The three most important lines:
        inlineDynamicImports: true, // ← prevents dynamic import chunks
      },
    },

    // Optional but recommended for smallest single file
    minify: "esbuild", // or false if you want readable output
    target: "es2015", // or esnext — your choice // es2020
    sourcemap: false, // usually no need in single-file usecase

    cssCodeSplit: false,
    assetsInlineLimit: 100000000, // Inline all assets
  },
  // Force modern but compatible syntax
  esbuild: {
    target: "es2015",
  },
});
