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

## Rozliczenie umowy (Excel)

Zakładka „Rozliczenie umowy (Excel)”:
1. Wczytaj Excel z formularzem cenowym. Potrzebne są kolumny: nazwa artykułu, cena jednostkowa netto i kolumny miesięcy.
2. Dodaj fakturę: PDF (tekstowy albo skan), zdjęcie JPG/PNG albo Word .docx.
3. Program szuka każdej pozycji faktury w umowie po nazwie i cenie netto. Ilość dopisuje w kolumnie miesiąca z daty wystawienia.
   Wpis niepewny (inna cena, podobna nazwa, cena wyliczona, przekroczona ilość z umowy) jest w Excelu zaznaczony na żółto, z notatką w komórce.
4. Faktura trafia do arkusza `_REJESTR_FAKTUR`. Przy próbie ponownego dodania program ostrzega.
5. „Pobierz uzupełniony Excel” zapisuje plik. Ostatni stan Excela jest też pamiętany w przeglądarce, na wypadek odświeżenia strony.
