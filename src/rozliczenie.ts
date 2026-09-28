// Rozliczenie umowy: Excel z formularzem cenowym (pozycje + kolumny miesięcy) ← pozycje z faktur.
// Dopasowanie po nazwie i cenie netto. Niepewne wpisy są zaznaczane na żółto z notatką.
import type ExcelJS from "exceljs";
import type { Pozycja } from "./tableOcr";

export type WierszUmowy = { row: number; lp: string; nazwa: string; opis: string; jm: string; ilosc: number | null; cena: number | null; wykorzystano: number };
export type Miesiac = { col: number; rok: number; mies: number; etykieta: string };
export type Umowa = { wb: ExcelJS.Workbook; arkusz: ExcelJS.Worksheet; wiersze: WierszUmowy[]; miesiace: Miesiac[]; nazwaPliku: string; kolNazwa: number; kolCena: number; kolLp: number; wNaglowek: number };
export type Propozycja = { wiersz: WierszUmowy; punkty: number; nazwaPkt: number; cenaZgodna: boolean };
export type Przypisanie = { poz: Pozycja; ilosc: number; row: number | null; col: number | null; pewne: boolean; powod: string; kandydaci: Propozycja[]; wlacz: boolean };

const MIES = ["styczen", "luty", "marzec", "kwiecien", "maj", "czerwiec", "lipiec", "sierpien", "wrzesien", "pazdziernik", "listopad", "grudzien"];
const MIES_PL = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
const PL: Record<string, string> = { ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z" };
export const norm = (t: unknown) => String(t ?? "").toLowerCase().replace(/[ąćęłńóśźż]/g, c => PL[c]).replace(/[^a-z0-9]+/g, " ").trim();

/** Wartość komórki jako tekst (także formuły, tekst sformatowany). */
export function tekstKomorki(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map(r => r.text).join("");
    if ("result" in v) return String(v.result ?? "");
    if ("text" in v) return String(v.text);
    if (v instanceof Date) return v.toISOString();
  }
  return String(v);
}
export function liczba(v: ExcelJS.CellValue): number | null {
  const t = tekstKomorki(v).replace(/\s/g, "").replace(",", ".");
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

export async function wczytajUmowe(dane: ArrayBuffer, nazwaPliku: string): Promise<Umowa> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(dane);
  for (const ws of wb.worksheets) {
    if (ws.name.startsWith("_")) continue;
    for (let r = 1; r <= Math.min(ws.rowCount, 40); r++) {
      const row = ws.getRow(r);
      let kolNazwa = 0, kolCena = 0, kolLp = 0, kolOpis = 0, kolJm = 0, kolIlosc = 0;
      const miesiace: Miesiac[] = [];
      row.eachCell({ includeEmpty: false }, (c, col) => {
        const t = norm(tekstKomorki(c.value));
        if (!t) return;
        if (!kolNazwa && /^nazwa/.test(t)) kolNazwa = col;
        else if (!kolCena && /cena/.test(t) && /netto/.test(t)) kolCena = col;
        else if (!kolLp && /^l ?p$/.test(t)) kolLp = col;
        else if (!kolOpis && /^opis/.test(t)) kolOpis = col;
        else if (!kolJm && /jednostka|^j ?m$|miara/.test(t)) kolJm = col;
        else if (!kolIlosc && /^ilosc/.test(t)) kolIlosc = col;
        const m = MIES.findIndex(x => t.split(" ").includes(x));
        if (m >= 0) {
          const rok = t.match(/20\d\d/);
          miesiace.push({ col, rok: rok ? Number(rok[0]) : 0, mies: m + 1, etykieta: "" });
        }
      });
      if (!kolNazwa || miesiace.length < 2) continue;
      if (!kolCena) row.eachCell((c, col) => { if (!kolCena && /cena/.test(norm(tekstKomorki(c.value)))) kolCena = col; });
      // lata: z nagłówka albo kolejno (po grudniu następny rok)
      miesiace.sort((a, b) => a.col - b.col);
      let rok = miesiace.find(m => m.rok)?.rok || new Date().getFullYear();
      const iPierwszy = miesiace.findIndex(m => m.rok);
      if (iPierwszy > 0) for (let i = iPierwszy - 1; i >= 0; i--) miesiace[i].rok = miesiace[i].mies > miesiace[i + 1].mies ? miesiace[i + 1].rok - 1 : miesiace[i + 1].rok;
      for (let i = Math.max(0, iPierwszy); i < miesiace.length; i++) {
        if (miesiace[i].rok) rok = miesiace[i].rok;
        else { if (miesiace[i].mies < miesiace[i - 1].mies) rok++; miesiace[i].rok = rok; }
      }
      for (const m of miesiace) m.etykieta = `${MIES_PL[m.mies - 1]} ${m.rok}`;
      const wiersze: WierszUmowy[] = [];
      for (let rr = r + 1; rr <= ws.rowCount; rr++) {
        const w = ws.getRow(rr);
        const nazwa = tekstKomorki(w.getCell(kolNazwa).value).replace(/\s+/g, " ").trim();
        if (!nazwa || /^[a-z]$/i.test(nazwa)) continue; // wiersz z literami kolumn (A, B, C…)
        const cena = kolCena ? liczba(w.getCell(kolCena).value) : null;
        const wykorzystano = miesiace.reduce((s, m) => s + (liczba(w.getCell(m.col).value) || 0), 0);
        wiersze.push({ row: rr, lp: kolLp ? tekstKomorki(w.getCell(kolLp).value) : "", nazwa, opis: kolOpis ? tekstKomorki(w.getCell(kolOpis).value).replace(/\s+/g, " ").trim() : "",
          jm: kolJm ? tekstKomorki(w.getCell(kolJm).value).trim() : "", ilosc: kolIlosc ? liczba(w.getCell(kolIlosc).value) : null, cena, wykorzystano });
      }
      if (wiersze.length) return { wb, arkusz: ws, wiersze, miesiace, nazwaPliku, kolNazwa, kolCena, kolLp, wNaglowek: r };
    }
  }
  throw new Error("Nie znalazłem tabeli z nazwami towarów i kolumnami miesięcy (np. „nazwa artykułu”, „maj”, „czerwiec”).");
}

// ------------------------------------------------------------------ dopasowanie
const NIEWAZNE = new Set(["typ", "typu", "lub", "rownowazny", "rownowazne", "i", "z", "do", "w", "na", "od", "szt", "op", "opak", "kolor", "kolory",
  "rozne", "roznych", "the", "x", "mm", "cm", "vp", "sztuk", "kpl"]);
function tokeny(t: string) {
  return norm(t).split(" ").filter(x => x && !NIEWAZNE.has(x));
}
const waga = (t: string) => (/\d/.test(t) ? 2 : t.length >= 4 ? 1 : 0.5);
function podobne(a: string, b: string) {
  if (a === b) return 1;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b.slice(0, 5)) || b.startsWith(a.slice(0, 5)))) return 0.8;
  if (/\d/.test(a) && a.replace(/\D/g, "") === b.replace(/\D/g, "") && a.replace(/\D/g, "").length >= 2) return 0.7;
  return 0;
}
/** Ile z ważnych słów nazwy z faktury jest w nazwie/opisie pozycji umowy (0–1). */
export function podobienstwo(faktura: string, umowa: string, opis = ""): number {
  const tf = tokeny(faktura), tu = tokeny(umowa + " " + opis);
  if (!tf.length || !tu.length) return 0;
  let suma = 0, trafione = 0;
  for (const t of tf) {
    const w = waga(t);
    suma += w;
    trafione += w * Math.max(0, ...tu.map(u => podobne(t, u)));
  }
  // bonus: pierwsze słowo nazwy z umowy (rodzaj towaru) występuje na fakturze
  const glowne = tokeny(umowa)[0];
  const bonus = glowne && tf.some(t => podobne(t, glowne) >= 0.8) ? 0.15 : 0;
  return Math.min(1, trafione / suma + bonus);
}

export function propozycje(poz: Pozycja, umowa: Umowa): Propozycja[] {
  const cena = poz.cenaNetto;
  return umowa.wiersze.map(w => {
    const nazwaPkt = podobienstwo(poz.name, w.nazwa, w.opis);
    const cenaZgodna = cena !== undefined && w.cena !== null && Math.abs(cena - w.cena) <= 0.011;
    const cenaBlisko = cena !== undefined && w.cena !== null && Math.abs(cena - w.cena) <= Math.max(0.05, w.cena * 0.03);
    return { wiersz: w, nazwaPkt, cenaZgodna, punkty: nazwaPkt + (cenaZgodna ? 0.45 : cenaBlisko ? 0.2 : 0) };
  }).filter(p => p.punkty > 0.15).sort((a, b) => b.punkty - a.punkty).slice(0, 12);
}

export function miesiacDla(data: Date | null, umowa: Umowa): Miesiac | null {
  if (!data) return null;
  return umowa.miesiace.find(m => m.rok === data.getUTCFullYear() && m.mies === data.getUTCMonth() + 1) || null;
}

export function przypisz(pozycje: Pozycja[], umowa: Umowa, data: Date | null): Przypisanie[] {
  const m = miesiacDla(data, umowa);
  return pozycje.map(poz => {
    let kand = propozycje(poz, umowa);
    const ilosc = Number(String(poz.quantity).replace(",", ".")) || 0;
    const [a, b] = kand;
    let pewne = false, powod = "", row: number | null = null;
    if (a && a.punkty >= 0.45 && a.nazwaPkt >= 0.3) {
      // 1) dopasowanie po nazwie (cena jako potwierdzenie)
      row = a.wiersz.row;
      if (!a.cenaZgodna) powod = poz.cenaNetto === undefined ? "Brak ceny netto na fakturze – sprawdź pozycję"
        : `Cena netto z faktury ${zl(poz.cenaNetto)} ≠ w umowie ${a.wiersz.cena === null ? "brak" : zl(a.wiersz.cena)}`;
      else if (a.nazwaPkt < 0.4) powod = "Cena się zgadza, ale nazwa podobna tylko częściowo";
      else if (b && b.cenaZgodna && a.punkty - b.punkty < 0.12) powod = `Dwie podobne pozycje (Lp. ${a.wiersz.lp} i ${b.wiersz.lp}) – sprawdź`;
      else pewne = true;
    } else if (poz.cenaNetto !== undefined) {
      // 2) nazwa nie pasuje → ostatnia szansa: ta sama cena netto co w umowie
      const tol = poz.cenaWyliczona ? 0.021 : 0.011;
      const poCenie = umowa.wiersze.filter(w => w.cena !== null && Math.abs(w.cena - poz.cenaNetto!) <= tol)
        .map(w => ({ wiersz: w, nazwaPkt: podobienstwo(poz.name, w.nazwa, w.opis), cenaZgodna: true, punkty: 0 }))
        .map(k => ({ ...k, punkty: k.nazwaPkt + 0.45 })).sort((x, y) => y.punkty - x.punkty);
      if (poCenie.length) {
        row = poCenie[0].wiersz.row;
        powod = poCenie.length === 1
          ? `Nazwa nie pasuje – dopasowano po cenie netto ${zl(poz.cenaNetto)} (Lp. ${poCenie[0].wiersz.lp})`
          : `Nazwa nie pasuje – cenę ${zl(poz.cenaNetto)} ma ${poCenie.length} pozycji (Lp. ${poCenie.slice(0, 5).map(k => k.wiersz.lp).join(", ")}${poCenie.length > 5 ? "…" : ""}) – wybierz właściwą`;
        // kandydaci z tą ceną na górze listy
        kand = [...poCenie.slice(0, 12), ...kand.filter(k => !poCenie.some(c => c.wiersz.row === k.wiersz.row))].slice(0, 15);
      } else powod = "Nie znalazłem tej pozycji w umowie (ani po nazwie, ani po cenie) – wybierz ręcznie";
    } else powod = "Nie znalazłem tej pozycji w umowie, a na fakturze brak ceny netto – wybierz ręcznie";
    if (pewne && poz.cenaWyliczona) { pewne = false; powod = "Cena netto wyliczona z wartości / brutto – sprawdź"; }
    if (pewne && poz.uwaga) { pewne = false; powod = `Odczyt faktury: ${poz.uwaga.toLowerCase()}`; }
    if (!m) powod = powod || "Data faktury poza okresem umowy – wybierz miesiąc";
    return { poz, ilosc, row, col: m?.col ?? null, pewne: pewne && !!m, powod, kandydaci: kand, wlacz: row !== null };
  });
}

export const zl = (v: number) => v.toFixed(2).replace(".", ",") + " zł";

// ------------------------------------------------------------------ faktura: numer i data
export function numerIData(tekst: string): { numer: string; data: Date | null } {
  // PDF dzieli „10-07-2026” / „FS-415581” na kawałki ze spacjami – sklejamy
  const t = tekst.replace(/\r/g, "").replace(/([A-Za-z0-9])([-./])[ \t]+(?=[A-Za-z0-9])/g, "$1$2");
  let numer = "";
  const m = t.match(/faktura(?:\s+vat)?(?:\s+(?:nr|numer|no\.?))?[\s:.]*([A-Z]{1,5}[\s/-]?\d[\w/.-]{2,30}|\d[\w/.-]{3,30})/i)
    || t.match(/\b(F[SV][\s/-]?\d+\/[\w/.-]+)/i);
  if (m) numer = m[1].trim();
  const daty: { d: Date; i: number }[] = [];
  const re = /(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d\d)|(20\d\d)-(\d{2})-(\d{2})/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(t))) {
    const d = x[1] ? new Date(Date.UTC(+x[3], +x[2] - 1, +x[1])) : new Date(Date.UTC(+x[4], +x[5] - 1, +x[6]));
    if (!isNaN(+d) && d.getUTCMonth() === (x[1] ? +x[2] - 1 : +x[5] - 1)) daty.push({ d, i: x.index });
  }
  // data wystawienia: najpierw w tej samej linii co „wystawienia”, potem pierwsza data za tym słowem
  const low = t.toLowerCase();
  const iWyst = low.search(/wystawienia|data faktury|data wyst/);
  let po = undefined as { d: Date; i: number } | undefined;
  if (iWyst >= 0) {
    const koniecLinii = low.indexOf("\n", iWyst) < 0 ? low.length : low.indexOf("\n", iWyst);
    po = daty.find(d => d.i > iWyst && d.i < koniecLinii) || daty.filter(d => d.i > iWyst).sort((a, b) => a.i - b.i)[0];
  }
  return { numer, data: (po || daty[0])?.d ?? null };
}

// ------------------------------------------------------------------ zapis do Excela
const ZOLTY = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } } as const;

export type Faktura = { numer: string; data: Date | null; plik: string; klucz: string };

export function rejestr(umowa: Umowa): { klucz: string; numer: string; plik: string }[] {
  const ws = umowa.wb.getWorksheet("_REJESTR_FAKTUR");
  if (!ws) return [];
  const out: { klucz: string; numer: string; plik: string }[] = [];
  ws.eachRow((r, i) => { if (i > 1) out.push({ klucz: tekstKomorki(r.getCell(1).value), numer: tekstKomorki(r.getCell(2).value), plik: tekstKomorki(r.getCell(4).value) }); });
  return out;
}

/** Czy ta faktura jest już w rejestrze (ten sam plik, klucz albo numer)? */
export function juzDodana(umowa: Umowa, f: Faktura): string | null {
  const nr = norm(f.numer);
  for (const r of rejestr(umowa)) {
    if (r.klucz === f.klucz) return `Ten sam plik był już dodany (${r.plik || r.numer}).`;
    if (nr && nr.length >= 5 && norm(r.numer).includes(nr)) return `Faktura ${f.numer} jest już w rejestrze (plik ${r.plik}).`;
    if (f.plik && r.plik && r.plik.toLowerCase() === f.plik.toLowerCase()) return `Plik o nazwie ${f.plik} jest już w rejestrze – sprawdź, czy to nie ta sama faktura.`;
  }
  return null;
}

export function wpisz(umowa: Umowa, lista: Przypisanie[], f: Faktura): { wpisano: number; zolte: number } {
  const ws = umowa.arkusz;
  let wpisano = 0, zolte = 0;
  const opisy: string[] = [];
  const ref = [f.numer || "faktura bez numeru", f.plik].filter(Boolean).join(", ");
  for (const p of lista) {
    if (!p.wlacz || !p.row || !p.col || !p.ilosc) continue;
    const c = ws.getRow(p.row).getCell(p.col);
    const bylo = liczba(c.value) || 0;
    c.value = bylo + p.ilosc;
    const cenaTxt = p.poz.cenaNetto !== undefined ? `, cena netto ${zl(p.poz.cenaNetto)}` : "";
    const notka = `${ref}: +${String(p.ilosc).replace(".", ",")} (${p.poz.name}${cenaTxt})` + (p.pewne ? "" : `\nDO SPRAWDZENIA: ${p.powod}`);
    const stara = c.note ? (typeof c.note === "string" ? c.note : c.note.texts?.map(t => t.text).join("") ?? "") : "";
    c.note = (stara ? stara + "\n" : "") + notka;
    // styl kopiujemy: ExcelJS współdzieli obiekt stylu między komórkami (bez kopii zażółciłby cały wiersz)
    if (!p.pewne) { c.style = { ...c.style, fill: ZOLTY as unknown as ExcelJS.Fill }; zolte++; }
    wpisano++;
    const w = umowa.wiersze.find(x => x.row === p.row);
    if (w) w.wykorzystano += p.ilosc;
    opisy.push(`Lp.${w?.lp ?? p.row}+${p.ilosc}`);
  }
  let rj = umowa.wb.getWorksheet("_REJESTR_FAKTUR");
  if (!rj) {
    rj = umowa.wb.addWorksheet("_REJESTR_FAKTUR");
    rj.addRow(["Klucz", "Numer faktury / KSeF", "Data wystawienia", "Plik źródłowy", "Identyfikatory pozycji", "Data dodania", "Liczba pozycji"]);
    rj.getRow(1).font = { bold: true };
  }
  rj.addRow([f.klucz, f.numer || "brak numeru", f.data ?? "", f.plik, opisy.join(";"), new Date(), wpisano]);
  umowa.wb.calcProperties.fullCalcOnLoad = true; // Excel przeliczy sumy (RAZEM, ilość do wydania) po otwarciu
  return { wpisano, zolte };
}

export async function doPliku(umowa: Umowa): Promise<Blob> {
  const buf = await umowa.wb.xlsx.writeBuffer();
  return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export async function skrot(dane: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", dane);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
