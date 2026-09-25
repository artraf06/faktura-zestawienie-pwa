// Odczyt pozycji z PDF z warstwą tekstową (bez OCR i bez AI):
// kolumny wyznaczane są z położenia nagłówków (Lp, Nazwa, Ilość, J.m. …).
import type { Pozycja } from "./tableOcr";

export type PdfItem = { str: string; x: number; y: number; w: number };
type Kolumny = { lpX: number; nazwaX: number; nazwaKoniec: number; ilosc: [number, number]; jm: [number, number] | null };

const JEDN = /^(szt|kpl|mb|m2|m3|m²|m³|kg|g|l|ml|op|opak|usł|usl|godz|h|para|pary|rolka|ryza|m|t|km|kompl)\.?,?$/i;
const KONIEC = /^(razem|podsumowanie|suma|do\s+zapłaty|ogółem|stawka|w\s+tym)/i;

function linie(items: PdfItem[], tol = 2.5) {
  const out: { y: number; items: PdfItem[] }[] = [];
  for (const it of [...items].filter(i => i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x)) {
    const l = out.find(l => Math.abs(l.y - it.y) <= tol);
    if (l) l.items.push(it); else out.push({ y: it.y, items: [it] });
  }
  for (const l of out) l.items.sort((a, b) => a.x - b.x);
  return out.sort((a, b) => b.y - a.y);
}

function naglowek(items: PdfItem[], sk = 1): { k: Kolumny; y: number } | null {
  const nazwa = items.find(i => /^nazwa/i.test(i.str.trim()));
  if (!nazwa) return null;
  const blisko = items.filter(i => Math.abs(i.y - nazwa.y) <= 16 * sk);
  const znajdz = (re: RegExp) => blisko.filter(i => re.test(i.str.trim()));
  const ilosc = znajdz(/^ilo[śs][ćc]\.?$|^il\.?$/i)[0];
  if (!ilosc) return null;
  const lp = znajdz(/^l\.?\s?p\.?$/i)[0];
  const cena = znajdz(/^cena/i);
  const jm = znajdz(/^j\.?\s?m\.?$|^jedn\.?\s?m|^jednostka|^miara$|^jedn\.?$/i).filter(i => !cena.some(c => Math.abs(c.x - i.x) < 25 * sk))[0];
  // następna kolumna po nazwie = najbliższy w prawo nagłówek innego typu
  const inne = blisko.filter(i => i.x > nazwa.x + nazwa.w && !/^(towar|towaru|lub|usług|usługi|nazwa|\/|i|opis)/i.test(i.str.trim()));
  const nazwaKoniec = inne.length ? Math.min(...inne.map(i => i.x)) - 3 : ilosc.x - 3;
  const srodek = (i: PdfItem) => i.x + i.w / 2;
  const zakres = (i: PdfItem): [number, number] => [i.x - 25 * sk, i.x + i.w + 25 * sk];
  return {
    y: Math.min(...blisko.map(i => i.y)),
    k: { lpX: lp ? srodek(lp) : -1, nazwaX: nazwa.x, nazwaKoniec, ilosc: zakres(ilosc), jm: jm ? zakres(jm) : null },
  };
}

const liczba = (s: string) => /^\d+(?:[  ]?\d{3})*(?:[,.]\d+)?$/.test(s.trim());

export function pozycjeZPdf(strony: PdfItem[][], sk = 1): Pozycja[] {
  const wynik: Pozycja[] = [];
  let kol: Kolumny | null = null;
  for (const wszystkie of strony) {
    const items = wszystkie.filter(i => i.str.trim());
    const nag = naglowek(items, sk);
    if (nag) kol = nag.k;
    if (!kol) continue;
    let w = false;
    for (const l of linie(items, 2.5 * sk)) {
      if (nag && l.y >= nag.y - sk) continue;
      const tekst = l.items.map(i => i.str).join(" ").trim();
      const pierwszy = l.items[0];
      const jestLp = /^\d{1,3}\.?$/.test(pierwszy.str.trim()) && pierwszy.x < kol.nazwaX + 5 && (kol.lpX < 0 || Math.abs(pierwszy.x + pierwszy.w / 2 - kol.lpX) < 40 * sk);
      if (!jestLp && KONIEC.test(tekst) && wynik.length) { w = true; break; }
      if (w) break;
      const wZakresie = (i: PdfItem, z: [number, number]) => i.x + i.w / 2 >= z[0] && i.x + i.w / 2 <= z[1];
      // ilość i jednostka mogą być jednym napisem („5 szt”)
      let qty = "", unit = "";
      for (const i of l.items.filter(i => i.x >= kol!.nazwaKoniec - 2)) {
        const s = i.str.trim();
        const razem = s.match(/^(\d+(?:[,.]\d+)?)\s*([a-ząćęłńóśźż²³.]+)$/i);
        if (!qty && wZakresie(i, kol.ilosc) && liczba(s)) qty = s;
        else if (!qty && razem && JEDN.test(razem[2]) && wZakresie(i, kol.ilosc)) { qty = razem[1]; unit = razem[2]; }
        else if (!unit && JEDN.test(s) && (kol.jm ? wZakresie(i, kol.jm) : i.x > kol.ilosc[0])) unit = s;
      }
      const nazwa = l.items.filter((i, idx) => !(jestLp && idx === 0) && i.x < kol!.nazwaKoniec && i.x >= kol!.nazwaX - 120 * sk).map(i => i.str).join(" ").replace(/\s+/g, " ").trim();
      if (jestLp) {
        wynik.push({ lp: Number(pierwszy.str.replace(".", "")), name: nazwa, quantity: qty.replace(".", ","), unit: unit.replace(/,$/, "") });
      } else if (wynik.length && nazwa && !qty) {
        const p = wynik[wynik.length - 1];
        p.name = (p.name + " " + nazwa).trim();
      } else if (wynik.length && qty && !wynik[wynik.length - 1].quantity) {
        const p = wynik[wynik.length - 1];
        p.quantity = qty.replace(".", ","); if (!p.unit) p.unit = unit;
        if (nazwa) p.name = (p.name + " " + nazwa).trim();
      } else if (qty && nazwa && /[a-ząćęłńóśźż]{3}/i.test(nazwa) && !KONIEC.test(nazwa)) {
        // nieczytelny numer Lp, ale jest nazwa i ilość → nowa pozycja
        wynik.push({ lp: (wynik[wynik.length - 1]?.lp || 0) + 1, name: nazwa.replace(/^\S{1,3}\s+(?=\S{3})/, m => (/\d|[a-z]{1,2}\b/i.test(m) && m.trim().length <= 2 ? "" : m)), quantity: qty.replace(".", ","), unit: unit.replace(/,$/, "") });
      }
    }
  }
  return wynik.map(p => ({ ...p, uwaga: !p.quantity ? "Sprawdź ilość" : !p.unit ? "Sprawdź jednostkę" : !p.name ? "Nie odczytano nazwy" : undefined }));
}

// zdjęcie/skan bez linii tabeli: słowa z OCR (współrzędne w pikselach) → ten sam parser kolumn
export function pozycjeZeSlow(slowa: { t: string; x: number; y: number; w: number; h: number }[], szerokosc: number): Pozycja[] {
  const sk = szerokosc / 595; // piksele na punkt strony A4
  const items = slowa.map(s => ({ str: s.t, x: s.x, y: -(s.y + s.h / 2), w: s.w }));
  return pozycjeZPdf([items], sk).map(p => ({ ...p, uwaga: p.uwaga || "Odczyt bez linii tabeli — sprawdź" }));
}
