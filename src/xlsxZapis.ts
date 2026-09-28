// Zapis zmian WPROST do oryginalnego pliku .xlsx (bez przepisywania całego skoroszytu).
// Zmieniane są tylko: wpisane komórki miesięcy, ich kolor (żółty), zapamiętane wyniki formuł
// i arkusz „_REJESTR_FAKTUR”. Formuły, formaty, szerokości, scalenia, wydruk – zostają jak były.

export type Wpis = { row: number; col: number; dodaj: number; zolty: boolean };
export type Rejestr = { naglowki: string[]; wiersz: (string | number | Date)[]; kolumnaDaty: number[] };

const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

export const kolLitery = (c: number) => { let s = ""; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
export const kolNumer = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const rozbij = (ref: string) => { const m = ref.match(/^\$?([A-Z]{1,3})\$?(\d+)$/)!; return { col: kolNumer(m[1]), row: Number(m[2]) }; };

function parsuj(xml: string): Document {
  const d = new DOMParser().parseFromString(xml.replace(/^﻿/, ""), "application/xml");
  if (d.getElementsByTagName("parsererror").length) throw new Error("Nie udało się odczytać struktury pliku Excel.");
  return d;
}
const zapiszXml = (d: Document) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + new XMLSerializer().serializeToString(d).replace(/^\s*<\?xml[^>]*\?>\s*/, "");
const dzieci = (el: Element, nazwa: string) => [...el.childNodes].filter((n): n is Element => n.nodeType === 1 && (n as Element).localName === nazwa);
const dziecko = (el: Element, nazwa: string) => dzieci(el, nazwa)[0] as Element | undefined;
const sciezka = (baza: string, cel: string) => {
  if (cel.startsWith("/")) return cel.slice(1);
  const cz = baza.split("/").slice(0, -1);
  for (const p of cel.split("/")) { if (p === "..") cz.pop(); else if (p !== ".") cz.push(p); }
  return cz.join("/");
};

// ---------------------------------------------------------------- formuły: przesuwanie i proste liczenie
/** Przesuwa względne odwołania formuły (formuły współdzielone w Excelu). */
function przesun(f: string, dr: number, dc: number) {
  return f.replace(/("[^"]*")|('[^']*'!)|(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(])/g, (all, str, sh, d1, col, d2, row) => {
    if (str || sh) return all;
    const c = d1 ? col : kolLitery(kolNumer(col) + dc);
    const r = d2 ? row : String(Number(row) + dr);
    return `${d1}${c}${d2}${r}`;
  });
}

type Wart = (ref: string) => number | null;
/** Liczy proste formuły: liczby, komórki, zakresy w SUMA/SUM, + - * /, nawiasy. Inne → null (Excel przeliczy sam). */
function licz(f: string, wart: Wart): number | null {
  const t = f.replace(/\$/g, "").replace(/\s+/g, "");
  let i = 0;
  const zakres = (a: string, b: string) => {
    const A = rozbij(a), B = rozbij(b); let s = 0;
    for (let r = Math.min(A.row, B.row); r <= Math.max(A.row, B.row); r++)
      for (let c = Math.min(A.col, B.col); c <= Math.max(A.col, B.col); c++) s += wart(kolLitery(c) + r) ?? 0; // tekst/puste w SUMA = 0
    return s;
  };
  const wyr = (): number => { let v = skl(); while (t[i] === "+" || t[i] === "-") { const o = t[i++]; const w = skl(); v = o === "+" ? v + w : v - w; } return v; };
  const skl = (): number => { let v = czyn(); while (t[i] === "*" || t[i] === "/") { const o = t[i++]; const w = czyn(); v = o === "*" ? v * w : v / w; } return v; };
  const czyn = (): number => {
    if (t[i] === "-") { i++; return -czyn(); }
    if (t[i] === "+") { i++; return czyn(); }
    if (t[i] === "(") { i++; const v = wyr(); if (t[i++] !== ")") throw 0; return v; }
    const fn = t.slice(i).match(/^(SUM|SUMA)\(/i);
    if (fn) {
      i += fn[0].length; let s = 0;
      for (;;) {
        const z = t.slice(i).match(/^([A-Z]{1,3}\d+):([A-Z]{1,3}\d+)/);
        if (z) { s += zakres(z[1], z[2]); i += z[0].length; } else s += wyr();
        if (t[i] === ";" || t[i] === ",") { i++; continue; }
        if (t[i++] !== ")") throw 0;
        return s;
      }
    }
    const num = t.slice(i).match(/^\d+(\.\d+)?/);
    if (num) { i += num[0].length; return Number(num[0]); }
    const ref = t.slice(i).match(/^[A-Z]{1,3}\d+/);
    if (ref) { i += ref[0].length; const v = wart(ref[0]); if (v === null) throw 0; return v; }
    throw 0;
  };
  try { const v = wyr(); return i === t.length && Number.isFinite(v) ? Math.round(v * 1e9) / 1e9 : null; } catch { return null; }
}

// ---------------------------------------------------------------- główna funkcja
export async function zapiszZmiany(dane: ArrayBuffer, nazwaArkusza: string, wpisy: Wpis[], rejestr: Rejestr | null): Promise<ArrayBuffer> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(dane);
  const czytaj = async (p: string) => { const f = zip.file(p); if (!f) throw new Error("Brak części pliku: " + p); return f.async("string"); };

  const wbPath = "xl/workbook.xml", wb = parsuj(await czytaj(wbPath));
  const relsPath = "xl/_rels/workbook.xml.rels", rels = parsuj(await czytaj(relsPath));
  const relEl = (id: string) => [...rels.getElementsByTagName("Relationship")].find(r => r.getAttribute("Id") === id);
  const arkusze = [...wb.getElementsByTagName("sheet")];
  const plikArkusza = (nazwa: string) => {
    const s = arkusze.find(a => a.getAttribute("name") === nazwa); if (!s) return null;
    const r = relEl(s.getAttributeNS(REL_NS, "id") || s.getAttribute("r:id") || "");
    return r ? sciezka(wbPath, r.getAttribute("Target")!) : null;
  };

  // teksty współdzielone (tylko do odczytu liczb zapisanych jako tekst)
  const ssRel = [...rels.getElementsByTagName("Relationship")].find(r => /sharedStrings$/.test(r.getAttribute("Type") || ""));
  const ss: string[] = [];
  if (ssRel) { const d = parsuj(await czytaj(sciezka(wbPath, ssRel.getAttribute("Target")!))); for (const si of d.getElementsByTagName("si")) ss.push([...si.getElementsByTagName("t")].map(t => t.textContent).join("")); }

  // style: żółte wypełnienie jako kopia stylu komórki
  const stRel = [...rels.getElementsByTagName("Relationship")].find(r => /\/styles$/.test(r.getAttribute("Type") || ""));
  const stPath = stRel ? sciezka(wbPath, stRel.getAttribute("Target")!) : null;
  const st = stPath ? parsuj(await czytaj(stPath)) : null;
  const zolteStyle = new Map<number, number>();
  const zolty = (s: number) => {
    if (!st) return s;
    if (zolteStyle.has(s)) return zolteStyle.get(s)!;
    const NS = st.documentElement.namespaceURI;
    const fills = st.getElementsByTagName("fills")[0], xfs = st.getElementsByTagName("cellXfs")[0];
    const fill = st.createElementNS(NS, "fill"), pf = st.createElementNS(NS, "patternFill"), fg = st.createElementNS(NS, "fgColor"), bg = st.createElementNS(NS, "bgColor");
    pf.setAttribute("patternType", "solid"); fg.setAttribute("rgb", "FFFFFF00"); bg.setAttribute("indexed", "64");
    pf.appendChild(fg); pf.appendChild(bg); fill.appendChild(pf); fills.appendChild(fill);
    const fillId = dzieci(fills, "fill").length - 1; fills.setAttribute("count", String(fillId + 1));
    const baza = dzieci(xfs, "xf")[s] || dzieci(xfs, "xf")[0];
    const xf = baza.cloneNode(true) as Element; xf.setAttribute("fillId", String(fillId)); xf.setAttribute("applyFill", "1");
    xfs.appendChild(xf);
    const id = dzieci(xfs, "xf").length - 1; xfs.setAttribute("count", String(id + 1));
    zolteStyle.set(s, id); return id;
  };

  // ------------------------------------------------ arkusz z umową
  const shPath = plikArkusza(nazwaArkusza); if (!shPath) throw new Error(`Nie znalazłem arkusza „${nazwaArkusza}” w pliku.`);
  const sh = parsuj(await czytaj(shPath)), NS = sh.documentElement.namespaceURI;
  const sheetData = sh.getElementsByTagName("sheetData")[0];
  const wiersze = new Map<number, Element>(), komorki = new Map<string, Element>();
  for (const r of dzieci(sheetData, "row")) { wiersze.set(Number(r.getAttribute("r")), r); for (const c of dzieci(r, "c")) komorki.set(c.getAttribute("r")!, c); }

  const wiersz = (nr: number) => {
    let r = wiersze.get(nr); if (r) return r;
    r = sh.createElementNS(NS, "row"); r.setAttribute("r", String(nr));
    const nast = dzieci(sheetData, "row").find(x => Number(x.getAttribute("r")) > nr);
    sheetData.insertBefore(r, nast || null); wiersze.set(nr, r); return r;
  };
  const komorka = (row: number, col: number) => {
    const ref = kolLitery(col) + row; let c = komorki.get(ref); if (c) return c;
    const r = wiersz(row); c = sh.createElementNS(NS, "c"); c.setAttribute("r", ref);
    const nast = dzieci(r, "c").find(x => rozbij(x.getAttribute("r")!).col > col);
    r.insertBefore(c, nast || null); komorki.set(ref, c);
    // styl wiersza/kolumny, żeby nowa komórka wyglądała jak sąsiednie (ramki)
    const sasiad = dzieci(r, "c").filter(x => x !== c && x.getAttribute("s")).sort((a, b) => Math.abs(rozbij(a.getAttribute("r")!).col - col) - Math.abs(rozbij(b.getAttribute("r")!).col - col))[0];
    if (sasiad && !c.getAttribute("s")) c.setAttribute("s", sasiad.getAttribute("s")!);
    return c;
  };

  // formuły współdzielone: tekst formuły dla dowolnej komórki
  const wzorce = new Map<string, { f: string; row: number; col: number }>();
  for (const [ref, c] of komorki) { const f = dziecko(c, "f"); if (f && f.getAttribute("t") === "shared" && f.textContent && f.getAttribute("ref")) { const p = rozbij(ref); wzorce.set(f.getAttribute("si")!, { f: f.textContent, ...p }); } }
  const formula = (c: Element): string | null => {
    const f = dziecko(c, "f"); if (!f) return null;
    if (f.textContent) return f.textContent;
    const w = f.getAttribute("t") === "shared" ? wzorce.get(f.getAttribute("si") || "") : undefined;
    if (!w) return null;
    const p = rozbij(c.getAttribute("r")!); return przesun(w.f, p.row - w.row, p.col - w.col);
  };
  /** Zamienia wszystkie komórki danej grupy współdzielonej na zwykłe formuły (żeby można było zmienić jedną). */
  const rozdziel = (si: string) => {
    for (const c of komorki.values()) {
      const f = dziecko(c, "f"); if (!f || f.getAttribute("t") !== "shared" || f.getAttribute("si") !== si) continue;
      const tx = formula(c); if (tx === null) continue;
      f.removeAttribute("t"); f.removeAttribute("si"); f.removeAttribute("ref"); f.textContent = tx;
    }
  };
  const liczba = (c: Element | undefined): number | null => {
    if (!c) return null;
    const v = dziecko(c, "v")?.textContent ?? (c.getAttribute("t") === "inlineStr" ? c.textContent : null);
    if (v === null || v === undefined || v === "") return null;
    const typ = c.getAttribute("t");
    const txt = typ === "s" ? ss[Number(v)] ?? "" : v;
    if (typ === "s" || typ === "str" || typ === "inlineStr") { const n = txt.replace(/\s/g, "").replace(",", "."); return /^-?\d+(\.\d+)?$/.test(n) ? Number(n) : null; }
    if (typ === "b" || typ === "e") return null;
    return Number(v);
  };
  const ustawV = (c: Element, n: number) => {
    let v = dziecko(c, "v");
    if (!v) { v = sh.createElementNS(NS, "v"); c.appendChild(v); }
    v.textContent = String(n);
    const t = c.getAttribute("t"); if (t && t !== "n") c.removeAttribute("t");
    const is = dziecko(c, "is"); if (is) c.removeChild(is);
  };

  // 1) dopisanie ilości (sumujemy z tym, co już jest; formuła w komórce zostaje, dopisujemy „+ilość”)
  const suma = new Map<string, Wpis>();
  for (const w of wpisy) {
    const k = w.row + ":" + w.col, b = suma.get(k);
    if (b) { b.dodaj += w.dodaj; b.zolty ||= w.zolty; } else suma.set(k, { ...w });
  }
  for (const w of suma.values()) {
    const c = komorka(w.row, w.col);
    const f = dziecko(c, "f");
    const bylo = liczba(c) ?? 0, nowe = Math.round((bylo + w.dodaj) * 1e6) / 1e6;
    if (f) {
      if (f.getAttribute("t") === "shared") rozdziel(f.getAttribute("si") || "");
      const tx = formula(c) ?? "";
      f.textContent = (tx ? tx + "+" : "") + String(w.dodaj);
    }
    ustawV(c, nowe);
    if (w.zolty) c.setAttribute("s", String(zolty(Number(c.getAttribute("s") || 0))));
  }

  // 2) zapamiętane wyniki formuł (RAZEM, ilość do wydania…) – żeby plik pokazywał dobre liczby od razu
  const wartosc: Wart = ref => liczba(komorki.get(ref));
  for (let przebieg = 0; przebieg < 3; przebieg++) {
    let zmiana = false;
    for (const c of komorki.values()) {
      const tx = formula(c); if (tx === null) continue;
      const v = licz(tx, wartosc);
      if (v === null) continue;
      const stare = liczba(c);
      if (stare !== v) { ustawV(c, v); zmiana = true; }
    }
    if (!zmiana) break;
  }
  zip.file(shPath, zapiszXml(sh));

  // 3) rejestr faktur
  if (rejestr) await dopiszRejestr(zip, wb, rels, wbPath, relsPath, plikArkusza, rejestr);

  // 4) Excel przeliczy wszystko przy otwarciu (na wszelki wypadek)
  const WNS = wb.documentElement.namespaceURI;
  let calc = wb.getElementsByTagName("calcPr")[0];
  if (!calc) { calc = wb.createElementNS(WNS, "calcPr"); const po = wb.getElementsByTagName("sheets")[0]; po.parentNode!.insertBefore(calc, po.nextSibling); }
  calc.setAttribute("fullCalcOnLoad", "1");
  zip.file(wbPath, zapiszXml(wb));
  zip.file(relsPath, zapiszXml(rels));
  if (st && stPath) zip.file(stPath, zapiszXml(st));
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

// ---------------------------------------------------------------- arkusz _REJESTR_FAKTUR
// daty faktur są zapisane jako północ UTC (sam dzień), „data dodania” – czas lokalny
const excelData = (d: Date) => {
  const utc = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
  const t = utc ? d.getTime() : Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  return (t - Date.UTC(1899, 11, 30)) / 86400000;
};

async function dopiszRejestr(zip: import("jszip"), wb: Document, rels: Document, wbPath: string, relsPath: string, plikArkusza: (n: string) => string | null, rj: Rejestr) {
  const NAZWA = "_REJESTR_FAKTUR";
  let path = plikArkusza(NAZWA);
  if (!path) {
    // nowy ukryty arkusz
    let n = 1; while (zip.file(`xl/worksheets/sheet${n}.xml`)) n++;
    path = `xl/worksheets/sheet${n}.xml`;
    zip.file(path, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`);
    const ids = [...rels.getElementsByTagName("Relationship")].map(r => Number((r.getAttribute("Id") || "").replace(/\D/g, "")) || 0);
    const rid = "rId" + (Math.max(0, ...ids) + 1);
    const r = rels.createElementNS(PKG_REL, "Relationship");
    r.setAttribute("Id", rid); r.setAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"); r.setAttribute("Target", `worksheets/sheet${n}.xml`);
    rels.documentElement.appendChild(r);
    const sheets = wb.getElementsByTagName("sheets")[0];
    const sid = Math.max(0, ...[...wb.getElementsByTagName("sheet")].map(s => Number(s.getAttribute("sheetId")) || 0)) + 1;
    const s = wb.createElementNS(wb.documentElement.namespaceURI, "sheet");
    s.setAttribute("name", NAZWA); s.setAttribute("sheetId", String(sid)); s.setAttribute("state", "hidden"); s.setAttributeNS(REL_NS, "r:id", rid);
    sheets.appendChild(s);
    const ctPath = "[Content_Types].xml", ct = parsuj(await zip.file(ctPath)!.async("string"));
    const o = ct.createElementNS(ct.documentElement.namespaceURI, "Override");
    o.setAttribute("PartName", "/" + path); o.setAttribute("ContentType", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml");
    ct.documentElement.appendChild(o); zip.file(ctPath, zapiszXml(ct));
  }
  const sh = parsuj(await zip.file(path)!.async("string")), NS = sh.documentElement.namespaceURI;
  const sd = sh.getElementsByTagName("sheetData")[0];
  const rows = dzieci(sd, "row");
  const ost = rows.length ? Math.max(...rows.map(r => Number(r.getAttribute("r")))) : 0;
  const poprzedni = rows.find(r => Number(r.getAttribute("r")) === ost);
  const dodajWiersz = (nr: number, wart: (string | number | Date)[]) => {
    const r = sh.createElementNS(NS, "row"); r.setAttribute("r", String(nr));
    wart.forEach((v0, i) => {
      let v = v0;
      const c = sh.createElementNS(NS, "c"), ref = kolLitery(i + 1) + nr; c.setAttribute("r", ref);
      const wzor = poprzedni && nr > 1 ? dzieci(poprzedni, "c").find(x => rozbij(x.getAttribute("r")!).col === i + 1) : undefined;
      if (wzor?.getAttribute("s")) c.setAttribute("s", wzor.getAttribute("s")!);
      if (v instanceof Date && !c.getAttribute("s")) v = v.toLocaleDateString("pl-PL"); // bez stylu daty – czytelny tekst
      if (v instanceof Date || typeof v === "number") {
        const el = sh.createElementNS(NS, "v"); el.textContent = String(v instanceof Date ? excelData(v) : v); c.appendChild(el);
      } else {
        c.setAttribute("t", "inlineStr");
        const is = sh.createElementNS(NS, "is"), t = sh.createElementNS(NS, "t"); t.textContent = String(v); t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
        is.appendChild(t); c.appendChild(is);
      }
      r.appendChild(c);
    });
    sd.appendChild(r);
  };
  if (!ost) dodajWiersz(1, rj.naglowki);
  dodajWiersz((ost || 1) + 1, rj.wiersz);
  const dim = sh.getElementsByTagName("dimension")[0];
  if (dim) dim.setAttribute("ref", `A1:${kolLitery(Math.max(rj.naglowki.length, rj.wiersz.length))}${(ost || 1) + 1}`);
  zip.file(path, zapiszXml(sh));
}
