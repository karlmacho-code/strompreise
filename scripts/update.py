#!/usr/bin/env python3
"""
Aktualisiert die Preisdaten für die Web-App (data/*.json) aus der Energy-Charts-API.

Läuft täglich in GitHub Actions. Ohne Argumente: holt die letzten Tage neu
(ab letztem Stand minus 2 Tage) bis einschließlich morgen und schreibt die
Jahresdateien neu.

  python3 scripts/update.py                 # tägliches Update
  python3 scripts/update.py --aus-db strompreise.db   # einmaliger Erstaufbau aus der lokalen SQLite-DB

Dateiformat data/hourly_YYYY.json:
  {"start_utc": 1609455600, "step_s": 3600, "values": [ct_kwh_netto, ...]}
  Werte fortlaufend ab start_utc, null = fehlend. ct/kWh netto (ohne USt, ohne Gebühr).
data/quarter_YYYY.json: gleich, step_s = 900, ab 01.10.2025 (Viertelstundenhandel).
data/meta.json: Stand, letzter Zeitstempel, Anzahl Stunden.
"""
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

BASIS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASIS, "data")
WIEN = ZoneInfo("Europe/Vienna")
UTC = dt.timezone.utc
API = "https://api.energy-charts.info/price?bzn=AT&start={s}&end={e}"
VIERTEL_AB = dt.datetime(2025, 9, 30, 22, tzinfo=UTC)  # 01.10.2025 00:00 lokal


# ---------- Dateien lesen/schreiben ----------

def lade(praefix):
    """Alle data/<praefix>_YYYY.json -> dict {utc_sekunden: wert}"""
    out, step = {}, None
    for f in sorted(glob.glob(os.path.join(DATA, f"{praefix}_*.json"))):
        d = json.load(open(f))
        step = d["step_s"]
        for i, v in enumerate(d["values"]):
            if v is not None:
                out[d["start_utc"] + i * step] = v
    return out, step


def speichere(praefix, werte, step):
    """dict {utc_sekunden: wert} -> Jahresdateien (Jahr nach lokaler Zeit)."""
    os.makedirs(DATA, exist_ok=True)
    nach_jahr = {}
    for ts in sorted(werte):
        jahr = dt.datetime.fromtimestamp(ts, WIEN).year
        nach_jahr.setdefault(jahr, []).append(ts)
    for jahr, tss in nach_jahr.items():
        start, ende = tss[0], tss[-1]
        n = (ende - start) // step + 1
        vals = [None] * n
        for ts in tss:
            vals[(ts - start) // step] = round(werte[ts], 4)
        with open(os.path.join(DATA, f"{praefix}_{jahr}.json"), "w") as fh:
            json.dump({"start_utc": start, "step_s": step, "values": vals}, fh, separators=(",", ":"))


# ---------- Quellen ----------

def aus_db(pfad):
    con = sqlite3.connect(pfad)
    h = {int(dt.datetime.fromisoformat(z).timestamp()): p
         for z, p in con.execute("SELECT zeit_utc, ct_kwh_netto FROM preise_stunde")}
    q = {int(dt.datetime.fromisoformat(z).timestamp()): p
         for z, p in con.execute("SELECT zeit_utc, ct_kwh_netto FROM preise_15min")}
    return h, q


def api(start, ende):
    """Energy-Charts, EUR/MWh -> ct/kWh. Liefert {utc_sek: ct_kwh} im Originalraster."""
    out, s = {}, start
    while s <= ende:
        e = min(ende, (s.replace(day=1) + dt.timedelta(days=32)).replace(day=1) - dt.timedelta(days=1))
        url = API.format(s=s.isoformat(), e=(e + dt.timedelta(days=1)).isoformat())
        req = urllib.request.Request(url, headers={"User-Agent": "strompreise-at/1.0"})
        for versuch in range(6):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    d = json.load(r)
                break
            except urllib.error.HTTPError as err:
                if err.code != 429 or versuch == 5:
                    raise
                time.sleep(15 * (versuch + 1))
        for ts, p in zip(d.get("unix_seconds", []), d.get("price", [])):
            if p is not None:
                out[ts] = p / 10
        s = e + dt.timedelta(days=1)
        time.sleep(2)
    return out


# ---------- Hauptprogramm ----------

def main():
    if "--aus-db" in sys.argv:
        stunden, viertel = aus_db(sys.argv[sys.argv.index("--aus-db") + 1])
        print(f"Aus DB: {len(stunden)} Stunden, {len(viertel)} Viertelstunden")
    else:
        stunden, _ = lade("hourly")
        viertel, _ = lade("quarter")

    letzte = max(stunden) if stunden else int(dt.datetime(2025, 7, 27, 22, tzinfo=UTC).timestamp())
    start = dt.datetime.fromtimestamp(letzte, WIEN).date() - dt.timedelta(days=2)
    ende = dt.date.today() + dt.timedelta(days=1)
    roh = api(start, ende)
    ab = int(dt.datetime.combine(start, dt.time(), WIEN).timestamp())
    roh = {ts: p for ts, p in roh.items() if ts >= ab}

    # Stundenmittel bilden, Viertelstunden ab 01.10.2025 übernehmen
    buckets = {}
    for ts, p in roh.items():
        buckets.setdefault(ts - ts % 3600, []).append(p)
        if ts >= int(VIERTEL_AB.timestamp()):
            viertel[ts] = p
    for h, vs in buckets.items():
        stunden[h] = sum(vs) / len(vs)
    print(f"API ab {start}: {len(buckets)} Stunden neu/aktualisiert")

    speichere("hourly", stunden, 3600)
    speichere("quarter", viertel, 900)

    # Prüfung auf Lücken
    tss = sorted(stunden)
    luecken = sum(1 for a, b in zip(tss, tss[1:]) if b - a != 3600)
    letzter = dt.datetime.fromtimestamp(tss[-1], WIEN)
    morgen = dt.date.today() + dt.timedelta(days=1)
    meta = {
        "aktualisiert_utc": dt.datetime.now(UTC).replace(microsecond=0).isoformat(),
        "erster_utc": tss[0], "letzter_utc": tss[-1],
        "letzter_lokal": letzter.isoformat(),
        "stunden": len(tss), "luecken": luecken,
        "morgen_vorhanden": letzter.date() >= morgen,
        "quelle": "EPEX Spot AT Day-Ahead; bis 27.07.2025 smartENERGY, danach Energy-Charts (Fraunhofer ISE, "
                  "Bundesnetzagentur | SMARD.de, CC BY 4.0)",
    }
    json.dump(meta, open(os.path.join(DATA, "meta.json"), "w"), indent=1)
    print(f"Stand: {len(tss)} Stunden bis {letzter:%d.%m.%Y %H:%M}, Lücken: {luecken}, morgen: {meta['morgen_vorhanden']}")


if __name__ == "__main__":
    main()
