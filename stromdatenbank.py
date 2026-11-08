#!/usr/bin/env python3
"""
Stromdatenbank: EPEX Spot Day-Ahead-Preise Österreich (AT), stündlich, ab 2021.

Quellen:
  - smartENERGY Jahresdateien (rohdaten/EPEX_Spot_AT_*.xlsx/.csv) bis 27.07.2025
  - Energy-Charts API (Fraunhofer ISE, Daten Bundesnetzagentur | SMARD.de, CC BY 4.0)
    ab 28.07.2025 bis zum letzten verfügbaren Tag (inkl. morgen ab ca. 13 Uhr)

Preise: ct/kWh netto (ohne USt, ohne Abwicklungsgebühr) = reiner Börsenpreis.
Seit 01.10.2025 handelt die Börse in Viertelstunden; der Stundenwert ist der
Mittelwert der vier Viertelstunden (wie bei smartENERGY). Viertelstunden
werden zusätzlich in Tabelle `preise_15min` gespeichert.

Aufruf:
  python3 stromdatenbank.py            # aufbauen bzw. aktualisieren
  python3 stromdatenbank.py --neu      # Datenbank komplett neu aufbauen

Ergebnis: strompreise.db (SQLite) und EPEX_AT_stuendlich_2021_bis_heute.csv
"""
import csv
import datetime as dt
import glob
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

BASIS = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASIS, "strompreise.db")
CSV_OUT = os.path.join(BASIS, "EPEX_AT_stuendlich_2021_bis_heute.csv")
ROH = os.path.join(BASIS, "rohdaten")
WIEN = ZoneInfo("Europe/Vienna")
UTC = dt.timezone.utc
API = "https://api.energy-charts.info/price?bzn=AT&start={s}&end={e}"
SMARTENERGY_ENDE = dt.date(2025, 7, 27)


def lokal_zu_utc(lokale_zeiten):
    """Naive lokale Zeiten (in Reihenfolge, Doppelstunde bei Umstellung im
    Oktober zweimal) eindeutig in UTC umrechnen."""
    erg, vorher = [], None
    for t in lokale_zeiten:
        fold = 1 if vorher == t else 0  # zweites Vorkommen = Winterzeit
        erg.append(t.replace(tzinfo=WIEN, fold=fold).astimezone(UTC))
        vorher = t
    return erg


def lese_smartenergy():
    zeilen = []
    for f in sorted(glob.glob(os.path.join(ROH, "EPEX_Spot_AT_*.xlsx"))):
        import openpyxl
        ws = openpyxl.load_workbook(f, read_only=True).active
        for r in ws.iter_rows(min_row=2, values_only=True):
            if isinstance(r[0], dt.datetime) and r[1] is not None:
                zeilen.append((r[0], float(r[1])))
    for f in sorted(glob.glob(os.path.join(ROH, "EPEX_Spot_AT_*.csv"))):
        with open(f, encoding="utf-8-sig") as fh:
            for r in list(csv.reader(fh, delimiter=";"))[1:]:
                if len(r) >= 2 and r[1].strip():
                    t = dt.datetime.strptime(r[0].strip(), "%d.%m.%Y %H:%M")
                    zeilen.append((t, float(r[1].replace(",", "."))))
    utc = lokal_zu_utc([t for t, _ in zeilen])
    return [(u, p) for u, (_, p) in zip(utc, zeilen)]


def lade_api(start, ende):
    """Energy-Charts in Monatsblöcken. Liefert Liste (utc, EUR/MWh)."""
    werte, s = [], start
    while s <= ende:
        e = min(ende, (s.replace(day=1) + dt.timedelta(days=32)).replace(day=1) - dt.timedelta(days=1))
        url = API.format(s=s.isoformat(), e=(e + dt.timedelta(days=1)).isoformat())
        req = urllib.request.Request(url, headers={"User-Agent": "stromdatenbank/1.0"})
        for versuch in range(6):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    d = json.load(r)
                break
            except urllib.error.HTTPError as err:
                if err.code != 429 or versuch == 5:
                    raise
                time.sleep(15 * (versuch + 1))  # Rate-Limit: warten und neu versuchen
        time.sleep(3)
        for ts, p in zip(d.get("unix_seconds", []), d.get("price", [])):
            if p is not None:
                werte.append((dt.datetime.fromtimestamp(ts, UTC), float(p)))
        s = e + dt.timedelta(days=1)
    return werte


def main():
    if "--neu" in sys.argv and os.path.exists(DB):
        os.remove(DB)
    con = sqlite3.connect(DB)
    con.executescript("""
        CREATE TABLE IF NOT EXISTS preise_stunde (
            zeit_utc TEXT PRIMARY KEY,        -- ISO, Stundenbeginn UTC
            zeit_lokal TEXT NOT NULL,         -- Europe/Vienna, mit Offset
            ct_kwh_netto REAL NOT NULL,
            quelle TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS preise_15min (
            zeit_utc TEXT PRIMARY KEY,
            zeit_lokal TEXT NOT NULL,
            ct_kwh_netto REAL NOT NULL,
            quelle TEXT NOT NULL);
        CREATE VIEW IF NOT EXISTS monatsmittel AS
            SELECT substr(zeit_lokal,1,7) AS monat, COUNT(*) AS stunden,
                   ROUND(AVG(ct_kwh_netto),3) AS mittel, MIN(ct_kwh_netto) AS min,
                   MAX(ct_kwh_netto) AS max
            FROM preise_stunde GROUP BY monat ORDER BY monat;
    """)

    def schreibe(tabelle, zeilen, quelle):
        con.executemany(
            f"INSERT OR REPLACE INTO {tabelle} VALUES (?,?,?,?)",
            [(u.isoformat(), u.astimezone(WIEN).isoformat(), round(p, 4), quelle) for u, p in zeilen])

    # 1) smartENERGY (nur beim ersten Aufbau)
    if con.execute("SELECT COUNT(*) FROM preise_stunde WHERE quelle='smartENERGY'").fetchone()[0] == 0:
        se = lese_smartenergy()
        schreibe("preise_stunde", se, "smartENERGY")
        print(f"smartENERGY: {len(se)} Stunden")

    # 2) Energy-Charts ab dem Tag nach smartENERGY bzw. ab letztem Stand (2 Tage Überlappung)
    letzte = con.execute("SELECT MAX(zeit_lokal) FROM preise_stunde WHERE quelle='Energy-Charts'").fetchone()[0]
    start = SMARTENERGY_ENDE + dt.timedelta(days=1)
    if letzte:
        start = max(start, dt.date.fromisoformat(letzte[:10]) - dt.timedelta(days=2))
    ende = dt.date.today() + dt.timedelta(days=1)
    roh = lade_api(start, ende)
    erster_tag = dt.datetime.combine(start, dt.time(), WIEN).astimezone(UTC)
    roh = [(u, p / 10) for u, p in roh if u >= erster_tag]  # EUR/MWh -> ct/kWh

    stunden = {}
    viertel = []
    for u, p in roh:
        h = u.replace(minute=0)
        stunden.setdefault(h, []).append(p)
        if u >= dt.datetime(2025, 9, 30, 22, tzinfo=UTC):
            viertel.append((u, p))
    stunde = [(h, sum(v) / len(v)) for h, v in sorted(stunden.items())]
    schreibe("preise_stunde", stunde, "Energy-Charts")
    schreibe("preise_15min", viertel, "Energy-Charts")
    con.commit()
    print(f"Energy-Charts ab {start}: {len(stunde)} Stunden, {len(viertel)} Viertelstunden")

    # 3) Prüfung auf Lücken und Doppel (in UTC muss jede Stunde genau 1x vorkommen)
    zeiten = [dt.datetime.fromisoformat(r[0]) for r in con.execute("SELECT zeit_utc FROM preise_stunde ORDER BY zeit_utc")]
    luecken = [(a, b) for a, b in zip(zeiten, zeiten[1:]) if b - a != dt.timedelta(hours=1)]
    print(f"Gesamt: {len(zeiten)} Stunden, {zeiten[0].astimezone(WIEN):%d.%m.%Y %H:%M} bis "
          f"{zeiten[-1].astimezone(WIEN):%d.%m.%Y %H:%M}, Lücken: {len(luecken)}")
    for a, b in luecken[:10]:
        print("  Lücke:", a.astimezone(WIEN), "->", b.astimezone(WIEN))

    # 4) Gesamt-CSV im smartENERGY-Format (Dezimalkomma, lokale Zeit)
    with open(CSV_OUT, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["datum_zeit_mez", "epex_at_ct_kwh", "quelle"])
        for zl, p, q in con.execute("SELECT zeit_lokal, ct_kwh_netto, quelle FROM preise_stunde ORDER BY zeit_utc"):
            t = dt.datetime.fromisoformat(zl)
            w.writerow([t.strftime("%d.%m.%Y %H:%M"), f"{p:.4f}".rstrip("0").rstrip(".").replace(".", ","), q])
    con.close()


if __name__ == "__main__":
    main()
