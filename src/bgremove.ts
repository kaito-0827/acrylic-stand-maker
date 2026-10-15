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

  // 3) 背景に接する帯(R画素)を求める
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

  // 4) 帯の画素: C = αF + (1-α)B とみなしてαを推定し、色から背景の混ざり(白フチ)を除く。
  //    前景色Fは、近くの内側画素のうち「CをBとの混色として最もよく説明できる色」を選ぶ
  const alpha = new Float32Array(N);
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

  // 5) JPEGノイズ等の小さな浮島を除去
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

  for (let i = 0; i < N; i++) d[i * 4 + 3] = Math.round(d[i * 4 + 3] * alpha[i]);
  return { data: d, bg: B };
}
