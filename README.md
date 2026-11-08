# Strompreis AT – EPEX Spot Day-Ahead Österreich

Web-App und Datenbank mit **stündlichen Börsenstrompreisen (EPEX Spot AT, Day-Ahead) seit 01.01.2021**,
täglich automatisch aktualisiert über GitHub Actions, gehostet auf GitHub Pages.

Preise in **ct/kWh netto** (ohne USt, ohne Gebühren). Umschaltbar auf den smartCONTROL-Energiepreis
(Netto + 1,44 ct Abwicklungsgebühr, zzgl. 20 % USt).

## Ansichten

| Tab | Inhalt |
|---|---|
| **Heute** | Kennzahlen (jetzt, Tages-Ø, günstigste/teuerste Stunde, 30-Tage-Ø, morgen), Stundenbalken für heute und morgen, günstigstes zusammenhängendes 1–8-Stunden-Fenster |
| **Verlauf** | Monatsmittel 2021–heute mit Spanne der Tagesmittel, Jahresmittel |
| **Tagesprofil** | Mittlerer Preis je Tagesstunde, wählbar nach Zeitraum, Werktag/Wochenende oder Jahreszeit |
| **Heatmap** | Preis nach Stunde × Monat oder Stunde × Tag je Jahr |
| **Statistik** | Negative Stunden und Stunden über Schwelle je Monat, Wochentagsvergleich, Rekorde |

Jedes Diagramm hat eine Tabellenansicht („Tabelle“). Hell/Dunkel folgt dem System, umschaltbar.

## Dateien

| Pfad | Inhalt |
|---|---|
| `index.html`, `app.js`, `style.css` | Web-App (Vanilla JS + [ECharts](https://echarts.apache.org)) |
| `data/hourly_YYYY.json` | Stundenpreise je Jahr: `{"start_utc": …, "step_s": 3600, "values": […]}`, fortlaufend ab `start_utc` |
| `data/quarter_YYYY.json` | Viertelstundenpreise ab 01.10.2025 (`step_s` 900) |
| `data/meta.json` | Stand, letzter Zeitstempel, Anzahl Stunden, Lücken |
| `scripts/update.py` | Tägliches Update aus der Energy-Charts-API (läuft in Actions) |
| `.github/workflows/update.yml` | Zeitplan: täglich 12:20 und 15:20 UTC, zusätzlich manuell startbar |
| `stromdatenbank.py` | Lokal: baut `strompreise.db` (SQLite) und Gesamt-CSV aus den smartENERGY-Rohdaten + API |

## Quellen

- **smartENERGY** (smartenergy.at/downloads): 01.01.2021 – 27.07.2025
- **Energy-Charts** (Fraunhofer ISE, Daten Bundesnetzagentur | SMARD.de, Lizenz CC BY 4.0): ab 28.07.2025.
  Seit 01.10.2025 Viertelstundenhandel; Stundenwert = Mittel der vier Viertelstunden (wie smartENERGY).

## Datenformat lesen (Beispiel Python)

```python
import json, datetime as dt
d = json.load(open("data/hourly_2026.json"))
for i, v in enumerate(d["values"]):
    t = dt.datetime.fromtimestamp(d["start_utc"] + i * d["step_s"], dt.timezone.utc)
    print(t, v)  # ct/kWh netto
```

## Lokal starten

```bash
python3 -m http.server 8765
```
Dann `http://localhost:8765` öffnen. Update von Hand: `python3 scripts/update.py`.
