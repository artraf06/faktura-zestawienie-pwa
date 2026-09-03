# Faktura → Zestawienie

PWA odczytuje pozycje towarowe z faktur JPG/PDF i tworzy zestawienie PDF z kolumnami: Lp., nazwa towaru lub usługi, ilość, Jedn.m. Pozostałe kolumny faktury, w tym PKWiU, ceny, VAT i wartości, są pomijane.

## Uruchomienie

```bash
npm install
npm run dev
```

## Netlify

Połącz repozytorium GitHub w Netlify. Ustawienia wdrożenia są już zapisane w `netlify.toml`.

OCR działa w przeglądarce. Dokument nie jest wysyłany do własnego serwera aplikacji. Dane należy sprawdzić przed eksportem.
