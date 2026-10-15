// 単色背景の除去: 背景色の自動推定 → 外周からの塗りつぶし → 境界のアンチエイリアスを半透明化+色の白ズレ除去
export interface BgRemoveOptions {
  tolerance: number; // 背景色との色差のしきい値 (0-255目安)
  removeEnclosed: boolean; // 外周とつながっていない背景色の領域も消す
}

export interface BgRemoveResult {
  data: Uint8ClampedArray; // RGBA
  bg: [number, number, number] | null; // 推定した背景色 (透過画像なら null)
}

/** 色差 (redmean近似、0〜255程度) */
function colorDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number) {
  const rm = (r1 + r2) / 2;
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 3;
}

/** 外周の不透明画素から最頻色を背景色とする。外周の大半が透明なら null */
export function estimateBackground(d: Uint8ClampedArray, W: number, H: number): [number, number, number] | null {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0, opaque = 0;
  const add = (i: number) => {
    total++;
    if (d[i * 4 + 3] < 250) return;
    opaque++;
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = bins.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    bins.set(k, e);
  };
  for (let x = 0; x < W; x++) { add(x); add((H - 1) * W + x); }
  for (let y = 1; y < H - 1; y++) { add(y * W); add(y * W + W - 1); }
  if (opaque < total * 0.5) return null;
  // 量子化の境目で割れないよう、最頻ビンとその隣接ビンをまとめて平均
  let best: number | null = null, bestN = -1;
  for (const [k, e] of bins) if (e.n > bestN) { bestN = e.n; best = k; }
  const br = best! >> 8, bg = (best! >> 4) & 15, bb = best! & 15;
  let n = 0, r = 0, g = 0, b = 0;
  for (const [k, e] of bins) {
    if (Math.abs((k >> 8) - br) <= 1 && Math.abs(((k >> 4) & 15) - bg) <= 1 && Math.abs((k & 15) - bb) <= 1) {
      n += e.n; r += e.r; g += e.g; b += e.b;
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

export function removeBackground(src: Uint8ClampedArray, W: number, H: number, opt: BgRemoveOptions): BgRemoveResult {
  const d = new Uint8ClampedArray(src);
  const B = estimateBackground(d, W, H);
  if (!B) return { data: d, bg: null };
  const [Br, Bg, Bb] = B;
  const N = W * H;
  const tol = opt.tolerance;

  // 各画素の背景色との色差
  const dist = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    dist[i] = d[i * 4 + 3] < 8 ? 0 : colorDist(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], Br, Bg, Bb);
  }

  // 1) 外周から背景色に近い画素を塗りつぶし
  const bgMask = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0;
  const push = (i: number) => {
    if (!bgMask[i] && dist[i] < tol) {
      bgMask[i] = 1;
      stack[sp++] = i;
    }
  };
  const flood = () => {
    while (sp) {
      const i = stack[--sp];
      const x = i % W;
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (i >= W) push(i - W);
      if (i < N - W) push(i + W);
    }
  };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  flood();

  // 2) 囲まれた背景(腕と体のすき間など)。小さい領域は目のハイライト等の可能性が高いので残す
  if (opt.removeEnclosed) {
    const minArea = Math.max(64, N * 0.0015);
    const comp = new Uint8Array(N);
    const members: number[] = [];
    for (let s = 0; s < N; s++) {
      if (bgMask[s] || comp[s] || dist[s] >= tol) continue;
      members.length = 0;
      comp[s] = 1;
      stack[0] = s;
      sp = 1;
      while (sp) {
        const i = stack[--sp];
        members.push(i);
        const x = i % W;
        const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < N - W ? i + W : -1];
        for (const j of nb) {
          if (j >= 0 && !comp[j] && !bgMask[j] && dist[j] < tol) {
            comp[j] = 1;
            stack[sp++] = j;
          }
        }
      }
      if (members.length >= minArea) for (const i of members) bgMask[i] = 1;
    }
  }

  // 3-4) 背景に接する帯のα推定と白フチ除去
  const alpha = bandMatte(d, src, W, H, bgMask, dist, B, tol);

  // 5) JPEGノイズ等の小さな浮島を除去
  removeIslands(alpha, W, H);

  for (let i = 0; i < N; i++) d[i * 4 + 3] = Math.round(d[i * 4 + 3] * alpha[i]);
  return { data: d, bg: B };
}

/**
 * 背景マスクに接する帯(R画素)の画素について、C = αF + (1-α)B とみなしてαを推定し、
 * d の色から背景の混ざり(白フチ)を除く。背景マスク内はα=0、帯より内側はα=1
 */
function bandMatte(
  d: Uint8ClampedArray,
  src: Uint8ClampedArray,
  W: number,
  H: number,
  bgMask: Uint8Array,
  dist: Float32Array,
  B: [number, number, number],
  tol: number,
): Float32Array {
  const N = W * H;
  const R = 3;
  const near = new Uint8Array(N).fill(255);
  let q: number[] = [];
  for (let i = 0; i < N; i++) {
    if (!bgMask[i]) continue;
    near[i] = 0;
    const x = i % W;
    if ((x > 0 && !bgMask[i - 1]) || (x < W - 1 && !bgMask[i + 1]) || (i >= W && !bgMask[i - W]) || (i < N - W && !bgMask[i + W])) q.push(i);
  }
  for (let step = 1; step <= R; step++) {
    const nq: number[] = [];
    for (const i of q) {
      const x = i % W, y = (i - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (near[j] === 255) {
            near[j] = step;
            nq.push(j);
          }
        }
      }
    }
    q = nq;
  }

  // 帯の画素: C = αF + (1-α)B とみなしてαを推定し、色から背景の混ざり(白フチ)を除く。
  //    前景色Fは、近くの内側画素のうち「CをBとの混色として最もよく説明できる色」を選ぶ
  const alpha = new Float32Array(N);
  const [Br, Bg, Bb] = B;
  const S = R + 2;
  const minF = tol * 2;
  for (let i = 0; i < N; i++) {
    if (bgMask[i]) continue;
    if (near[i] === 255) {
      alpha[i] = 1;
      continue;
    }
    const x = i % W, y = (i - x) / W;
    const cr = d[i * 4] - Br, cg = d[i * 4 + 1] - Bg, cb = d[i * 4 + 2] - Bb;
    let best = Infinity, a = 1, found = false;
    for (let yy = Math.max(0, y - S); yy <= Math.min(H - 1, y + S); yy++) {
      for (let xx = Math.max(0, x - S); xx <= Math.min(W - 1, x + S); xx++) {
        const j = yy * W + xx;
        if (bgMask[j] || near[j] < 2) continue;
        if (dist[j] < minF) continue; // 背景色と見分けにくい色(JPEGノイズ含む)はFの候補にしない
        const fr = src[j * 4] - Br, fg = src[j * 4 + 1] - Bg, fb = src[j * 4 + 2] - Bb;
        const ff = fr * fr + fg * fg + fb * fb;
        const t = Math.min(1, Math.max(0, (cr * fr + cg * fg + cb * fb) / ff));
        const er = cr - t * fr, eg = cg - t * fg, eb = cb - t * fb;
        const res = er * er + eg * eg + eb * eb;
        if (res < best) {
          best = res;
          a = t;
          found = true;
        }
      }
    }
    // 候補がない(白い服が白背景に接する等)ときは不透明のまま
    if (!found) {
      alpha[i] = 1;
      continue;
    }
    if (a < 0.05) {
      alpha[i] = 0;
      continue;
    }
    alpha[i] = a;
    if (a < 1) {
      d[i * 4] = Br + cr / a;
      d[i * 4 + 1] = Bg + cg / a;
      d[i * 4 + 2] = Bb + cb / a;
    }
  }

  return alpha;
}

/** α≥0.5 の連結成分のうち、ごく小さいもの(JPEGノイズ等)を透明にする */
function removeIslands(alpha: Float32Array, W: number, H: number) {
  const N = W * H;
  const stack = new Int32Array(N);
  let sp = 0;
  const minIsland = Math.max(9, Math.round(N * 0.00005));
  const seen = new Uint8Array(N);
  const island: number[] = [];
  for (let s = 0; s < N; s++) {
    if (seen[s] || alpha[s] < 0.5) continue;
    island.length = 0;
    seen[s] = 1;
    stack[0] = s;
    sp = 1;
    while (sp && island.length <= minIsland) {
      const i = stack[--sp];
      island.push(i);
      const x = i % W;
      if (x > 0 && !seen[i - 1] && alpha[i - 1] >= 0.5) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < W - 1 && !seen[i + 1] && alpha[i + 1] >= 0.5) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (i >= W && !seen[i - W] && alpha[i - W] >= 0.5) { seen[i - W] = 1; stack[sp++] = i - W; }
      if (i < N - W && !seen[i + W] && alpha[i + W] >= 0.5) { seen[i + W] = 1; stack[sp++] = i + W; }
    }
    if (island.length <= minIsland && sp === 0) {
      for (const i of island) alpha[i] = 0;
    } else {
      // 大きい連結成分: 残りを訪問済みにするだけ
      while (sp) {
        const i = stack[--sp];
        const x = i % W;
        if (x > 0 && !seen[i - 1] && alpha[i - 1] >= 0.5) { seen[i - 1] = 1; stack[sp++] = i - 1; }
        if (x < W - 1 && !seen[i + 1] && alpha[i + 1] >= 0.5) { seen[i + 1] = 1; stack[sp++] = i + 1; }
        if (i >= W && !seen[i - W] && alpha[i - W] >= 0.5) { seen[i - W] = 1; stack[sp++] = i - W; }
        if (i < N - W && !seen[i + W] && alpha[i + W] >= 0.5) { seen[i + W] = 1; stack[sp++] = i + W; }
      }
    }
  }
}

/** 半径 r のボックスブラー(縦横分離・累積和)。端は範囲内の画素だけで平均 */
function boxBlur(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  const line = new Float64Array(Math.max(W, H) + 1);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) line[x + 1] = line[x] + src[o + x];
    for (let x = 0; x < W; x++) {
      const a = Math.max(0, x - r), b = Math.min(W, x + r + 1);
      tmp[o + x] = (line[b] - line[a]) / (b - a);
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) line[y + 1] = line[y] + tmp[y * W + x];
    for (let y = 0; y < H; y++) {
      const a = Math.max(0, y - r), b = Math.min(H, y + r + 1);
      out[y * W + x] = (line[b] - line[a]) / (b - a);
    }
  }
  return out;
}

/**
 * AIマスクを画像に適用する。背景が単色でないので、境界の色は Blur-Fusion
 * (Forte & Pitié 2021, 近傍の前景/背景の平均色から前景色を推定) で背景の混ざりを除く
 */
export function applyMatte(src: Uint8ClampedArray, W: number, H: number, matte: Float32Array): Uint8ClampedArray {
  const N = W * H;
  const alpha = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = matte[i] * (src[i * 4 + 3] / 255);
    alpha[i] = a < 0.04 ? 0 : a > 0.96 ? 1 : a;
  }
  removeIslands(alpha, W, H);

  const I = [0, 1, 2].map((ch) => {
    const c = new Float32Array(N);
    for (let i = 0; i < N; i++) c[i] = src[i * 4 + ch] / 255;
    return c;
  });
  const scale = Math.max(W, H) / 1024;
  const blurA = (r: number) => boxBlur(alpha, W, H, r);
  const estimate = (F: Float32Array[], B: Float32Array[], r: number) => {
    const bA = blurA(r);
    const nF: Float32Array[] = [], nB: Float32Array[] = [];
    const fa = new Float32Array(N), b1a = new Float32Array(N);
    for (let ch = 0; ch < 3; ch++) {
      for (let i = 0; i < N; i++) {
        fa[i] = F[ch][i] * alpha[i];
        b1a[i] = B[ch][i] * (1 - alpha[i]);
      }
      const bF = boxBlur(fa, W, H, r), bB = boxBlur(b1a, W, H, r);
      const f = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        bF[i] /= bA[i] + 1e-5;
        bB[i] /= 1 - bA[i] + 1e-5;
        const a = alpha[i];
        const v = bF[i] + a * (I[ch][i] - a * bF[i] - (1 - a) * bB[i]);
        f[i] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
      nF.push(f);
      nB.push(bB);
    }
    return [nF, nB] as const;
  };
  let [F, B] = estimate(I, I, Math.max(8, Math.round(90 * scale)));
  [F] = estimate(F, B, Math.max(3, Math.round(6 * scale)));

  const d = new Uint8ClampedArray(src);
  for (let i = 0; i < N; i++) {
    const a = alpha[i];
    d[i * 4 + 3] = Math.round(a * 255);
    if (a > 0 && a < 1) for (let ch = 0; ch < 3; ch++) d[i * 4 + ch] = Math.round(F[ch][i] * 255);
  }
  return d;
}

/** 外周の画素のうち背景色 B に近いものの割合(単色背景かどうかの目安) */
export function borderMatchRatio(d: Uint8ClampedArray, W: number, H: number, B: [number, number, number], tol: number): number {
  let n = 0, hit = 0;
  const test = (i: number) => {
    n++;
    if (d[i * 4 + 3] < 250 || colorDist(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], B[0], B[1], B[2]) < tol) hit++;
  };
  for (let x = 0; x < W; x++) { test(x); test((H - 1) * W + x); }
  for (let y = 1; y < H - 1; y++) { test(y * W); test(y * W + W - 1); }
  return n ? hit / n : 1;
}

/**
 * 指定した点から、その点の色に近い領域を透過する(囲まれた背景をユーザーがクリックで消す用)。
 * 自動では「すき間から見える背景」と「背景と同じ色の絵柄(目のハイライト等)」を区別できないため。
 * cur: 現在の透過結果 / src: 元画像。境界は単色モードと同じ方法で白フチを除く
 */
export function eraseRegion(
  cur: Uint8ClampedArray,
  src: Uint8ClampedArray,
  W: number,
  H: number,
  px: number,
  py: number,
  tol: number,
): Uint8ClampedArray {
  const N = W * H;
  px = Math.min(W - 1, Math.max(0, Math.round(px)));
  py = Math.min(H - 1, Math.max(0, Math.round(py)));
  // クリック位置周辺の平均色を、その領域の背景色とする(グラデーション背景でも局所的には単色に近い)
  let n = 0, r = 0, g = 0, b = 0;
  for (let y = Math.max(0, py - 2); y <= Math.min(H - 1, py + 2); y++) {
    for (let x = Math.max(0, px - 2); x <= Math.min(W - 1, px + 2); x++) {
      const i = y * W + x;
      n++; r += src[i * 4]; g += src[i * 4 + 1]; b += src[i * 4 + 2];
    }
  }
  const B: [number, number, number] = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  const dist = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    dist[i] = src[i * 4 + 3] < 8 ? 0 : colorDist(src[i * 4], src[i * 4 + 1], src[i * 4 + 2], B[0], B[1], B[2]);
  }

  const mask = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0;
  const seed = py * W + px;
  mask[seed] = 1;
  stack[sp++] = seed;
  while (sp) {
    const i = stack[--sp];
    const x = i % W;
    const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < N - W ? i + W : -1];
    for (const j of nb) {
      if (j >= 0 && !mask[j] && dist[j] < tol) {
        mask[j] = 1;
        stack[sp++] = j;
      }
    }
  }

  const fixed = new Uint8ClampedArray(src);
  const alpha = bandMatte(fixed, src, W, H, mask, dist, B, tol);
  removeIslands(alpha, W, H);
  const out = new Uint8ClampedArray(cur);
  for (let i = 0; i < N; i++) {
    const a = alpha[i];
    if (a >= 1) continue;
    const na = Math.round(src[i * 4 + 3] * a);
    if (na >= out[i * 4 + 3]) continue;
    out[i * 4 + 3] = na;
    if (na > 0) {
      out[i * 4] = fixed[i * 4];
      out[i * 4 + 1] = fixed[i * 4 + 1];
      out[i * 4 + 2] = fixed[i * 4 + 2];
    }
  }
  return out;
}
