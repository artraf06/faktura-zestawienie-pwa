// Lokalny (bez AI) odczyt tabeli pozycji z obrazu faktury.
// Kroki: wyprostowanie → wykrycie linii tabeli → paski kolumn → nagłówki →
// wiersze wg numerów Lp → OCR kolumn → kontrola ilości (wartość ÷ cena).

export type Gray = { w: number; h: number; d: Uint8Array };
export type OcrWord = { t: string; x: number; y: number; w: number; h: number; conf: number; line: number };
export type OcrFn = (img: Gray, o: { psm: number; whitelist?: string; scale: number }) => Promise<OcrWord[]>;
export type Pozycja = { lp: number; name: string; quantity: string; unit: string; uwaga?: string };

type Linia = { k: number; c: number; lo: number; hi: number; pos: number };
type Kol = { xc: number; wid: number; strip: Gray; hs: Gray; head: string; typ: string | null; brutto: boolean; netto: boolean; dy?: number };
type Kotwica = { n: number; y: number; h: number; top?: number; bot?: number };

const DEBUG = !!(globalThis as { __ocrDebug?: boolean }).__ocrDebug || (typeof process !== "undefined" && !!(globalThis as any).process?.env?.OCR_DEBUG);
const UNITS = /\b(szt|kpl|mb|m2|m3|kg|op|opak|usł|usl|godz|para|pary|rolka|rolki|ryza|kpl|l|m|t|g)\b/;
const KROPKA = new Set(["szt", "kpl", "op", "opak", "usł", "godz"]);
const KEYS: Record<string, string[]> = {
  lp: ["lp", "l.p.", "lp."], nazwa: ["nazwa", "towaru", "usługi", "opis", "asortyment"], ilosc: ["ilość", "ilosc", "il."],
  jm: ["miara", "j.m.", "jm", "jedn.m.", "jednostka", "jedn.m"], cena: ["cena"], wartosc: ["wartość", "wartosc"],
  vat: ["stawka", "vat", "podatku", "kwota"], brutto: ["brutto"], netto: ["netto"],
};

// ---------- operacje na obrazie ----------
export function progSrednia(g: Gray, blok: number, C: number): Uint8Array {
  const { w, h, d } = g, r = blok >> 1, out = new Uint8Array(w * h);
  const hs = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) s += d[o + x];
    for (let x = 0; x < w; x++) {
      hs[o + x] = s;
      const a = x + r + 1, b = x - r;
      if (a < w) s += d[o + a];
      if (b >= 0) s -= d[o + b];
    }
  }
  const col = new Uint32Array(w);
  for (let y = 0; y <= Math.min(r, h - 1); y++) for (let x = 0; x < w; x++) col[x] += hs[y * w + x];
  for (let y = 0; y < h; y++) {
    const ny = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
    for (let x = 0; x < w; x++) {
      const nx = Math.min(w - 1, x + r) - Math.max(0, x - r) + 1;
      const mean = col[x] / (nx * ny);
      out[y * w + x] = d[y * w + x] <= mean - C ? 1 : 0;
    }
    const a = y + r + 1, b = y - r;
    if (a < h) for (let x = 0; x < w; x++) col[x] += hs[a * w + x];
    if (b >= 0) for (let x = 0; x < w; x++) col[x] -= hs[b * w + x];
  }
  return out;
}

// otwarcie odcinkiem = zostają tylko serie pikseli o długości >= L
function serie(m: Uint8Array, w: number, h: number, L: number, poziomo: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  const n1 = poziomo ? h : w, n2 = poziomo ? w : h;
  for (let i = 0; i < n1; i++) {
    let start = -1;
    for (let j = 0; j <= n2; j++) {
      const idx = poziomo ? i * w + j : j * w + i;
      const on = j < n2 && m[idx] === 1;
      if (on && start < 0) start = j;
      if (!on && start >= 0) {
        if (j - start >= L) for (let t = start; t < j; t++) out[poziomo ? i * w + t : t * w + i] = 1;
        start = -1;
      }
    }
  }
  return out;
}

function dylatacja(m: Uint8Array, w: number, h: number, rx: number, ry: number): Uint8Array {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w; let cnt = 0;
    for (let x = 0; x < Math.min(rx, w); x++) cnt += m[o + x];
    for (let x = 0; x < w; x++) {
      if (x + rx < w) cnt += m[o + x + rx];
      if (x - rx - 1 >= 0) cnt -= m[o + x - rx - 1];
      tmp[o + x] = cnt > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let y = 0; y < Math.min(ry, h); y++) cnt += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + ry < h) cnt += tmp[(y + ry) * w + x];
      if (y - ry - 1 >= 0) cnt -= tmp[(y - ry - 1) * w + x];
      out[y * w + x] = cnt > 0 ? 1 : 0;
    }
  }
  return out;
}

type Skladowa = { x0: number; y0: number; x1: number; y1: number; n: number; sx: number; sy: number; sxx: number; sxy: number; syy: number };
function skladowe(m: Uint8Array, w: number, h: number, lab?: Int32Array): Skladowa[] {
  const L = lab || new Int32Array(w * h); L.fill(0);
  const out: Skladowa[] = [];
  const stos = new Int32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    if (!m[p] || L[p]) continue;
    const id = out.length + 1;
    const s: Skladowa = { x0: 1e9, y0: 1e9, x1: -1, y1: -1, n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 };
    let sp = 0; stos[sp++] = p; L[p] = id;
    while (sp) {
      const q = stos[--sp], x = q % w, y = (q - x) / w;
      s.n++; s.sx += x; s.sy += y; s.sxx += x * x; s.sxy += x * y; s.syy += y * y;
      if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x; if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const r = yy * w + xx;
          if (m[r] && !L[r]) { L[r] = id; stos[sp++] = r; }
        }
      }
    }
    out.push(s);
  }
  return out;
}

function dopasujLinie(mask: Uint8Array, w: number, h: number, poziomo: boolean, minLen: number): Linia[] {
  const m = dylatacja(mask, w, h, 1, 1);
  // odcinki: u = współrzędna wzdłuż linii, v = w poprzek; v = k*u + c
  type Odc = { n: number; su: number; sv: number; suu: number; suv: number; lo: number; hi: number; k: number; c: number };
  const fit = (o: Odc) => { const den = o.n * o.suu - o.su * o.su; o.k = den ? (o.n * o.suv - o.su * o.sv) / den : 0; o.c = (o.sv - o.k * o.su) / o.n; return o; };
  const odc: Odc[] = [];
  for (const s of skladowe(m, w, h)) {
    const len = poziomo ? s.x1 - s.x0 + 1 : s.y1 - s.y0 + 1;
    if (len < Math.min(minLen, 60) ) continue;
    odc.push(fit(poziomo
      ? { n: s.n, su: s.sx, sv: s.sy, suu: s.sxx, suv: s.sxy, lo: s.x0, hi: s.x1 + 1, k: 0, c: 0 }
      : { n: s.n, su: s.sy, sv: s.sx, suu: s.syy, suv: s.sxy, lo: s.y0, hi: s.y1 + 1, k: 0, c: 0 }));
  }
  // łączenie przerwanych/wygiętych kawałków tej samej linii
  odc.sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo));
  const lin: Odc[] = [];
  for (const o of odc) {
    const mid = (o.lo + o.hi) / 2, vo = o.k * mid + o.c;
    const cel = lin.find(l => {
      const gap = Math.max(o.lo - l.hi, l.lo - o.hi);
      const ref = o.lo > l.hi ? o.lo : o.hi < l.lo ? o.hi : mid;
      return gap < 0.25 * (poziomo ? w : h) && Math.abs(l.k * ref + l.c - (o.k * ref + o.c)) < 10 && Math.abs(l.k * mid + l.c - vo) < 25;
    });
    if (cel) { cel.n += o.n; cel.su += o.su; cel.sv += o.sv; cel.suu += o.suu; cel.suv += o.suv; cel.lo = Math.min(cel.lo, o.lo); cel.hi = Math.max(cel.hi, o.hi); fit(cel); }
    else lin.push({ ...o });
  }
  const out: Linia[] = lin.filter(l => l.hi - l.lo >= minLen).map(l => ({ k: l.k, c: l.c, lo: l.lo, hi: l.hi, pos: l.k * (l.lo + l.hi) / 2 + l.c }));
  out.sort((a, b) => a.pos - b.pos);
  const scal: Linia[] = [];
  for (const l of out) {
    const p = scal[scal.length - 1];
    if (p && Math.abs(l.pos - p.pos) < 12 && !(l.lo > p.hi || l.hi < p.lo)) { p.lo = Math.min(p.lo, l.lo); p.hi = Math.max(p.hi, l.hi); }
    else scal.push({ ...l });
  }
  return scal;
}

export function obroc(g: Gray, stopnie: number): Gray {
  if (Math.abs(stopnie) < 0.05) return g;
  const { w, h, d } = g, a = (stopnie * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), cx = w / 2, cy = h / 2;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = cx + c * (x - cx) - s * (y - cy), sy = cy + s * (x - cx) + c * (y - cy);
    const x0 = Math.floor(sx), y0 = Math.floor(sy);
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) { out[y * w + x] = 255; continue; }
    const fx = sx - x0, fy = sy - y0, i = y0 * w + x0;
    out[y * w + x] = (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + w] * (1 - fx) + d[i + w + 1] * fx) * fy;
  }
  return { w, h, d: out };
}

function maski(g: Gray) {
  const b = progSrednia(g, 41, 15);
  // tolerancja 1 px w poprzek, żeby lekko pochylone/wygięte linie nie rwały się na krótkie kawałki
  const hm = serie(dylatacja(b, g.w, g.h, 0, 1), g.w, g.h, Math.max(40, Math.floor(g.w / 30)), true);
  const vm = serie(dylatacja(b, g.w, g.h, 1, 0), g.w, g.h, Math.max(40, Math.floor(g.h / 50)), false);
  for (let i = 0; i < b.length; i++) { hm[i] &= b[i]; vm[i] &= b[i]; }
  return { hm, vm };
}

function katPochylenia(hm: Uint8Array, w: number, h: number): number {
  const ls = dopasujLinie(hm, w, h, true, Math.floor(w / 6));
  if (!ls.length) return 0;
  const a = ls.map(l => (Math.atan(l.k) * 180) / Math.PI).filter(v => Math.abs(v) < 15).sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : 0;
}

// ---------- tekst ----------
function lcsRatio(a: string, b: string) {
  const m = a.length, n = b.length; if (!m || !n) return 0;
  const dp = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) { let prev = 0; for (let j = 1; j <= n; j++) { const t = dp[j]; dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]); prev = t; } }
  return (2 * dp[n]) / (m + n);
}
function fuzzyHas(text: string, words: string[], thr = 0.75) {
  const toks = text.toLowerCase().match(/[\wąćęłńóśźż.]+/g) || [];
  return toks.some(t => words.some(w => lcsRatio(t, w) >= thr));
}
function linieTekstu(ws: OcrWord[]) {
  const L = new Map<number, OcrWord[]>();
  for (const w of ws) { const a = L.get(w.line) || []; a.push(w); L.set(w.line, a); }
  return [...L.values()].map(a => {
    a.sort((p, q) => p.x - q.x);
    const ys = a.map(w => w.y + w.h / 2).sort((p, q) => p - q);
    return { t: a.map(w => w.t).join(" "), y: ys[ys.length >> 1], conf: Math.min(...a.map(w => w.conf)), x: a[0].x, h: mediana(a.map(w => w.h)) };
  }).sort((p, q) => p.y - q.y);
}
const tekst = (ws: OcrWord[]) => linieTekstu(ws).map(l => l.t).join(" ");
export function kwota(s?: string): number | null {
  const m = (s || "").trim().match(/^(\d{1,3}(?:[ .]?\d{3})*|\d+)[,.](\d{2})$/);
  return m ? Number(m[1].replace(/[ .]/g, "") + "." + m[2]) : null;
}
function wytnij(g: Gray, y0: number, y1: number): Gray {
  y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(g.h, Math.floor(y1));
  if (y1 <= y0) return { w: g.w, h: 0, d: new Uint8Array(0) };
  return { w: g.w, h: y1 - y0, d: g.d.slice(y0 * g.w, y1 * g.w) };
}

// ---------- główna funkcja ----------
export async function odczytajTabele(src: Gray, ocr: OcrFn, postep?: (p: number, opis: string) => void): Promise<Pozycja[]> {
  const krok = (p: number, o: string) => postep?.(p, o);
  krok(5, "Prostuję zdjęcie…");
  let { hm } = maski(src);
  const g = obroc(src, katPochylenia(hm, src.w, src.h));
  const m2 = maski(g); hm = m2.hm; const vm = m2.vm;
  const { w: W, h: H } = g;
  krok(12, "Szukam tabeli…");
  const vl = dopasujLinie(vm, W, H, false, Math.floor(H / 25));
  const hl = dopasujLinie(hm, W, H, true, Math.floor(W / 12));
  // czysty obraz: tekst czarny na białym, bez linii tabeli i drobnych kropek
  const ink = progSrednia(g, 31, 12);
  const linie = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) linie[i] = hm[i] | vm[i];
  const usun = dylatacja(linie, W, H, 2, 2);
  for (let i = 0; i < W * H; i++) if (usun[i]) ink[i] = 0;
  const lab = new Int32Array(W * H);
  const sk = skladowe(ink, W, H, lab);
  const clean = new Uint8Array(W * H).fill(255);
  for (let i = 0; i < W * H; i++) if (ink[i] && sk[lab[i] - 1].n >= 12) clean[i] = 0;
  const siatka = dylatacja(linie, W, H, 4, 4);
  const tabele = skladowe(siatka, W, H, lab).filter(s => s.x1 - s.x0 >= W * 0.25 && s.y1 - s.y0 >= 120);
  if (!tabele.length) return [];

  let best: null | { score: number; cols: Kol[]; y0: number; y1: number; ybot: number; lpc: Kol; anchors: Kotwica[]; hb: number; nazwy: Map<number, string> } = null;
  for (const t of tabele) {
    const x = t.x0, y = t.y0, w = t.x1 - t.x0 + 1, hh = t.y1 - t.y0 + 1;
    const nak = (l: Linia) => Math.min(l.hi, y + hh) - Math.max(l.lo, y);
    const inside = vl.filter(l => (l.pos >= x - 10 && l.pos <= x + w + 10 && nak(l) > 0.4 * hh) || (l.pos >= x - 0.2 * W && l.pos <= x + w + 0.3 * W && nak(l) > 0.8 * hh)).sort((a, b) => a.pos - b.pos);
    const ls: Linia[] = [];
    for (const l of inside) { if (ls.length && l.pos - ls[ls.length - 1].pos < 15) continue; ls.push(l); }
    if (ls.length < 3) continue;
    // lewa krawędź tabeli bez wykrytej linii (np. wygięta kartka) → sztuczna linia na brzegu tabeli
    if (ls[0].pos - x > 0.15 * W) { const mid = y + hh / 2; ls.unshift({ k: ls[0].k, c: x + 2 - ls[0].k * mid, lo: y, hi: y + hh, pos: x + 2 }); }
    if (ls.length < 4) continue;
    const y0 = y, y1 = y + hh, Hs = y1 - y0;
    const cols: Kol[] = [];
    for (let i = 0; i + 1 < ls.length; i++) {
      const A = ls[i], B = ls[i + 1];
      const wid = Math.round(((B.k * y0 + B.c - (A.k * y0 + A.c)) + (B.k * y1 + B.c - (A.k * y1 + A.c))) / 2) - 4;
      if (wid < 20) continue;
      const strip = new Uint8Array(wid * Hs), hs = new Uint8Array(wid * Hs);
      for (let yy = 0; yy < Hs; yy++) {
        const Y = y0 + yy, xa = A.k * Y + A.c + 2, xb = B.k * Y + B.c - 2;
        for (let xx = 0; xx < wid; xx++) {
          const X = Math.round(xa + ((xb - xa) * xx) / wid);
          const ok = X >= 0 && X < W && Y < H;
          strip[yy * wid + xx] = ok ? clean[Y * W + X] : 255;
          hs[yy * wid + xx] = ok ? hm[Y * W + X] : 0;
        }
      }
      cols.push({ xc: (A.k * (y0 + y1) / 2 + A.c + B.k * (y0 + y1) / 2 + B.c) / 2, wid, strip: { w: wid, h: Hs, d: strip }, hs: { w: wid, h: Hs, d: hs }, head: "", typ: null, brutto: false, netto: false });
    }
    if (cols.length < 3) continue;
    // kolumna Lp = ta z najdłuższym ciągiem kolejnych liczb
    const his = ls.map(l => l.hi).sort((a, b) => a - b), ybot = his[his.length >> 1] - y0;
    let lpc: Kol | null = null, anchors: Kotwica[] = [], nazwy = new Map<number, string>();
    for (const c of cols.slice(0, 3)) {
      if (c.wid > 250) {
        // Lp sklejone z nazwą (brak linii między nimi)
        const r = await laczone(c, ocr, ybot);
        if (r.an.length > anchors.length + 1) { lpc = c; anchors = r.an; nazwy = r.nazwy; }
        continue;
      }
      let an = await pasma(c, ocr, ybot);
      if (an.length < 2) {
        an = await kotwice(c, ocr);
        // brakujący numer tuż nad pierwszym (np. „1” przyklejone do linii nagłówka)
        while (an.length >= 2 && an[0].n > 1) {
          const rh = an[1].y - an[0].y, a0 = an[0];
          const reg = wytnij(c.strip, a0.y - 1.4 * rh, a0.y - 0.2 * rh);
          let hit: Kotwica | null = null;
          for (const [s0, s1] of wierszeTekstu(reg).reverse()) {
            for (const psm of [7, 10]) {
              const ws = (await ocr(wytnij(reg, s0 - 3, s1 + 3), { psm, scale: 2, whitelist: "0123456789" })).filter(w => w.t === String(a0.n - 1));
              if (ws.length) { hit = { n: a0.n - 1, y: Math.max(0, a0.y - 1.4 * rh) + s0, h: s1 - s0 }; break; }
            }
            if (hit) break;
          }
          if (!hit) break;
          an.unshift(hit);
        }
      }
      if (an.length > anchors.length) { lpc = c; anchors = an; nazwy = new Map(); }
    }
    if (!lpc || !anchors.length) continue;
    const hb = anchors[0].top ?? Math.max(40, anchors[0].y - 0.4 * anchors[0].h - 4);
    for (const c of cols) {
      c.head = tekst(await ocr(wytnij(c.strip, 0, hb), { psm: 6, scale: 1 }));
      for (const typ of ["lp", "nazwa", "ilosc", "cena", "wartosc", "vat", "jm"]) {
        if (fuzzyHas(c.head, KEYS[typ], typ === "lp" || typ === "jm" ? 0.9 : 0.75)) { c.typ = typ; break; }
      }
      c.brutto = fuzzyHas(c.head, KEYS.brutto); c.netto = fuzzyHas(c.head, KEYS.netto);
    }
    lpc.typ = nazwy.size ? "lp+nazwa" : "lp";
    if (nazwy.size) for (const c of cols) if (c.typ === "nazwa") c.typ = null;
    const score = cols.filter(c => c.typ).length + (cols.some(c => c.typ === "nazwa") ? 5 : 0) + anchors.length;
    if (!best || score > best.score) best = { score, cols, y0, y1, ybot, lpc, anchors, hb, nazwy };
  }
  if (!best) return [];
  if (DEBUG) console.log('COLS', JSON.stringify(best.cols.map(c => c.typ + ':' + c.head.slice(0, 20))), 'ANCH', best.anchors.map(a => a.n + '@' + Math.round(a.y)).join(' '));
  krok(40, "Odczytuję kolumny…");
  const { cols, lpc } = best;
  const nazwyLacz = best.nazwy;
  // uzupełnij brakujące numery Lp (np. 10, 12 → 11)
  const anchors: Kotwica[] = [];
  for (const a of best.anchors) {
    const p = anchors[anchors.length - 1];
    if (p && a.top === undefined && a.n - p.n > 1 && a.n - p.n <= 3)
      for (let j = 1; j < a.n - p.n; j++) anchors.push({ n: p.n + j, y: p.y + ((a.y - p.y) * j) / (a.n - p.n), h: p.h });
    anchors.push(a);
  }
  const rowh = anchors.length > 1 ? mediana(anchors.slice(1).map((a, i) => a.y - anchors[i].y)) : 80;
  const hb0 = anchors[0].top ?? anchors[0].y - 0.6 * anchors[0].h;

  const linieKol = async (c: Kol, rodzaj: string) => {
    const dy = c.dy || 0;
    // początek danych: linia pod nagłówkiem w tej kolumnie (liczby bywają wydrukowane wyżej niż nazwy)
    let t0 = hb0 + dy;
    const pr = profil(c.hs), a0 = anchors[0].y + dy;
    if (anchors[0].top === undefined)
      for (let y = Math.floor(a0); y > Math.max(0, a0 - 0.8 * rowh); y--) if (pr[y] > 0.5) { t0 = Math.min(t0, y + 3); break; }
    if (rodzaj !== "nazwa" && anchors[0].top === undefined) t0 -= 0.4 * rowh;
    t0 = Math.max(0, t0);
    const t1 = Math.min(c.strip.h, best!.ybot + dy);
    const reg = wytnij(c.strip, t0, t1);
    if (!reg.h) return [];
    if (rodzaj === "nazwa") {
      const ws = await ocr(reg, { psm: 6, scale: 1.5 });
      return linieTekstu(ws).map(l => ({ ...l, y: l.y + Math.floor(t0) - dy }));
    }
    // kolumny krótkie: dzielę na wiersze tekstu wg rzutu poziomego i czytam każdy osobno
    const out: { t: string; y: number; conf: number }[] = [];
    for (const [a, b] of wierszeTekstu(reg)) {
      const kaw = wytnij(reg, a - 3, b + 3);
      let ws = await ocr(kaw, rodzaj === "jm" ? { psm: 7, scale: 2 } : { psm: 7, scale: 2, whitelist: "0123456789,." });
      if (!ws.length && rodzaj !== "jm") {
        ws = (await ocr(kaw, { psm: 8, scale: 2 })).map(w => ({ ...w, t: w.t.replace(/[lI|!\]\[]/g, "1").replace(/[oO]/g, "0").replace(/[^0-9,.]/g, "") })).filter(w => w.t);
      }
      const t = ws.map(w => w.t).join(" ").trim();
      if (t) out.push({ t, y: (a + b) / 2 + Math.floor(t0) - dy, conf: Math.min(...ws.map(w => w.conf)) });
    }
    return out;
  };
  if (!nazwyLacz.size && !cols.some(c => c.typ === "nazwa")) {
    const wolne = cols.filter(c => !c.typ); if (wolne.length) wolne.sort((a, b) => b.wid - a.wid)[0].typ = "nazwa";
  }
  if (!cols.some(c => c.typ === "jm")) {
    for (const c of cols) {
      if (c.typ || c.wid >= 400) continue;
      const t = (await linieKol(c, "jm")).map(l => l.t.toLowerCase()).join(" ");
      if ((t.match(new RegExp(UNITS.source, "g")) || []).length >= Math.max(1, anchors.length >> 1)) { c.typ = "jm"; break; }
    }
  }
  const ay = anchors.map(a => a.y + a.h / 2);
  const tw = cols[cols.length - 1].xc - cols[0].xc;
  const kNach = mediana(hl.filter(l => l.pos >= best!.y0 - 5 && l.pos <= best!.y1 + 5 && l.hi - l.lo > 0.3 * tw).map(l => l.k));
  if (!cols.some(c => c.typ === "ilosc")) {
    // bez nagłówka: ilość = pierwsza kolumna z samymi liczbami całkowitymi
    for (const c of cols) {
      if (c.typ || c.wid >= 400) continue;
      const ls = linieTekstu(await ocr(wytnij(c.strip, 0, best.ybot), { psm: 6, scale: 1.5, whitelist: "0123456789,.-" }));
      const cal = ls.filter(l => /^\d{1,4}(,\d)?$/.test(l.t.replace(/\s/g, ""))).length;
      if (ls.length >= 2 && cal >= 0.6 * ls.length && cal >= Math.min(anchors.length, 3) * 0.6) { c.typ = "ilosc"; break; }
    }
  }
  const rows: Record<string, string>[] = anchors.map(a => (nazwyLacz.has(a.n) ? { nazwa: nazwyLacz.get(a.n)! } : {}) as Record<string, string>);
  const kolej = ["ilosc", "jm", "nazwa", "cena", "wartosc"];
  const potrzebne = cols.filter(c => c.typ && kolej.includes(c.typ)).sort((a, b) => kolej.indexOf(a.typ!) - kolej.indexOf(b.typ!));
  let nr = 0, wyrownanie = false;
  for (const c of potrzebne) {
    krok(40 + Math.round((50 * nr++) / potrzebne.length), c.typ === "nazwa" ? "Odczytuję nazwy…" : "Odczytuję ilości i jednostki…");
    c.dy = przesuniecie(lpc, c, rowh, kNach * (c.xc - lpc.xc));
    let key = c.typ!;
    if (key === "cena" || key === "wartosc") key += c.brutto ? "_b" : c.netto ? "_n" : "";
    let ls = await linieKol(c, c.typ!);
    if (key === "nazwa") {
      for (const l of ls) {
        let i = 0;
        if (anchors.every(a => a.top !== undefined)) anchors.forEach((a, j) => { if (a.top! - 4 <= l.y) i = j; });
        else {
          if (l.y < ay[0] - 0.3 * rowh) continue; // resztki nagłówka nad pierwszą pozycją
          ay.forEach((y, j) => { if (y - 0.25 * rowh <= l.y) i = j; });
        }
        rows[i].nazwa = ((rows[i].nazwa || "") + " " + l.t).trim();
        rows[i]["nazwa?"] = String(Math.min(Number(rows[i]["nazwa?"] ?? 100), l.conf));
      }
      if (DEBUG) console.log('nazwy', ls.map(l => `${l.t.slice(0, 12)}@${Math.round(l.y)}`).join(' | '), 'ay', ay.map(Math.round).join(' '));
      continue;
    }
    ls = ls.filter(l => l.y >= ay[0] - rowh && (key === "jm" ? /[a-ząćęłńóśźż]{1,}/i.test(l.t) && l.t.length <= 8 : /\d/.test(l.t)));
    if (DEBUG) console.log(key, ls.length, "vs", anchors.length, ls.map(l => `${l.t}@${Math.round(l.y)}:${Math.round(l.conf)}`).join(" "));
    if (key === "ilosc" && ls.length > anchors.length) {
      // ilości poniżej ostatniego / powyżej pierwszego Lp → brakujące wiersze
      for (const l of ls) {
        const ost = anchors[anchors.length - 1];
        if (l.y > ay[ay.length - 1] + 0.6 * rowh && l.y < best.ybot) {
          const a: Kotwica = { n: ost.n + 1, y: l.y - 10, h: 20 };
          if (ost.bot !== undefined) { a.top = ost.bot; a.bot = best.ybot - 4; }
          anchors.push(a); ay.push(l.y); rows.push({});
        }
      }
      for (const l of [...ls].reverse()) {
        if (anchors[0].top === undefined && anchors[0].n > 1 && l.y < ay[0] - 0.6 * rowh && l.y > ay[0] - 1.6 * rowh) {
          anchors.unshift({ n: anchors[0].n - 1, y: l.y - 10, h: 20 }); ay.unshift(l.y); rows.unshift({});
        }
      }
    }
    while (ls.length > anchors.length) {
      const i = ls.reduce((bi, l, j) => (l.conf < ls[bi].conf ? j : bi), 0);
      if (ls[i].conf >= 30) break;
      ls.splice(i, 1);
    }
    const rowny = ls.length === anchors.length;
    if (!rowny && key !== "jm") wyrownanie = true;
    const przyp = rowny ? ls.map((_, i) => i) : dopasuj(ls.map(l => l.y), ay, rowh);
    przyp.forEach((j, i) => { if (j >= 0) { rows[j][key] ??= ls[i].t; rows[j][key + "#"] ??= String(ls[i].conf); if (ls[i].conf < 30) rows[j][key + "?"] = "1"; } });
  }
  krok(95, "Sprawdzam ilości…");
  const wynik = rows.map((r, i) => {
    const qm = (r.ilosc || "").match(/\d+(?:[.,]\d+)?/);
    let q = qm ? Number(qm[0].replace(",", ".")) : null;
    const pewna = (k: string) => Number(r[k + "#"] ?? 0) >= 60;
    const pary = (["_b", "_n", ""] as const).filter(s => pewna("cena" + s) && pewna("wartosc" + s)).map(s => [kwota(r["cena" + s]), kwota(r["wartosc" + s])] as const).filter((p): p is readonly [number, number] => !!p[0] && !!p[1]);
    const zgodna = (n: number) => pary.some(([c, w]) => Math.abs(n * c - w) <= 0.02 + 0.0006 * w);
    let uwaga = "";
    if (q !== null && zgodna(q)) { /* potwierdzona */ }
    else {
      let poprawiona = false;
      for (const [c, w] of wyrownanie ? [] : pary) {
        const n = Math.round(w / c);
        if (n > 0 && Math.abs(n * c - w) <= 0.02 + 0.0006 * w) { uwaga = q === null ? "Ilość wyliczona z ceny i wartości" : `Poprawiono ilość ${q} → ${n} (wartość ÷ cena)`; q = n; poprawiona = true; break; }
      }
      if (!poprawiona && (q === null || r["ilosc?"] || pary.length)) uwaga = "Sprawdź ilość";
    }
    const jm = (r.jm || "").toLowerCase().replace(/[^a-ząćęłńóśźż0-9.]/g, "").replace(/^s[zż2][tf1li]/, "szt").replace(/^kp[1li|]/, "kpl").replace(/^rnb/, "mb");
    const um = jm.match(UNITS);
    const unit = um ? (um[1] === "usl" ? "usł" : um[1]) + (KROPKA.has(um[1]) ? "." : "") : "";
    if (!unit && !uwaga) uwaga = "Sprawdź jednostkę";
    const name = (r.nazwa || "").replace(/^[|\[\]{}()_\-—–=~,.:;'"`“”„‘’«»\s]+/, "").replace(/[|\[\]{}_—–=~\s]+$/, "").replace(/\s+/g, " ");
    if (!name) uwaga = "Nie odczytano nazwy";
    else if (!uwaga && Number(r["nazwa?"] ?? 100) < 45) uwaga = "Sprawdź nazwę";
    return { lp: anchors[i].n, name, quantity: q === null ? "" : String(q).replace(".", ","), unit, uwaga: uwaga || undefined };
  });
  // brakująca jednostka → najczęstsza w tej fakturze (z ostrzeżeniem)
  const licz = new Map<string, number>();
  for (const w of wynik) if (w.unit) licz.set(w.unit, (licz.get(w.unit) || 0) + 1);
  const czesta = [...licz.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (czesta) for (const w of wynik) if (!w.unit) { w.unit = czesta; w.uwaga ??= "Sprawdź jednostkę"; }
  return wynik;
}

// monotoniczne przypisanie linii do wierszy (DP) ze wspólnym przesunięciem pionowym
function dopasuj(ly: number[], ay: number[], rowh: number): number[] {
  const n = ly.length, m = ay.length, P = 0.6 * rowh;
  let best: { cost: number; res: number[] } = { cost: Infinity, res: ly.map(() => -1) };
  const lim = Math.round(0.8 * rowh);
  for (let o = -lim; o <= lim; o += 2) {
    const D = new Float64Array((n + 1) * (m + 1)), B = new Int8Array((n + 1) * (m + 1));
    const I = (i: number, j: number) => i * (m + 1) + j;
    for (let i = 1; i <= n; i++) { D[I(i, 0)] = i * P; B[I(i, 0)] = 1; }
    for (let j = 1; j <= m; j++) { D[I(0, j)] = 0; B[I(0, j)] = 2; }
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
      const dist = Math.abs(ly[i - 1] - (ay[j - 1] + o));
      const a = dist < rowh ? D[I(i - 1, j - 1)] + dist : Infinity, b = D[I(i - 1, j)] + P, c = D[I(i, j - 1)];
      if (a <= b && a <= c) { D[I(i, j)] = a; B[I(i, j)] = 0; } else if (b <= c) { D[I(i, j)] = b; B[I(i, j)] = 1; } else { D[I(i, j)] = c; B[I(i, j)] = 2; }
    }
    const cost = D[I(n, m)] + Math.abs(o) * 0.05 * n;
    if (cost < best.cost) {
      const res = ly.map(() => -1); let i = n, j = m;
      while (i > 0 && j > 0) { const b = B[I(i, j)]; if (b === 0) { res[i - 1] = j - 1; i--; j--; } else if (b === 1) i--; else j--; }
      best = { cost, res };
    }
  }
  return best.res;
}

function wierszeTekstu(g: Gray): [number, number][] {
  const cnt = new Int32Array(g.h);
  for (let y = 0; y < g.h; y++) { let c = 0; for (let x = 0; x < g.w; x++) if (g.d[y * g.w + x] < 128) c++; cnt[y] = c; }
  const seg: [number, number, number][] = [];
  for (let y = 0; y < g.h;) {
    if (cnt[y] > 0) { let e = y, ink = 0; while (e < g.h && cnt[e] > 0) ink += cnt[e++]; seg.push([y, e, ink]); y = e; } else y++;
  }
  const scal: [number, number, number][] = [];
  for (const s of seg) { const p = scal[scal.length - 1]; if (p && s[0] - p[1] <= 3) { p[1] = s[1]; p[2] += s[2]; } else scal.push([...s]); }
  return scal.filter(s => s[1] - s[0] >= 8 && s[2] >= 25).map(s => [s[0], s[1]] as [number, number]);
}

function mediana(a: number[]) { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; }

function profil(g: Gray) {
  const p = new Float32Array(g.h);
  for (let y = 0; y < g.h; y++) { let s = 0; for (let x = 0; x < g.w; x++) s += g.d[y * g.w + x]; p[y] = s / g.w; }
  return p;
}
function przesuniecie(lpc: Kol, c: Kol, rowh: number, prior: number) {
  const pa = profil(lpc.hs), pb = profil(c.hs);
  prior = Math.round(prior);
  if (Math.max(...pa) <= 0.5 || Math.max(...pb) <= 0.5) return prior;
  const lim = Math.floor(0.2 * rowh); let best = prior, bv = -1;
  for (let sh = prior - lim; sh <= prior + lim; sh += 1) {
    let v = 0;
    for (let i = Math.max(0, -sh); i < pa.length - Math.max(0, sh); i++) v += pa[i] * pb[i + sh];
    if (v > bv) { bv = v; best = sh; }
  }
  return best;
}

async function laczone(c: Kol, ocr: OcrFn, ybot: number) {
  const ls = linieTekstu(await ocr(wytnij(c.strip, 0, ybot), { psm: 6, scale: 1.5 }));
  const an: Kotwica[] = [], nazwy = new Map<number, string>();
  if (ls.length < 2) return { an, nazwy };
  // lewy brzeg numerów Lp jako funkcja wysokości (kartka bywa wygięta)
  const numR = /^[^0-9A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ]*\d{1,3}\s*[.)|:]?\s*[A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
  const pk = ls.filter(l => numR.test(l.t));
  const xStart = (y: number) => {
    const bl = pk.map(l => ({ d: Math.abs(l.y - y), x: l.x })).sort((a, b) => a.d - b.d).slice(0, 5).map(v => v.x);
    return bl.length ? mediana(bl) : Math.min(...ls.map(l => l.x));
  };
  let akt = -1;
  for (const l of ls) {
    const poczatek = l.x < xStart(l.y) + 0.6 * l.h;
    const m = l.t.match(/^[^0-9A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ]*(\d{1,3})\s*[.)|:]?\s*(\S.*)$/);
    const p = an[an.length - 1];
    let n = -1, reszta = l.t;
    if (m && /^[A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(m[2]) && (!p || (Number(m[1]) > p.n && Number(m[1]) - p.n <= 3))) { n = Number(m[1]); reszta = m[2]; }
    else if (poczatek && p && /[A-ZĄĆĘŁŃÓŚŹŻ]{2}/.test(l.t)) {
      n = p.n + 1;
      reszta = l.t.replace(/^\d{1,3}\s+(?=\S)/, "").replace(/^[^A-ZĄĆĘŁŃÓŚŹŻ\s]{1,4}(?=[A-ZĄĆĘŁŃÓŚŹŻ])/, "").replace(/^\d(?=[A-ZĄĆĘŁŃÓŚŹŻ]{3})/, "");
    }
    if (n > 0) {
      reszta = reszta.replace(/^[|\]\[!]+/, "").replace(/^([a-ząćęłńóśźż])(?=[A-ZĄĆĘŁŃÓŚŹŻ]{2})/, x => x.toUpperCase());
      an.push({ n, y: l.y - l.h / 2, h: l.h }); akt = n; nazwy.set(n, reszta);
    } else if (akt >= 0 && !poczatek) nazwy.set(akt, nazwy.get(akt) + " " + l.t);
  }
  // tryb łączony tylko, gdy większość wierszy ma czytelny numer Lp
  if (pk.length < 3 || pk.length < 0.5 * an.length) return { an: [], nazwy: new Map<number, string>() };
  return { an, nazwy };
}

async function kotwice(c: Kol, ocr: OcrFn): Promise<Kotwica[]> {
  const an: Kotwica[] = [];
  for (const psm of [6, 11]) {
    for (const w of await ocr(c.strip, { psm, scale: 2, whitelist: "0123456789" })) {
      if (/^\d{1,3}$/.test(w.t) && w.conf > 20 && !an.some(a => Math.abs(a.y - w.y) < 15)) an.push({ n: Number(w.t), y: w.y, h: w.h });
    }
  }
  const seq: Kotwica[] = [];
  for (const a of an.sort((p, q) => p.y - q.y)) {
    const p = seq[seq.length - 1];
    if (!p || (a.n > p.n && a.n - p.n <= 3)) seq.push(a);
    else if (seq.length === 1 && a.n < p.n) seq.splice(0, 1, a);
  }
  return seq;
}

// wiersze wyznaczone poziomymi liniami w kolumnie Lp
async function pasma(c: Kol, ocr: OcrFn, ybot: number): Promise<Kotwica[]> {
  const pr = profil(c.hs), seps: [number, number][] = [];
  for (let i = 0; i < pr.length;) {
    if (pr[i] > 0.5) { let j = i; while (j < pr.length && pr[j] > 0.5) j++; seps.push([i, j]); i = j; } else i++;
  }
  const out: Kotwica[] = [];
  for (let s = 0; s + 1 < seps.length; s++) {
    const a1 = seps[s][1], b0 = seps[s + 1][0];
    if (b0 - a1 < 25) continue;
    const reg = wytnij(c.strip, a1, b0);
    let ws = (await ocr(reg, { psm: 6, scale: 2, whitelist: "0123456789" })).filter(w => /^\d{1,3}$/.test(w.t));
    if (!ws.length) ws = (await ocr(reg, { psm: 10, scale: 2, whitelist: "0123456789" })).filter(w => /^\d{1,3}$/.test(w.t));
    if (ws.length) { const w = ws.sort((p, q) => p.y - q.y)[0]; out.push({ n: Number(w.t), y: a1 + w.y, h: w.h, top: a1, bot: b0 }); }
  }
  // ostatni wiersz bez dolnej linii
  const last = seps.length ? seps[seps.length - 1][1] : 0;
  if (out.length && ybot - last > 40) {
    const ws = (await ocr(wytnij(c.strip, last, ybot), { psm: 6, scale: 2, whitelist: "0123456789" })).filter(w => /^\d{1,3}$/.test(w.t));
    if (ws.length) { const w = ws.sort((p, q) => p.y - q.y)[0]; out.push({ n: Number(w.t), y: last + w.y, h: w.h, top: last, bot: ybot - 4 }); }
  }
  const seq: Kotwica[] = [];
  for (const a of out) {
    const p = seq[seq.length - 1];
    if (!p || a.n === p.n + 1) seq.push(a);
    else if (seq.length <= 1) seq.splice(0, seq.length, a);
  }
  return seq;
}
