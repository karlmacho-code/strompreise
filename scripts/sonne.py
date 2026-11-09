#!/usr/bin/env python3
"""Sonnenscheindauer, Globalstrahlung und Tagesmitteltemperatur der GeoSphere-Station Poysdorf Ost (ID 2503,
ca. 8 km von Großkrut) als Tageswerte seit 2023 -> data/sonne.json. Quelle: GeoSphere Austria Data Hub (CC BY 4.0)."""
import json, sys, time, datetime as dt, urllib.request, pathlib

STATION = "2503"
VON = "2023-01-01"
URL = ("https://dataset.api.hub.geosphere.at/v1/station/historical/klima-v2-1d"
       "?parameters=so_h,cglo_j,tl_mittel&station_ids={st}&start={von}&end={bis}&output_format=geojson")
ZIEL = pathlib.Path(__file__).resolve().parent.parent / "data" / "sonne.json"

def holen(url, versuche=4):
    for i in range(versuche):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "strompreise-at/1.0"}), timeout=60) as r:
                return json.load(r)
        except Exception as e:
            if i == versuche - 1: raise
            time.sleep(10 * (i + 1))

def main():
    heute = dt.date.today().isoformat()
    d = holen(URL.format(st=STATION, von=VON, bis=heute))
    f = d["features"][0]; p = f["properties"]["parameters"]
    so, gl, tl = p["so_h"]["data"], p["cglo_j"]["data"], p["tl_mittel"]["data"]
    tage = []
    for t, a, b, c in zip(d["timestamps"], so, gl, tl):
        if a is None and b is None: continue
        tage.append([t[:10], a, None if b is None else round(b), c])
    out = {
        "quelle": "GeoSphere Austria Data Hub, Datensatz klima-v2-1d, Station Poysdorf Ost (ID 2503, 48,669° N 16,638° O, 198 m), CC BY 4.0",
        "station": {"id": int(STATION), "name": "Poysdorf Ost", "lat": 48.66917, "lon": 16.6375, "hoehe_m": 198},
        "felder": ["tag", "sonnenstunden_h", "globalstrahlung_J_cm2", "temperatur_mittel_C"],
        "aktualisiert_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "von": tage[0][0], "bis": tage[-1][0], "tage": tage,
    }
    ZIEL.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"sonne.json: {len(tage)} Tage {out['von']} bis {out['bis']}")

if __name__ == "__main__":
    main()
