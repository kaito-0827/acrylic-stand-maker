import { defineConfig } from "vite";

// onnxruntime-web のWASMをマルチスレッドで動かすにはクロスオリジン分離が必要(本番は vercel.json で同じヘッダー)
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  server: { headers: isolation },
  preview: { headers: isolation },
});
