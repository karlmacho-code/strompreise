/* Tarifvergleich mit den echten Netz-NÖ-Viertelstundenwerten (als Stundensummen).
   Tarifstand: 08.11.2026 (Quellen: Tarifblätter der Anbieter, E-Control-Tarifkalkulator).
   Alle Bezugspreise brutto inkl. 20 % USt, nur Energie (Netzkosten sind bei allen Lieferanten gleich).
   Einspeisung netto (Privatpersonen ohne USt).
   p = EPEX-Spot AT Stundenpreis ct/kWh netto; m = Monatswerte (base = Ø Börse des Monats,
   mw = einspeisegewichteter Börsenpreis ≈ PV-Marktwert, als Näherung für ÖSPI bzw. OeMAG/Referenzmarktwert). */
"use strict";

const UST = 1.2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

const TARIFE_BEZUG = [
  { id: "ef_flex", name: "eFriends FLEX", aktuell: true, gebuehrMonat: 8.98,
    stunde: (p) => p * UST + Math.max(0.1 * p * UST, 2.28),
    info: "Börse + 10 %, mind. 2,28 ct brutto; 5,99 € + 2,99 € Plattform/Monat" },
  { id: "ef_flux", name: "eFriends FLUX", gebuehrMonat: 5.99,
    monat: (m) => clamp(m.base * 1.3, 10, 28) * UST,
    info: "ÖSPI-Monat + 30 %, 10–28 ct netto (ÖSPI ≈ Ø Börse des Monats); 5,99 €/Monat" },
  { id: "smartcontrol", name: "smartENERGY smartCONTROL", gebuehrMonat: 2.99,
    stunde: (p) => (p + 1.2) * UST, info: "Börse + 1,20 ct netto; 2,99 €/Monat" },
  { id: "verbund_spot", name: "VERBUND V-Strom SPOT", gebuehrMonat: 4.79,
    stunde: (p) => (p + 1.4) * UST, info: "Börse + 1,40 ct; 4,79 €/Monat (1. Jahr −50 %, hier nicht berücksichtigt)" },
  { id: "oeko_spot", name: "oekostrom oeko Spot+", gebuehrMonat: 2.16,
    stunde: (p) => (p + 1.5) * UST, info: "Börse + 1,50 ct netto; 2,16 €/Monat" },
  { id: "awattar", name: "aWATTar HOURLY", gebuehrMonat: 5.75,
    stunde: (p) => (p + 1.5) * UST, info: "Börse + 1,50 ct netto; 5,75 €/Monat" },
  { id: "evn_sonne", name: "EVN Optima Garant Sonne", gebuehrMonat: 7.2,
    stunde: (p, L) => ((L.m >= 3 && L.m <= 8 && L.h >= 10 && L.h < 16) ? 6.9 : 10.5) * UST,
    info: "Fix 10,50 ct netto, Apr–Sep 10–16 Uhr 6,90 ct; 72 € netto/Jahr; 12 Monate Bindung, Angebot prüfen" },
];

const TARIFE_EINSPEISUNG = [
  { id: "ef_flex_e", name: "eFriends FLEX", aktuell: true, gebuehrMonat: 0,
    stunde: (p) => p - Math.max(0.1 * p, 1.9), info: "Börse − 10 %, mind. 1,90 ct netto; Grundgebühr beim Bezug" },
  { id: "ef_flux_e", name: "eFriends FLUX / Fix", gebuehrMonat: 0,
    monat: (m) => clamp(m.mw - 1.25, 1, 10), info: "PV-Marktwert − 1,25 ct, 1–10 ct" },
  { id: "oemag", name: "OeMAG Marktpreis", gebuehrMonat: 0,
    monat: (m) => m.mw, info: "PV-Marktwert des Monats (hier genähert), keine Gebühr" },
  { id: "evn_sonnenstrom", name: "EVN SonnenStrom Monat", gebuehrMonat: 0,
    monat: (m) => 0.6 * m.base, info: "6,0 × ÖSPI / 100 (ÖSPI ≈ Ø Börse); nur mit EVN-Bezug" },
  { id: "awattar_sunny", name: "aWATTar SUNNY Spot", gebuehrMonat: 5.75,
    stunde: (p) => p * 0.81, info: "Börse − 19 % je Stunde; 5,75 €/Monat (entfällt mit aWATTar-Bezug)" },
  { id: "fix6", name: "Fixer Einspeisetarif 6 ct", gebuehrMonat: 0,
    stunde: () => 6, info: "z. B. RZ Sonnenstrom ≈ 6 ct" },
];

/** rows: [[ts_utc_sek, bezug_kwh, einsp_kwh], ...]; epex(ts) → ct netto oder null; local(ts) → {y,m,d,h} */
function tarifVergleichRechnen(rows, epex, local) {
  // Monatswerte
  const M = new Map();
  for (const [ts, bez, ein] of rows) {
    const p = epex(ts); if (p == null) continue;
    const L = local(ts), k = L.y * 12 + L.m;
    const e = M.get(k) || { bez: 0, ein: 0, pe: 0, ps: 0, n: 0 };
    e.bez += bez; e.ein += ein; e.pe += p * ein; e.ps += p; e.n++;
    M.set(k, e);
  }
  for (const e of M.values()) { e.base = e.ps / e.n; e.mw = e.ein ? e.pe / e.ein : e.base; }
  const monate = M.size;

  const rechne = (liste, spalte) => liste.map((t) => {
    let energie = 0, kwh = 0;
    if (t.stunde) {
      for (const r of rows) {
        const p = epex(r[0]); if (p == null) continue;
        const menge = r[spalte]; if (!menge) continue;
        energie += menge * t.stunde(p, local(r[0])) / 100; kwh += menge;
      }
    } else {
      for (const m of M.values()) { const menge = spalte === 1 ? m.bez : m.ein; energie += menge * t.monat(m) / 100; kwh += menge; }
    }
    const gebuehr = t.gebuehrMonat * monate;
    return { ...t, energie, gebuehr, kwh, ct: kwh ? energie / kwh * 100 : null };
  });
  const bezug = rechne(TARIFE_BEZUG, 1).map((t) => ({ ...t, gesamt: t.energie + t.gebuehr }));
  const einsp = rechne(TARIFE_EINSPEISUNG, 2).map((t) => ({ ...t, gesamt: t.energie - t.gebuehr }));
  const kwhBez = [...M.values()].reduce((a, m) => a + m.bez, 0), kwhEin = [...M.values()].reduce((a, m) => a + m.ein, 0);
  return { bezug, einsp, monate, kwhBez, kwhEin };
}

if (typeof module !== "undefined") module.exports = { TARIFE_BEZUG, TARIFE_EINSPEISUNG, tarifVergleichRechnen };
