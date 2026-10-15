// AI背景除去: ISNet (DIS, Apache-2.0) を onnxruntime-web で実行し、前景らしさのマスク(0〜1)を返す。
// モデル・ランタイムは初回利用時にだけ読み込む。モデルは Cache Storage に保存して2回目以降は再DLしない。
import type * as Ort from "onnxruntime-web";

// 改変されないようリビジョンを固定 (rembg 配布の isnet-general-use を fp16 / int8 化したもの)
const MODEL_BASE =
  "https://huggingface.co/Ko033/isnet-general-use-onnx/resolve/5349b617911fd60c619b52f32e2b593517b78df3/onnx/";
const SIZE = 1024;
const MEAN = 0.5;
const CACHE = "aimatte-v1";

export type AiProgress =
  | { phase: "download"; loaded: number; total: number }
  | { phase: "init" }
  | { phase: "infer" };

export interface AiBackend {
  device: "webgpu" | "wasm";
  modelBytes: number;
}

interface Loaded extends AiBackend {
  ort: typeof Ort;
  session: Ort.InferenceSession;
}

let loading: Promise<Loaded> | null = null;

/** fp16 が使える WebGPU なら GPU、それ以外は int8 量子化モデルを CPU(WASM) で */
async function pickBackend(): Promise<"webgpu" | "wasm"> {
  const gpu = navigator.gpu as GPU | undefined;
  if (!gpu) return "wasm";
  try {
    const adapter = await gpu.requestAdapter();
    return adapter?.features.has("shader-f16") ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

/** Cache Storage を優先し、なければ進捗つきでダウンロードして保存 */
async function fetchModel(url: string, onProgress: (p: AiProgress) => void): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    cache = null; // プライベートモード等
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`モデルを取得できませんでした (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const buf = new Uint8Array(total || 256 * 1024 * 1024);
  const reader = res.body.getReader();
  let loaded = 0;
  let out = buf;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > out.length) {
      const grown = new Uint8Array(Math.max(out.length * 2, loaded + value.length));
      grown.set(out.subarray(0, loaded));
      out = grown;
    }
    out.set(value, loaded);
    loaded += value.length;
    onProgress({ phase: "download", loaded, total });
  }
  const data = out.subarray(0, loaded);
  if (cache) {
    try {
      await cache.put(url, new Response(data.slice(), { headers: { "content-type": "application/octet-stream" } }));
    } catch {
      /* 容量不足などは無視(次回また取得する) */
    }
  }
  return data;
}

async function createSession(ort: typeof Ort, device: "webgpu" | "wasm", onProgress: (p: AiProgress) => void) {
  const bytes = await fetchModel(MODEL_BASE + (device === "webgpu" ? "model_fp16.onnx" : "model_quantized.onnx"), onProgress);
  onProgress({ phase: "init" });
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: [device],
    graphOptimizationLevel: "all",
  });
  return { session, modelBytes: bytes.length };
}

async function load(onProgress: (p: AiProgress) => void): Promise<Loaded> {
  const ort = await import("onnxruntime-web/webgpu");
  let device = await pickBackend();
  // 最初からCPUならUIを止めないようワーカーで実行(初期化後は切り替えられない)。
  // スレッドが使えるのはCOOP/COEPで分離されているときだけ
  ort.env.wasm.proxy = device === "wasm";
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  if (device === "webgpu") {
    try {
      return { ort, device, ...(await createSession(ort, device, onProgress)) };
    } catch (e) {
      console.warn("WebGPUで初期化できないためCPUで実行します", e);
      device = "wasm";
    }
  }
  return { ort, device, ...(await createSession(ort, device, onProgress)) };
}

function getLoaded(onProgress: (p: AiProgress) => void): Promise<Loaded> {
  if (!loading) {
    loading = load(onProgress);
    loading.catch(() => (loading = null)); // 失敗したら次回やり直せるように
  }
  return loading;
}

export function loadAiModel(onProgress: (p: AiProgress) => void): Promise<AiBackend> {
  return getLoaded(onProgress);
}

/** 画像全体の前景マスクを元の解像度で返す (0〜1) */
export async function predictMatte(
  src: HTMLCanvasElement,
  onProgress: (p: AiProgress) => void,
): Promise<{ matte: Float32Array; backend: AiBackend }> {
  const m = await getLoaded(onProgress);
  onProgress({ phase: "infer" });
  const { ort, session } = m;
  // 透過部分は白で合成してから 1024×1024 に縮小
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, SIZE, SIZE);
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const P = SIZE * SIZE;
  const chw = new Float32Array(3 * P);
  for (let i = 0; i < P; i++) {
    for (let ch = 0; ch < 3; ch++) chw[ch * P + i] = px[i * 4 + ch] / 255 - MEAN;
  }
  const input = new ort.Tensor("float32", chw, [1, 3, SIZE, SIZE]);
  const out = await session.run({ [session.inputNames[0]]: input });
  const raw = out[session.outputNames[0]].data as Float32Array;
  // 出力はシグモイド済みの確率。画像ごとに最小〜最大で0〜1へ正規化する
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < P; i++) {
    if (raw[i] < lo) lo = raw[i];
    if (raw[i] > hi) hi = raw[i];
  }
  const span = hi - lo || 1;
  const small = new Uint8ClampedArray(P * 4);
  for (let i = 0; i < P; i++) small[i * 4 + 3] = Math.round(((raw[i] - lo) / span) * 255);
  input.dispose();
  for (const k of Object.keys(out)) out[k].dispose();

  // 元の解像度へバイリニアで拡大
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.putImageData(new ImageData(small, SIZE, SIZE), 0, 0);
  const W = src.width, H = src.height;
  const big = document.createElement("canvas");
  big.width = W;
  big.height = H;
  const bctx = big.getContext("2d", { willReadFrequently: true })!;
  bctx.imageSmoothingQuality = "high";
  bctx.drawImage(c, 0, 0, W, H);
  const bd = bctx.getImageData(0, 0, W, H).data;
  const alpha = new Float32Array(W * H);
  for (let i = 0; i < alpha.length; i++) alpha[i] = bd[i * 4 + 3] / 255;
  return { matte: alpha, backend: { device: m.device, modelBytes: m.modelBytes } };
}

export function aiBackendLabel(b: AiBackend) {
  return b.device === "webgpu" ? "WebGPU" : "CPU (WASM)";
}
