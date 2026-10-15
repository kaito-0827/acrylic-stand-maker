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
  // ort のスレッド用Workerは ort チャンク自身を読み込む。Viteのpreloadヘルパーが index(DOM操作あり)に
  // 同居していると、ort チャンク→index の import でWorker内に document 参照が走り推論が止まるので分離する
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes("vite/preload-helper") ? "preload-helper" : undefined),
      },
    },
  },
});
