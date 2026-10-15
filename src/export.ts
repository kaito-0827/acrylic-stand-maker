// 入稿データ書き出し: EPS (PostScript Level 3) と AI (PDF互換 .ai、レイヤー付き)
import type { Loop, StandGeometry } from "./geometry";

export type Cmyk = [number, number, number, number];

export interface ExportOptions {
  cutColor: Cmyk;
  cutWidthPt: number;
  whiteColor: Cmyk;
  includeBase: boolean;
  marginMm: number;
}

export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
}

const PT = 72 / 25.4;
const enc = new TextEncoder();

function layout(geo: StandGeometry, opt: ExportOptions) {
  const b = { ...geo.bounds };
  if (!opt.includeBase) {
    b.maxX = -Infinity;
    for (const l of geo.cut) for (const p of l) b.maxX = Math.max(b.maxX, p.x);
  }
  const m = opt.marginMm;
  const wPt = (b.maxX - b.minX + 2 * m) * PT;
  const hPt = (b.maxY - b.minY + 2 * m) * PT;
  const X = (x: number) => (x - b.minX + m) * PT;
  const Y = (y: number) => (b.maxY - y + m) * PT;
  return { wPt, hPt, X, Y };
}

const f = (n: number) => {
  const s = n.toFixed(3);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};

function pathOps(loops: Loop[], X: (x: number) => number, Y: (y: number) => number, ps: boolean): string {
  const [M, L, Z] = ps ? ["moveto", "lineto", "closepath"] : ["m", "l", "h"];
  const out: string[] = [];
  for (const l of loops) {
    out.push(`${f(X(l[0].x))} ${f(Y(l[0].y))} ${M}`);
    for (let i = 1; i < l.length; i++) out.push(`${f(X(l[i].x))} ${f(Y(l[i].y))} ${L}`);
    out.push(Z);
  }
  return out.join("\n");
}

const cmyk = (c: Cmyk) => c.map(f).join(" ");

/** 透明部分を白で合成したRGBと、アルファを分けて取り出す */
function splitRaster(r: Raster) {
  const n = r.width * r.height;
  const rgb = new Uint8Array(n * 3);
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const al = r.data[i * 4 + 3];
    a[i] = al;
    for (let c = 0; c < 3; c++) {
      const v = r.data[i * 4 + c];
      rgb[i * 3 + c] = Math.round((v * al + 255 * (255 - al)) / 255);
    }
  }
  return { rgb, a };
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function ascii85(data: Uint8Array): string {
  const out: string[] = [];
  let line = "";
  const emit = (s: string) => {
    line += s;
    if (line.length >= 75) {
      out.push(line);
      line = "";
    }
  };
  let i = 0;
  for (; i + 4 <= data.length; i += 4) {
    let v = ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
    if (v === 0) {
      emit("z");
      continue;
    }
    const ch = new Array(5);
    for (let k = 4; k >= 0; k--) {
      ch[k] = String.fromCharCode((v % 85) + 33);
      v = Math.floor(v / 85);
    }
    emit(ch.join(""));
  }
  const rest = data.length - i;
  if (rest > 0) {
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (k < rest ? data[i + k] : 0);
    const ch = new Array(5);
    for (let k = 4; k >= 0; k--) {
      ch[k] = String.fromCharCode((v % 85) + 33);
      v = Math.floor(v / 85);
    }
    emit(ch.slice(0, rest + 1).join(""));
  }
  out.push(line + "~>");
  return out.join("\n");
}

// ================================================================ EPS
export async function buildEps(geo: StandGeometry, img: Raster, opt: ExportOptions): Promise<Blob> {
  const { wPt, hPt, X, Y } = layout(geo, opt);
  const { rgb } = splitRaster(img);
  const data = ascii85(await deflate(rgb));
  const bw = Math.ceil(wPt), bh = Math.ceil(hPt);
  const ix = X(0), iy = Y(geo.imgHmm);
  const iw = geo.imgWmm * PT, ih = geo.imgHmm * PT;

  const ps = `%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 ${bw} ${bh}
%%HiResBoundingBox: 0 0 ${f(wPt)} ${f(hPt)}
%%Title: acrylic-stand
%%Creator: Acrylic Stand Maker
%%CreationDate: ${new Date().toISOString()}
%%LanguageLevel: 3
%%DocumentData: Clean7Bit
%%EndComments
%%BeginProlog
%%EndProlog
%%Page: 1 1
save
countdictstack
mark
newpath
1 setlinejoin 1 setlinecap

% ---- 白版
${cmyk(opt.whiteColor)} setcmykcolor
${pathOps(geo.white, X, Y, true)}
eofill

% ---- 画像
gsave
newpath
${pathOps(geo.clip, X, Y, true)}
eoclip newpath
${f(ix)} ${f(iy)} translate ${f(iw)} ${f(ih)} scale
/DeviceRGB setcolorspace
<< /ImageType 1 /Width ${img.width} /Height ${img.height} /BitsPerComponent 8
   /Decode [0 1 0 1 0 1] /ImageMatrix [${img.width} 0 0 -${img.height} 0 ${img.height}]
   /DataSource currentfile /ASCII85Decode filter /FlateDecode filter >> image
${data}
grestore

% ---- カットライン
${cmyk(opt.cutColor)} setcmykcolor ${f(opt.cutWidthPt)} setlinewidth
newpath
${pathOps(geo.cut, X, Y, true)}
stroke
${opt.includeBase ? `
% ---- 台座カットライン
newpath
${pathOps(geo.base, X, Y, true)}
stroke` : ""}

cleartomark
countdictstack exch sub { end } repeat
restore
showpage
%%Trailer
%%EOF
`;
  return new Blob([ps], { type: "application/postscript" });
}

// ================================================================ AI (PDF互換)
function utf16Hex(s: string): string {
  let h = "FEFF";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    h += c.toString(16).padStart(4, "0").toUpperCase();
  }
  return `<${h}>`;
}

class PdfWriter {
  chunks: Uint8Array[] = [];
  offsets: number[] = [];
  pos = 0;
  write(s: string | Uint8Array) {
    const b = typeof s === "string" ? enc.encode(s) : s;
    this.chunks.push(b);
    this.pos += b.length;
  }
  obj(id: number, body: string, stream?: Uint8Array) {
    this.offsets[id] = this.pos;
    this.write(`${id} 0 obj\n${body}\n`);
    if (stream) {
      this.write("stream\n");
      this.write(stream);
      this.write("\nendstream\n");
    }
    this.write("endobj\n");
  }
  finish(rootId: number, infoId: number): Blob {
    const xref = this.pos;
    const n = this.offsets.length;
    let s = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (let i = 1; i < n; i++) {
      const o = this.offsets[i];
      s += o === undefined ? "0000000000 65535 f \n" : `${String(o).padStart(10, "0")} 00000 n \n`;
    }
    s += `trailer\n<< /Size ${n} /Root ${rootId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    this.write(s);
    return new Blob(this.chunks as BlobPart[], { type: "application/pdf" });
  }
}

export async function buildAi(geo: StandGeometry, img: Raster, opt: ExportOptions): Promise<Blob> {
  const { wPt, hPt, X, Y } = layout(geo, opt);
  const { rgb, a } = splitRaster(img);
  const [rgbZ, aZ] = await Promise.all([deflate(rgb), deflate(a)]);
  const ix = X(0), iy = Y(geo.imgHmm);
  const iw = geo.imgWmm * PT, ih = geo.imgHmm * PT;

  // レイヤー(OCG): 上から表示される順
  const layers = [
    { key: "Lcut", name: "カットライン", id: 10 },
    ...(opt.includeBase ? [{ key: "Lbase", name: "台座カットライン", id: 11 }] : []),
    { key: "Limg", name: "画像", id: 12 },
    { key: "Lwhite", name: "白版", id: 13 },
  ];

  const content = [
    `/OC /Lwhite BDC q ${cmyk(opt.whiteColor)} k\n${pathOps(geo.white, X, Y, false)}\nf* Q EMC`,
    `/OC /Limg BDC q ${f(iw)} 0 0 ${f(ih)} ${f(ix)} ${f(iy)} cm /Im1 Do Q EMC`,
    `/OC /Lcut BDC q 1 j 1 J ${cmyk(opt.cutColor)} K ${f(opt.cutWidthPt)} w\n${pathOps(geo.cut, X, Y, false)}\nS Q EMC`,
    opt.includeBase
      ? `/OC /Lbase BDC q 1 j 1 J ${cmyk(opt.cutColor)} K ${f(opt.cutWidthPt)} w\n${pathOps(geo.base, X, Y, false)}\nS Q EMC`
      : "",
  ].join("\n");
  const contentZ = await deflate(enc.encode(content));

  const w = new PdfWriter();
  w.write("%PDF-1.6\n%\xE2\xE3\xCF\xD3\n");
  const ocgRefs = layers.map((l) => `${l.id} 0 R`).join(" ");
  w.obj(1, `<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [${ocgRefs}] /D << /Order [${ocgRefs}] /ON [${ocgRefs}] >> >> >>`);
  w.obj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
  const props = layers.map((l) => `/${l.key} ${l.id} 0 R`).join(" ");
  const box = `[0 0 ${f(wPt)} ${f(hPt)}]`;
  w.obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox ${box} /TrimBox ${box} /ArtBox ${box} /Resources << /XObject << /Im1 5 0 R >> /Properties << ${props} >> >> /Contents 4 0 R >>`);
  w.obj(4, `<< /Length ${contentZ.length} /Filter /FlateDecode >>`, contentZ);
  w.obj(5, `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask 6 0 R /Length ${rgbZ.length} >>`, rgbZ);
  w.obj(6, `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${aZ.length} >>`, aZ);
  w.obj(7, `<< /Producer (Acrylic Stand Maker) /Creator (Acrylic Stand Maker) /Title (acrylic-stand) >>`);
  for (const l of layers) w.obj(l.id, `<< /Type /OCG /Name ${utf16Hex(l.name)} >>`);
  return w.finish(1, 7);
}

// ================================================================ プレビュー用SVG
export function loopsToSvgPath(loops: Loop[]): string {
  return loops
    .map((l) => "M" + l.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join("L") + "Z")
    .join("");
}
