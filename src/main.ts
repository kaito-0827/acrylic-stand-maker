import "./style.css";
import { buildGeometry, planGrid, type StandGeometry, type StandParams } from "./geometry";
import { buildAi, buildEps, loopsToSvgPath, type Cmyk, type ExportOptions, type Raster } from "./export";

// ---------------------------------------------------------------- 状態
const params: StandParams = {
  heightMm: 100,
  offsetMm: 2,
  tabWidthMm: 20,
  tabHeightMm: 3,
  tabShiftMm: 0,
  bodyThicknessMm: 3,
  slotClearanceMm: 0.1,
  baseWidthMm: 60,
  baseDepthMm: 30,
  baseRadiusMm: 5,
  slotShiftMm: 0,
  whiteInsetMm: 0,
  alphaThreshold: 128,
};

const CUT_COLORS: Record<string, { label: string; cmyk: Cmyk }> = {
  red: { label: "赤 (M100 Y100)", cmyk: [0, 1, 1, 0] },
  k100: { label: "黒 (K100)", cmyk: [0, 0, 0, 1] },
  magenta: { label: "マゼンタ (M100)", cmyk: [0, 1, 0, 0] },
  cyan: { label: "シアン (C100)", cmyk: [1, 0, 0, 0] },
};

const state = {
  source: null as HTMLCanvasElement | null, // 読み込んだ画像(透過処理後)
  original: null as HTMLCanvasElement | null,
  fileName: "acrylic-stand",
  removeWhite: false,
  whiteTolerance: 24,
  cutColor: "red",
  cutWidthPt: 0.3,
  includeBase: true,
  showWhite: true,
  geo: null as StandGeometry | null,
};

// ---------------------------------------------------------------- UI
type Field = { key: keyof StandParams; label: string; unit: string; step: number; min: number; max: number; hint?: string };
const groups: { title: string; fields: Field[] }[] = [
  {
    title: "サイズ・カットライン",
    fields: [
      { key: "heightMm", label: "絵柄の高さ", unit: "mm", step: 1, min: 10, max: 500 },
      { key: "offsetMm", label: "フチの幅", unit: "mm", step: 0.5, min: 0.5, max: 20, hint: "絵柄からカットラインまで" },
      { key: "whiteInsetMm", label: "白版の縮小", unit: "mm", step: 0.05, min: 0, max: 2, hint: "白がはみ出さないよう内側へ" },
      { key: "alphaThreshold", label: "透明判定のしきい値", unit: "", step: 1, min: 1, max: 254 },
    ],
  },
  {
    title: "差し込み(本体側)",
    fields: [
      { key: "tabWidthMm", label: "差し込み幅", unit: "mm", step: 1, min: 3, max: 200 },
      { key: "tabHeightMm", label: "差し込み高さ", unit: "mm", step: 0.5, min: 0, max: 20, hint: "台座の厚みと同じが目安。0で差し込みなし" },
      { key: "tabShiftMm", label: "左右位置", unit: "mm", step: 0.5, min: -200, max: 200 },
      { key: "bodyThicknessMm", label: "本体アクリル厚", unit: "mm", step: 0.5, min: 1, max: 15 },
    ],
  },
  {
    title: "台座",
    fields: [
      { key: "baseWidthMm", label: "台座の幅", unit: "mm", step: 1, min: 10, max: 400 },
      { key: "baseDepthMm", label: "台座の奥行き", unit: "mm", step: 1, min: 5, max: 300 },
      { key: "baseRadiusMm", label: "角丸", unit: "mm", step: 0.5, min: 0, max: 150 },
      { key: "slotShiftMm", label: "穴の前後位置", unit: "mm", step: 0.5, min: -100, max: 100, hint: "+で奥側" },
      { key: "slotClearanceMm", label: "穴のゆとり", unit: "mm", step: 0.05, min: 0, max: 1 },
    ],
  },
];

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
<header class="top">
  <div class="brand"><span class="logo">◇</span> アクスタ入稿データメーカー</div>
  <div class="sub">画像からカットライン・白版・台座つきの .ai / .eps を作成（処理はすべてブラウザ内）</div>
</header>
<main class="layout">
  <aside class="panel">
    <section class="card">
      <h2>1. 画像</h2>
      <label class="drop" id="drop">
        <input type="file" id="file" accept="image/png,image/webp,image/jpeg,image/gif" hidden />
        <div class="drop-main">画像をドロップ / クリックして選択</div>
        <div class="drop-sub">背景透過PNG推奨</div>
      </label>
      <button class="link" id="sample" type="button">サンプル画像で試す</button>
      <label class="check"><input type="checkbox" id="removeWhite" /> 白い背景を透過する</label>
      <div class="field" id="tolRow" hidden>
        <span>白判定の許容差</span>
        <input type="range" id="tol" min="2" max="80" value="24" />
      </div>
      <div id="imgInfo" class="info"></div>
    </section>
    ${groups
      .map(
        (g, gi) => `
    <section class="card">
      <h2>${gi + 2}. ${g.title}</h2>
      ${g.fields
        .map(
          (f) => `
      <label class="field">
        <span>${f.label}${f.hint ? `<small>${f.hint}</small>` : ""}</span>
        <span class="num"><input type="number" data-key="${f.key}" step="${f.step}" min="${f.min}" max="${f.max}" value="${params[f.key]}" />${f.unit ? `<em>${f.unit}</em>` : ""}</span>
      </label>`,
        )
        .join("")}
    </section>`,
      )
      .join("")}
    <section class="card">
      <h2>5. 書き出し</h2>
      <label class="field"><span>カットライン色</span>
        <select id="cutColor">${Object.entries(CUT_COLORS)
          .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
          .join("")}</select>
      </label>
      <label class="field"><span>線幅</span><span class="num"><input type="number" id="cutWidth" step="0.05" min="0.05" max="2" value="0.3" /><em>pt</em></span></label>
      <label class="check"><input type="checkbox" id="includeBase" checked /> 台座を同じファイルに入れる</label>
      <div class="buttons">
        <button id="dlAi" class="primary" disabled>.ai をダウンロード</button>
        <button id="dlEps" class="primary" disabled>.eps をダウンロード</button>
      </div>
      <p class="note">白版はK100の塗り、画像はRGBで配置されます。色指定・線幅・レイヤー名は入稿先の規定に合わせて調整してください。</p>
    </section>
  </aside>
  <section class="stage">
    <div class="stage-bar">
      <label class="check"><input type="checkbox" id="showWhite" checked /> 白版を表示</label>
      <div id="stats" class="stats"></div>
    </div>
    <div class="canvas" id="canvas">
      <div class="empty">画像を読み込むとここにプレビューが表示されます</div>
    </div>
    <div id="warn" class="warn" hidden></div>
  </section>
</main>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- 画像読み込み
const MAX_SRC = 4000;

function toCanvas(img: CanvasImageSource, w: number, h: number) {
  const s = Math.min(1, MAX_SRC / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/** 外周とつながった白っぽい画素を透明にする */
function removeWhiteBackground(src: HTMLCanvasElement, tol: number) {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(src, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  const W = c.width, H = c.height;
  const lim = 255 - tol;
  const isBg = (i: number) => d[i * 4 + 3] < 8 || (d[i * 4] >= lim && d[i * 4 + 1] >= lim && d[i * 4 + 2] >= lim);
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!seen[i] && isBg(i)) {
      seen[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % W;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (i >= W) push(i - W);
    if (i < W * (H - 1)) push(i + W);
  }
  for (let i = 0; i < W * H; i++) {
    if (seen[i]) d[i * 4 + 3] = 0;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

function applySource() {
  if (!state.original) return;
  state.source = state.removeWhite ? removeWhiteBackground(state.original, state.whiteTolerance) : state.original;
  schedule();
}

function loadImageFile(file: File) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    state.original = toCanvas(img, img.naturalWidth, img.naturalHeight);
    state.fileName = file.name.replace(/\.[^.]+$/, "") || "acrylic-stand";
    // 透過のないJPEGなどは白背景透過を自動でON
    const ctx = state.original.getContext("2d")!;
    const corner = ctx.getImageData(0, 0, 1, 1).data;
    if (corner[3] === 255 && !state.removeWhite) {
      state.removeWhite = true;
      $<HTMLInputElement>("removeWhite").checked = true;
      $("tolRow").hidden = false;
    }
    URL.revokeObjectURL(url);
    applySource();
  };
  img.onerror = () => alert("画像を読み込めませんでした");
  img.src = url;
}

function makeSample() {
  const c = document.createElement("canvas");
  c.width = 800;
  c.height = 1100;
  const g = c.getContext("2d")!;
  // 体
  g.fillStyle = "#7cc6a4";
  g.beginPath();
  g.ellipse(400, 720, 250, 320, 0, 0, Math.PI * 2);
  g.fill();
  // 頭
  g.fillStyle = "#a5e0c2";
  g.beginPath();
  g.arc(400, 330, 230, 0, Math.PI * 2);
  g.fill();
  // 耳
  for (const s of [-1, 1]) {
    g.beginPath();
    g.ellipse(400 + s * 170, 120, 55, 110, s * 0.4, 0, Math.PI * 2);
    g.fill();
  }
  // 顔
  g.fillStyle = "#24343a";
  for (const s of [-1, 1]) {
    g.beginPath();
    g.arc(400 + s * 80, 320, 22, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "#f29aa8";
  for (const s of [-1, 1]) {
    g.beginPath();
    g.ellipse(400 + s * 130, 380, 34, 20, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = "#24343a";
  g.lineWidth = 10;
  g.lineCap = "round";
  g.beginPath();
  g.arc(400, 370, 40, 0.2 * Math.PI, 0.8 * Math.PI);
  g.stroke();
  // おなかの穴(中抜き確認用)と星
  g.globalCompositeOperation = "destination-out";
  g.beginPath();
  g.arc(400, 760, 70, 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = "source-over";
  g.fillStyle = "#ffd166";
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const r = k % 2 ? 40 : 95;
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    g.lineTo(660 + r * Math.cos(a), 560 + r * Math.sin(a));
  }
  g.closePath();
  g.fill();
  state.original = c;
  state.fileName = "sample";
  state.removeWhite = false;
  $<HTMLInputElement>("removeWhite").checked = false;
  $("tolRow").hidden = true;
  applySource();
}

// ---------------------------------------------------------------- 計算
let timer = 0;
function schedule() {
  clearTimeout(timer);
  timer = window.setTimeout(recompute, 120);
}

function recompute() {
  const src = state.source;
  if (!src) return;
  const plan = planGrid(src.width, src.height, params);
  const c = document.createElement("canvas");
  c.width = plan.cols;
  c.height = plan.rows;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, plan.drawX, plan.drawY, plan.drawW, plan.drawH);
  const rgba = ctx.getImageData(0, 0, plan.cols, plan.rows).data;
  const alpha = new Uint8ClampedArray(plan.cols * plan.rows);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
  try {
    state.geo = buildGeometry(
      { cols: plan.cols, rows: plan.rows, cell: plan.cell, originX: plan.originX, originY: plan.originY, alpha },
      plan.imgWmm,
      plan.imgHmm,
      params,
    );
    render();
  } catch (e) {
    state.geo = null;
    showWarn((e as Error).message);
    render();
  }
}

function showWarn(msg: string) {
  const w = $("warn");
  w.hidden = !msg;
  w.textContent = msg;
}

function render() {
  const geo = state.geo;
  const canvas = $("canvas");
  $<HTMLButtonElement>("dlAi").disabled = !geo;
  $<HTMLButtonElement>("dlEps").disabled = !geo;
  if (!geo || !state.source) {
    canvas.innerHTML = `<div class="empty">画像を読み込むとここにプレビューが表示されます</div>`;
    $("stats").textContent = "";
    return;
  }
  const b = geo.bounds;
  const m = 6;
  const bx = b.minX - m, by = b.minY - m, bw = b.maxX - b.minX + 2 * m, bh = b.maxY - b.minY + 2 * m;
  const cutCol = { red: "#e5262a", k100: "#111", magenta: "#e4007f", cyan: "#00a0e9" }[state.cutColor] ?? "#e5262a";
  const dataUrl = state.source.toDataURL();
  const baseX = geo.baseOrigin.x + params.baseWidthMm / 2;
  canvas.innerHTML = `
  <svg viewBox="${bx} ${by} ${bw} ${bh}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <pattern id="chk" width="4" height="4" patternUnits="userSpaceOnUse">
        <rect width="4" height="4" fill="var(--chk-a)"/><rect width="2" height="2" fill="var(--chk-b)"/><rect x="2" y="2" width="2" height="2" fill="var(--chk-b)"/>
      </pattern>
    </defs>
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="url(#chk)"/>
    <path d="${loopsToSvgPath(geo.cut)}" fill="rgba(180,220,255,0.35)"/>
    ${state.includeBase ? `<path d="${loopsToSvgPath(geo.base)}" fill="rgba(180,220,255,0.35)" fill-rule="evenodd"/>` : ""}
    ${state.showWhite ? `<path d="${loopsToSvgPath(geo.white)}" fill="#fff" fill-rule="evenodd" stroke="#9aa" stroke-width="0.15" stroke-dasharray="0.6 0.6"/>` : ""}
    <image href="${dataUrl}" x="0" y="0" width="${geo.imgWmm}" height="${geo.imgHmm}" preserveAspectRatio="none"/>
    <path d="${loopsToSvgPath(geo.cut)}" fill="none" stroke="${cutCol}" stroke-width="0.35" vector-effect="non-scaling-stroke" style="stroke-width:1.5px"/>
    ${state.includeBase ? `<path d="${loopsToSvgPath(geo.base)}" fill="none" stroke="${cutCol}" style="stroke-width:1.5px" vector-effect="non-scaling-stroke"/>
    <text x="${baseX}" y="${geo.baseOrigin.y - 2}" font-size="3.2" text-anchor="middle" fill="var(--muted)">台座 ${params.baseWidthMm}×${params.baseDepthMm}mm</text>` : ""}
  </svg>`;
  const cutW = (() => {
    let a = Infinity, z = -Infinity, t = Infinity, u = -Infinity;
    for (const l of geo.cut) for (const p of l) { a = Math.min(a, p.x); z = Math.max(z, p.x); t = Math.min(t, p.y); u = Math.max(u, p.y); }
    return { w: z - a, h: u - t };
  })();
  const dpi = (state.source.height / params.heightMm) * 25.4;
  $("stats").innerHTML = `本体 <b>${cutW.w.toFixed(1)} × ${cutW.h.toFixed(1)} mm</b>　画像解像度 <b class="${dpi < 300 ? "bad" : ""}">${Math.round(dpi)} dpi</b>`;
  const warns: string[] = [];
  if (geo.pieces > 1) warns.push(`本体が ${geo.pieces} パーツに分かれています。「フチの幅」を大きくするとつながります。`);
  if (dpi < 300) warns.push("画像の解像度が300dpi未満です。印刷が粗くなる可能性があります。");
  if (geo.tabWidthUsed < params.tabWidthMm - 0.01) warns.push(`差し込み幅を本体に収まる ${geo.tabWidthUsed.toFixed(1)}mm に調整しました。`);
  if (params.tabWidthMm + params.slotClearanceMm > params.baseWidthMm - 4) warns.push("台座の幅が差し込み幅に対して狭すぎます。");
  showWarn(warns.join("\n"));
}

// ---------------------------------------------------------------- 書き出し
function embedRaster(): Raster {
  const src = state.source!;
  // 350dpi相当まで縮小(拡大はしない)
  const target = Math.round((params.heightMm / 25.4) * 350);
  const s = Math.min(1, target / src.height);
  const w = Math.max(1, Math.round(src.width * s));
  const h = Math.max(1, Math.round(src.height * s));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

function exportOptions(): ExportOptions {
  return {
    cutColor: CUT_COLORS[state.cutColor].cmyk,
    cutWidthPt: state.cutWidthPt,
    whiteColor: [0, 0, 0, 1],
    includeBase: state.includeBase,
    marginMm: 5,
  };
}

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function doExport(kind: "ai" | "eps") {
  if (!state.geo) return;
  const btn = $<HTMLButtonElement>(kind === "ai" ? "dlAi" : "dlEps");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "作成中…";
  try {
    const raster = embedRaster();
    const blob = kind === "ai" ? await buildAi(state.geo, raster, exportOptions()) : await buildEps(state.geo, raster, exportOptions());
    download(blob, `${state.fileName}.${kind}`);
  } catch (e) {
    alert("書き出しに失敗しました: " + (e as Error).message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------------------------------------------------------------- イベント
document.querySelectorAll<HTMLInputElement>("input[data-key]").forEach((el) => {
  el.addEventListener("input", () => {
    const v = parseFloat(el.value);
    if (!Number.isFinite(v)) return;
    const k = el.dataset.key as keyof StandParams;
    params[k] = Math.min(parseFloat(el.max), Math.max(parseFloat(el.min), v));
    schedule();
  });
});

const fileInput = $<HTMLInputElement>("file");
fileInput.addEventListener("change", () => fileInput.files?.[0] && loadImageFile(fileInput.files[0]));
const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const f = e.dataTransfer?.files?.[0];
  if (f) loadImageFile(f);
});
$("sample").addEventListener("click", makeSample);
$<HTMLInputElement>("removeWhite").addEventListener("change", (e) => {
  state.removeWhite = (e.target as HTMLInputElement).checked;
  $("tolRow").hidden = !state.removeWhite;
  applySource();
});
$<HTMLInputElement>("tol").addEventListener("change", (e) => {
  state.whiteTolerance = +(e.target as HTMLInputElement).value;
  applySource();
});
$<HTMLSelectElement>("cutColor").addEventListener("change", (e) => {
  state.cutColor = (e.target as HTMLSelectElement).value;
  render();
});
$<HTMLInputElement>("cutWidth").addEventListener("input", (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  if (Number.isFinite(v) && v > 0) state.cutWidthPt = v;
});
$<HTMLInputElement>("includeBase").addEventListener("change", (e) => {
  state.includeBase = (e.target as HTMLInputElement).checked;
  render();
});
$<HTMLInputElement>("showWhite").addEventListener("change", (e) => {
  state.showWhite = (e.target as HTMLInputElement).checked;
  render();
});
$("dlAi").addEventListener("click", () => doExport("ai"));
$("dlEps").addEventListener("click", () => doExport("eps"));
