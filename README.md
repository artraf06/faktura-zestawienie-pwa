# Faktura → Zestawienie

PWA odczytuje pozycje towarowe z faktur JPG/PDF i tworzy zestawienie PDF z kolumnami: Lp., nazwa towaru lub usługi, ilość, Jedn.m. Pozostałe kolumny faktury, w tym PKWiU, ceny, VAT i wartości, są pomijane.

## Uruchomienie

```bash
npm install
npm run dev
```

## Netlify

Połącz repozytorium GitHub w Netlify. Ustawienia wdrożenia są już zapisane w `netlify.toml`.

## Jak działa odczyt (bez AI)

Wszystko dzieje się w przeglądarce — dokument nigdzie nie jest wysyłany, nie jest potrzebny żaden klucz API.

1. **PDF z tekstem** (np. faktury z e-sklepów) – kolumny wyznaczane są z położenia nagłówków (Lp, Nazwa, Ilość, J.m.), bez OCR.
2. **Zdjęcie / skan z tabelą** (`src/tableOcr.ts`) – prostowanie zdjęcia, wykrycie linii tabeli, rozpoznanie kolumn po nagłówkach, wiersze wg numerów Lp, OCR (tesseract.js) każdej kolumny osobno. Ilość jest sprawdzana jako *wartość ÷ cena*, gdy te kolumny są czytelne.
3. **Tabela bez linii** – kolumny szukane po położeniu nagłówków w tekście z OCR.
4. Ostatecznie – dawny odczyt całego tekstu.

Wiersze z wątpliwościami (nieczytelna ilość/jednostka/nazwa) są zaznaczone na żółto; najechanie pokazuje powód. Dane należy sprawdzić przed eksportem.
