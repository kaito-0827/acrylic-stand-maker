// 画像のアルファから「カットライン」「白版」などの輪郭(mm単位のポリゴン)を作る。
// 座標系: 原点 = 画像の左上、x右向き / y下向き、単位 mm。

export type Pt = { x: number; y: number };
export type Loop = Pt[];

export interface StandParams {
  heightMm: number; // 画像(絵柄)の高さ
  offsetMm: number; // 絵柄からカットラインまでの余白
  tabWidthMm: number; // 差し込み部の幅
  tabHeightMm: number; // 差し込み部の高さ(台座の厚みと同じが目安)
  tabShiftMm: number; // 差し込み部の左右位置調整
  bodyThicknessMm: number; // 本体アクリルの厚み(台座の穴の幅になる)
  slotClearanceMm: number; // 穴のクリアランス
  baseWidthMm: number;
  baseDepthMm: number;
  baseRadiusMm: number;
  slotShiftMm: number; // 台座の穴の前後位置(+で奥)
  whiteInsetMm: number; // 白版を絵柄より内側に縮める量
  alphaThreshold: number; // 0-255
}

export interface StandGeometry {
  imgWmm: number;
  imgHmm: number;
  cut: Loop[]; // 本体カットライン
  white: Loop[]; // 白版(even-odd)
  clip: Loop[]; // 画像クリップ用(EPS)
  base: Loop[]; // 台座(外形 + 穴)
  baseOrigin: Pt; // 台座外形の左上(mm, 画像座標系)
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  pieces: number; // 本体が分離したパーツ数
  tabWidthUsed: number;
}

/** 画像を作業グリッドに描画したアルファ値 */
export interface AlphaGrid {
  cols: number;
  rows: number;
  cell: number; // mm / cell
  originX: number; // grid(0,0)中心のmm座標
  originY: number;
  alpha: Uint8ClampedArray;
}

// ---------------------------------------------------------------- EDT
// Felzenszwalb & Huttenlocher の二乗ユークリッド距離変換
const INF = 1e20;
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** inside[i]=1 のセルまでの距離(セル単位)を返す */
export function distanceTransform(inside: Uint8Array, cols: number, rows: number): Float32Array {
  const n = Math.max(cols, rows);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(cols * rows);
  for (let i = 0; i < grid.length; i++) grid[i] = inside[i] ? 0 : INF;
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) f[y] = grid[y * cols + x];
    edt1d(f, rows, d, v, z);
    for (let y = 0; y < rows; y++) grid[y * cols + x] = d[y];
  }
  const out = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) f[x] = grid[y * cols + x];
    edt1d(f, cols, d, v, z);
    for (let x = 0; x < cols; x++) out[y * cols + x] = Math.sqrt(d[x]);
  }
  return out;
}

// ---------------------------------------------------------------- 穴埋め
/** 外周から到達できない「外側」セルを内側扱いにする(アクリルは中抜きしない) */
function fillHoles(inside: Uint8Array, cols: number, rows: number) {
  const seen = new Uint8Array(cols * rows);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!inside[i] && !seen[i]) {
      seen[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < cols; x++) {
    push(x);
    push((rows - 1) * cols + x);
  }
  for (let y = 0; y < rows; y++) {
    push(y * cols);
    push(y * cols + cols - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % cols;
    const y = (i / cols) | 0;
    if (x > 0) push(i - 1);
    if (x < cols - 1) push(i + 1);
    if (y > 0) push(i - cols);
    if (y < rows - 1) push(i + cols);
  }
  const filled: number[] = [];
  for (let i = 0; i < inside.length; i++) {
    if (!inside[i] && !seen[i]) {
      inside[i] = 1;
      filled.push(i);
    }
  }
  return filled;
}

// ---------------------------------------------------------------- marching squares
/** field < 0 を内側とした等値線(0)をループで返す。座標はグリッド単位 */
export function marchingSquares(field: Float32Array, cols: number, rows: number): Loop[] {
  const H = (i: number, j: number) => 2 * (j * cols + i);
  const V = (i: number, j: number) => 2 * (j * cols + i) + 1;
  const pts = new Map<number, Pt>();
  const adj = new Map<number, number[]>();
  const point = (id: number): Pt => {
    let p = pts.get(id);
    if (p) return p;
    const cell = id >> 1;
    const i = cell % cols;
    const j = (cell / cols) | 0;
    const v0 = field[cell];
    if (id & 1) {
      const v1 = field[cell + cols];
      p = { x: i, y: j + v0 / (v0 - v1) };
    } else {
      const v1 = field[cell + 1];
      p = { x: i + v0 / (v0 - v1), y: j };
    }
    pts.set(id, p);
    return p;
  };
  const link = (a: number, b: number) => {
    point(a);
    point(b);
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  };
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const tl = field[j * cols + i];
      const tr = field[j * cols + i + 1];
      const br = field[(j + 1) * cols + i + 1];
      const bl = field[(j + 1) * cols + i];
      const c = (tl < 0 ? 8 : 0) | (tr < 0 ? 4 : 0) | (br < 0 ? 2 : 0) | (bl < 0 ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const T = H(i, j), R = V(i + 1, j), B = H(i, j + 1), L = V(i, j);
      switch (c) {
        case 1: case 14: link(L, B); break;
        case 2: case 13: link(B, R); break;
        case 3: case 12: link(L, R); break;
        case 4: case 11: link(T, R); break;
        case 6: case 9: link(T, B); break;
        case 7: case 8: link(L, T); break;
        case 5: {
          const center = (tl + tr + br + bl) / 4 < 0;
          if (center) { link(L, T); link(B, R); } else { link(L, B); link(T, R); }
          break;
        }
        case 10: {
          const center = (tl + tr + br + bl) / 4 < 0;
          if (center) { link(T, R); link(L, B); } else { link(L, T); link(B, R); }
          break;
        }
      }
    }
  }
  const loops: Loop[] = [];
  const used = new Set<number>();
  for (const start of adj.keys()) {
    if (used.has(start)) continue;
    const loop: Pt[] = [];
    let prev = -1;
    let cur = start;
    while (!used.has(cur)) {
      used.add(cur);
      loop.push(pts.get(cur)!);
      const nb = adj.get(cur)!;
      const next = nb[0] !== prev ? nb[0] : nb[1];
      if (next === undefined) break;
      prev = cur;
      cur = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// ---------------------------------------------------------------- 単純化
function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = pts[a], B = pts[b];
    const dx = B.x - A.x, dy = B.y - A.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i].x - A.x) * dy - (pts[i].y - A.y) * dx) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function simplifyLoop(loop: Loop, eps: number): Loop {
  if (loop.length < 8) return loop;
  // 最遠点で2分割して開いた折れ線としてRDP
  let far = 0, best = -1;
  for (let i = 1; i < loop.length; i++) {
    const d = (loop[i].x - loop[0].x) ** 2 + (loop[i].y - loop[0].y) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const a = rdp(loop.slice(0, far + 1), eps);
  const b = rdp([...loop.slice(far), loop[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

export function loopArea(loop: Loop): number {
  let s = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    s += (loop[j].x + loop[i].x) * (loop[j].y - loop[i].y);
  }
  return s / 2;
}

function toMm(loops: Loop[], g: AlphaGrid, eps: number, minArea: number): Loop[] {
  return loops
    .map((l) => l.map((p) => ({ x: g.originX + p.x * g.cell, y: g.originY + p.y * g.cell })))
    .filter((l) => Math.abs(loopArea(l)) >= minArea)
    .map((l) => simplifyLoop(l, eps));
}

// ---------------------------------------------------------------- 角丸長方形
export function roundedRect(x: number, y: number, w: number, h: number, r: number, seg = 10): Loop {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r === 0) return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const out: Pt[] = [];
  const corners = [
    { cx: x + w - r, cy: y + r, a0: -Math.PI / 2 },
    { cx: x + w - r, cy: y + h - r, a0: 0 },
    { cx: x + r, cy: y + h - r, a0: Math.PI / 2 },
    { cx: x + r, cy: y + r, a0: Math.PI },
  ];
  for (const c of corners) {
    for (let k = 0; k <= seg; k++) {
      const a = c.a0 + (k / seg) * (Math.PI / 2);
      out.push({ x: c.cx + r * Math.cos(a), y: c.cy + r * Math.sin(a) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- メイン
/** 作業グリッドの設計(画像を描き込む位置とサイズ) */
export function planGrid(imgW: number, imgH: number, p: StandParams) {
  const imgHmm = p.heightMm;
  const imgWmm = (p.heightMm * imgW) / imgH;
  const cell = Math.min(0.25, Math.max(0.05, Math.max(imgWmm, imgHmm) / 900));
  const pad = p.offsetMm + p.tabHeightMm + 3;
  const cols = Math.ceil((imgWmm + 2 * pad) / cell);
  const rows = Math.ceil((imgHmm + 2 * pad) / cell);
  return {
    imgWmm, imgHmm, cell, cols, rows,
    // グリッド中心座標系: セル(i,j)の中心 = origin + (i,j)*cell
    originX: -pad + cell / 2,
    originY: -pad + cell / 2,
    drawX: pad / cell, // 画像を描くキャンバス上の位置(px)
    drawY: pad / cell,
    drawW: imgWmm / cell,
    drawH: imgHmm / cell,
  };
}

export function buildGeometry(g: AlphaGrid, imgWmm: number, imgHmm: number, p: StandParams): StandGeometry {
  const { cols, rows, cell, alpha } = g;
  const n = cols * rows;
  const thr = p.alphaThreshold;
  const eps = Math.max(0.02, cell * 0.25);
  const minArea = cell * cell * 4;

  const mask = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) if (alpha[i] >= thr) { mask[i] = 1; any = true; }
  if (!any) throw new Error("絵柄が見つかりません(画像がすべて透明です)");

  // --- 白版: 絵柄そのもの(必要なら内側に縮める)
  let whiteField: Float32Array;
  if (p.whiteInsetMm > 0) {
    const outside = new Uint8Array(n);
    for (let i = 0; i < n; i++) outside[i] = mask[i] ? 0 : 1;
    const dIn = distanceTransform(outside, cols, rows);
    whiteField = new Float32Array(n);
    for (let i = 0; i < n; i++) whiteField[i] = p.whiteInsetMm + 0.5 * cell - dIn[i] * cell;
  } else {
    whiteField = new Float32Array(n);
    for (let i = 0; i < n; i++) whiteField[i] = thr - 0.5 - alpha[i];
  }
  const white = toMm(marchingSquares(whiteField, cols, rows), g, eps, minArea);

  // --- 画像クリップ(半透明のフチも含める)
  const clipField = new Float32Array(n);
  for (let i = 0; i < n; i++) clipField[i] = 7.5 - alpha[i];
  const clip = toMm(marchingSquares(clipField, cols, rows), g, eps, minArea);

  // --- カットライン: 絵柄からの距離 - offset と 差し込み部の矩形SDF の和集合
  const dist = distanceTransform(mask, cols, rows);
  const field = new Float32Array(n);
  for (let i = 0; i < n; i++) field[i] = dist[i] * cell - p.offsetMm;

  // 絵柄の横方向の範囲と、オフセット後の最下端
  let minC = cols, maxC = -1, bottomRow = -1;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (mask[k]) { if (i < minC) minC = i; if (i > maxC) maxC = i; }
      if (field[k] < 0 && j > bottomRow) bottomRow = j;
    }
  }
  const xOf = (i: number) => g.originX + i * cell;
  const yOf = (j: number) => g.originY + j * cell;
  const artMinX = xOf(minC), artMaxX = xOf(maxC);
  const shapeW = artMaxX - artMinX + 2 * p.offsetMm;
  const tabW = Math.max(2, Math.min(p.tabWidthMm, shapeW - 2));
  const tabCx = (artMinX + artMaxX) / 2 + p.tabShiftMm;
  const bottomY = yOf(bottomRow) + cell / 2;

  if (p.tabHeightMm > 0) {
    // 差し込み部の範囲内の各列で、形状の最下端を探し、すべての列とつながる高さまで矩形を伸ばす
    const i0 = Math.max(0, Math.round((tabCx - tabW / 2 - g.originX) / cell));
    const i1 = Math.min(cols - 1, Math.round((tabCx + tabW / 2 - g.originX) / cell));
    let topY = bottomY;
    for (let i = i0; i <= i1; i++) {
      for (let j = rows - 1; j >= 0; j--) {
        if (field[j * cols + i] < 0) { topY = Math.min(topY, yOf(j)); break; }
      }
    }
    topY -= cell;
    const rx0 = tabCx - tabW / 2, rx1 = tabCx + tabW / 2;
    const ry0 = topY, ry1 = bottomY + p.tabHeightMm;
    for (let j = 0; j < rows; j++) {
      const y = yOf(j);
      for (let i = 0; i < cols; i++) {
        const x = xOf(i);
        // 矩形の符号付き距離
        const dx = Math.max(rx0 - x, x - rx1);
        const dy = Math.max(ry0 - y, y - ry1);
        const sd = dx > 0 || dy > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) : Math.max(dx, dy);
        const k = j * cols + i;
        if (sd < field[k]) field[k] = sd;
      }
    }
  }

  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = field[i] < 0 ? 1 : 0;
  for (const k of fillHoles(inside, cols, rows)) field[k] = -cell;
  const cut = toMm(marchingSquares(field, cols, rows), g, eps, minArea);

  // --- 台座
  const slotW = tabW + p.slotClearanceMm;
  const slotH = p.bodyThicknessMm + p.slotClearanceMm;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of cut) for (const q of l) {
    minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
  }
  const bx = maxX + 8;
  const by = maxY - p.baseDepthMm;
  const baseOuter = roundedRect(bx, by, p.baseWidthMm, p.baseDepthMm, p.baseRadiusMm);
  const sx = bx + (p.baseWidthMm - slotW) / 2;
  const sy = by + (p.baseDepthMm - slotH) / 2 - p.slotShiftMm;
  const slot = roundedRect(sx, sy, slotW, slotH, 0);
  const base = [baseOuter, slot];
  for (const q of baseOuter) {
    minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
  }

  return {
    imgWmm, imgHmm, cut, white, clip, base,
    baseOrigin: { x: bx, y: by },
    bounds: { minX, minY, maxX, maxY },
    pieces: cut.length,
    tabWidthUsed: tabW,
  };
}
