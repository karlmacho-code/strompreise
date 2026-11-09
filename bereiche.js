/* „Mein Strom“: Bereiche über alle Quellen (Netz NÖ, eFriends, FusionSolar, Monta, EPEX).
   Nutzt Hilfsfunktionen aus app.js (base, chart, setTable, kpi, css, local, offset, D …) und mein.js (MS, $m, epexAt …). */
"use strict";

const B = {
  sec: "uebersicht", zeit: "m12", abArt: "bezug",
  tage: null,             // Tageswerte aller Quellen (tage_alle_json)
  laden: [],              // Ladevorgänge (Monta)
  kwp: null,              // Anlagenleistung aus sync_einstellung 'pv_kwp'
  netzH: new Map(),       // Zeitraum -> Netz-NÖ-Stundenwerte [ts, bezug, einsp]
  tagDaten: new Map(),    // Datum -> Viertelstunden aller Quellen
  quartal: new Map(),     // Jahr -> EPEX-Viertelstundenpreise
  tag: null,
};
try { B.sec = localStorage.getItem("ms-sec") || B.sec; B.zeit = localStorage.getItem("ms-zeit") || B.zeit; } catch (_) {}

// Farben je Bedeutung (überall gleich)
const FB = { netz: "--series-1", einsp: "--series-2", bat: "--series-3", pv: "--series-4", wb: "--series-5", ef: "--series-3", fs: "--series-4" };
const pad2 = n => String(n).padStart(2, "0");
const isoTag = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;
const nk = v => v == null || Number.isNaN(v) ? "–" : nf0.format(v);          // kWh ganzzahlig
const n1 = v => v == null || Number.isNaN(v) ? "–" : nf1.format(v);
const n2 = v => v == null || Number.isNaN(v) ? "–" : nf2.format(v);
const pz = v => v == null || !isFinite(v) ? "–" : (v > 0 ? "+" : "") + nf1.format(v) + " %";
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
const r3 = v => v == null ? null : Math.round(v * 1000) / 1000;

/** UTC-Sekunden der Wiener Mitternacht eines Kalendertags */
function wienMitternacht(y, m, d) { const s = Date.UTC(y, m, d) / 1000; return s - offset(s); }
function viertelSoll(y, m, d) { return Math.round((wienMitternacht(y, m, d + 1) - wienMitternacht(y, m, d)) / 900); }

// ---------- Zeitraum ----------
function bZeitraeume() {
  const L = local(Math.floor(Date.now() / 1000)), y = L.y, m = L.m;
  const y0 = B.tage && B.tage.length ? B.tage[0].y : y;
  const z = [{ v: "m12", l: "Letzte 12 Monate", a: y * 12 + m - 11, b: y * 12 + m }];
  for (let j = y; j >= y0; j--) z.push({ v: String(j), l: String(j), a: j * 12, b: j * 12 + 11 });
  z.push({ v: "alle", l: "Alles", a: 0, b: 1e9 });
  return z;
}
function bZeit() { const z = bZeitraeume(); return z.find(x => x.v === B.zeit) || z[0]; }
function bImZeitraum(y, m) { const z = bZeit(), k = y * 12 + m; return k >= z.a && k <= z.b; }
function bTage() { return (B.tage || []).filter(t => bImZeitraum(t.y, t.m)); }
/** Zeitraum als [von, bis) in UTC-Sekunden, begrenzt auf vorhandene Daten */
function bGrenzen() {
  const z = bZeit(), T = B.tage || [];
  let a = z.a, b = z.b;
  if (T.length) { a = Math.max(a, T[0].y * 12 + T[0].m); b = Math.min(b, T[T.length - 1].y * 12 + T[T.length - 1].m); }
  return [wienMitternacht(Math.floor(a / 12), a % 12, 1), wienMitternacht(Math.floor((b + 1) / 12), (b + 1) % 12, 1)];
}

// ---------- Daten ----------
async function bAlleZeilen(bauen) {
  const alle = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await bauen().range(i, i + 999);
    if (error) throw error;
    alle.push(...data); if (data.length < 1000) return alle;
  }
}
function tagObj(r) {
  const [tag, nb, ne, nc, eb, ee, ep, ec, pv, verbr, eigen, lad, entl, pein, pbez, wb] = r;
  const [y, mo, d] = tag.split("-").map(Number);
  const o = { tag, y, m: mo - 1, d, nb, ne, nc: nc || 0, eb, ee, ec: ec || 0, pv, verbr, eigen, lad, entl, pein, pbez, wb: wb || {} };
  o.soll = viertelSoll(y, mo - 1, d);
  o.wbSum = Object.values(o.wb).reduce((a, x) => a + (+x || 0), 0);
  // Energiebilanz: Netz aus dem geeichten Zähler (Netz NÖ), sonst FusionSolar; Erzeugung und Batterie aus FusionSolar
  o.bez = nb ?? pbez; o.ein = ne ?? pein;
  if (pv != null && o.bez != null) {
    const uebrig = Math.max(0, pv - (o.ein || 0));          // PV, die nicht eingespeist wurde
    o.ladPV = Math.min(lad || 0, uebrig);                    // Batterie aus PV geladen
    o.ladNetz = (lad || 0) - o.ladPV;                        // Rest kam aus dem Netz
    o.direkt = uebrig - o.ladPV;
    o.bezDirekt = Math.max(0, o.bez - o.ladNetz);
    o.haus = o.direkt + (entl || 0) + o.bezDirekt;
  }
  return o;
}
async function bLaden() {
  const L = local(Math.floor(Date.now() / 1000));
  const r = await MS.sb.rpc("tage_alle_json", { von: "2020-01-01", bis: isoTag(L.y, L.m, L.d) });
  if (r.error) throw r.error;
  B.tage = (r.data || []).map(tagObj);
  try {
    B.laden = await bAlleZeilen(() => MS.sb.from("laden").select("wallbox_id,wallbox,start,ende,kwh,kosten_cent,soc_start,soc_ende,smart").order("start"));
  } catch (_) { B.laden = []; }
  const e = await MS.sb.from("sync_einstellung").select("schluessel,wert").eq("schluessel", "pv_kwp");
  B.kwp = e.data && e.data[0] ? parseFloat(String(e.data[0].wert).replace(",", ".")) || null : null;
  B.netzH.clear(); B.tagDaten.clear();
  if (!B.tag) {
    const fertig = B.tage.filter(t => t.nc >= t.soll);
    const t = fertig[fertig.length - 1] || B.tage[B.tage.length - 1];
    B.tag = t ? t.tag : null;
  }
}
async function bNetzStunden() {
  const [von, bis] = bGrenzen(), k = von + "-" + bis;
  if (!B.netzH.has(k)) {
    const r = await MS.sb.rpc("netz_stunden_json", { von: new Date(von * 1000).toISOString(), bis: new Date(bis * 1000).toISOString() });
    if (r.error) throw r.error;
    B.netzH.set(k, r.data || []);
  }
  return B.netzH.get(k);
}

// ---------- Diagramm-Bausteine ----------
const legende = () => ({ top: 0, left: 0, icon: "circle", itemWidth: 8, itemHeight: 8, textStyle: { color: css("--text-2"), fontSize: 12 } });
const punkt = c => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:6px"></span>`;
function monatsListe(tage) {
  const M = new Map();
  for (const t of tage) {
    const k = t.y * 12 + t.m; let e = M.get(k);
    if (!e) { e = { k, y: t.y, m: t.m, ttl: `${MONATE[t.m]} ${String(t.y).slice(2)}`, tage: [] }; M.set(k, e); }
    e.tage.push(t);
  }
  return [...M.values()].sort((a, b) => a.k - b.k);
}
const summe = (liste, f) => { let s = 0, n = 0; for (const x of liste) { const v = f(x); if (v != null && !Number.isNaN(v)) { s += v; n++; } } return n ? s : null; };
function monatsAchse(o, list) {
  o.xAxis.data = list.map(e => e.ttl);
  const schmal = window.innerWidth < 600;
  if (list.length > 14) { o.xAxis.axisLabel.interval = i => list[i].m === 0; o.xAxis.axisLabel.formatter = (v, i) => String(list[i].y); }
  else if (schmal && list.length > 6) {        // Handy: nur jeder zweite Monat, Jahr darunter
    o.xAxis.axisLabel.interval = i => (list.length - 1 - i) % 2 === 0;
    o.xAxis.axisLabel.formatter = (v, i) => `${MONATE[list[i].m]}\n${String(list[i].y).slice(2)}`;
    o.xAxis.axisLabel.lineHeight = 13;
  } else o.xAxis.axisLabel.interval = 0;
}
function monatsTip(list, einheit) {
  return ps => `<b>${MONATE_LANG[list[ps[0].dataIndex].m]} ${list[ps[0].dataIndex].y}</b><br>` +
    ps.filter(p => p.value != null && p.value !== "-").map(p => `${punkt(p.color)}${p.seriesName}: ${einheit(Math.abs(p.value))}`).join("<br>");
}
function saeule(name, data, farbe, stapel, oben) {
  return { type: "bar", name, data, stack: stapel, barMaxWidth: stapel ? 36 : 16, barGap: "15%",
    itemStyle: { color: css(farbe), borderRadius: oben === false ? [0, 0, 3, 3] : stapel && !oben ? 0 : [3, 3, 0, 0], borderColor: css("--surface"), borderWidth: stapel ? 1 : 0 } };
}
function linie(name, data, farbe, opt = {}) {
  return { type: "line", name, data, symbol: "circle", symbolSize: 6, showSymbol: data.length < 40, connectNulls: false,
    lineStyle: { width: 2, color: css(farbe), type: opt.dash ? "dashed" : "solid" }, itemStyle: { color: css(farbe) }, ...opt.extra };
}
function oben(o, legendeAn = true) { o.grid.top = legendeAn ? (window.innerWidth < 600 ? 56 : 36) : 16; if (legendeAn) o.legend = legende(); return o; }
function keineDaten(id, text) {
  const o = base(); o.xAxis.show = false; o.yAxis.show = false;
  o.graphic = { type: "text", left: "center", top: "middle", style: { text: text || "Keine Daten im Zeitraum", fill: css("--muted"), fontSize: 13 } };
  o.series = []; chart(id, o); setTable(id, ["–"], []);
}
const zeitText = () => bZeit().l;

// ---------- Bereich: Übersicht ----------
function bUebersicht() {
  const T = bTage(), bil = T.filter(t => t.haus != null);
  const s = f => summe(bil, f) || 0;
  const pv = s(t => t.pv), haus = s(t => t.haus), bez = s(t => t.bez), ein = s(t => t.ein), entl = s(t => t.entl), dir = s(t => t.direkt);
  const ladPV = s(t => t.ladPV), ladNetz = s(t => t.ladNetz), bezDir = s(t => t.bezDirekt);
  const wb = summe(T, t => t.wbSum) || 0;
  let k = "";
  k += kpi("PV-Erzeugung", nk(pv), "kWh", B.kwp ? `${nk(pv / B.kwp)} kWh je kWp` : `${bil.length} Tage`);
  k += kpi("Verbrauch gesamt", nk(haus), "kWh", wb ? `davon Wallboxen ${nk(wb)} kWh` : "inkl. Wallboxen");
  k += kpi("Autarkie", haus ? nf0.format((1 - bez / (haus + ladNetz)) * 100) : "–", "%", "Anteil ohne Netzbezug");
  k += kpi("Eigenverbrauch", pv ? nf0.format((1 - ein / pv) * 100) : "–", "%", "Anteil der PV, der im Haus bleibt");
  k += kpi("Netzbezug", nk(bez), "kWh", "Netz NÖ");
  k += kpi("Einspeisung", nk(ein), "kWh", "Netz NÖ");
  $m("ue-kpis").innerHTML = k;

  // Energiefluss (Sankey)
  if (!bil.length) keineDaten("ue-c-fluss", "Keine Tage mit PV- und Netzwerten im Zeitraum");
  else {
    const wbB = Math.min(summe(bil, t => t.wbSum) || 0, haus);
    const knoten = [["PV-Anlage", FB.pv], ["Netz", FB.netz], ["Batterie", FB.bat], ["Verbrauch", "--muted"], ["Haushalt", "--axis"], ["Wallboxen", FB.wb], ["Einspeisung", FB.einsp]];
    const links = [["PV-Anlage", "Verbrauch", dir], ["PV-Anlage", "Batterie", ladPV], ["PV-Anlage", "Einspeisung", ein], ["Netz", "Batterie", ladNetz],
      ["Batterie", "Verbrauch", entl], ["Netz", "Verbrauch", bezDir], ["Verbrauch", "Wallboxen", wbB], ["Verbrauch", "Haushalt", haus - wbB]].filter(l => l[2] > 0.5);
    const genutzt = new Set(links.flatMap(l => [l[0], l[1]]));
    const schmal = window.innerWidth < 600;
    const o = { animationDuration: 300, textStyle: { fontFamily: base().textStyle.fontFamily },
      tooltip: { trigger: "item", backgroundColor: css("--surface"), borderColor: css("--border"), textStyle: { color: css("--text"), fontSize: 13 },
        formatter: p => p.dataType === "edge" ? `${p.data.source} → ${p.data.target}<br><b>${nk(p.data.value)} kWh</b>` : `<b>${p.name}</b><br>${nk(p.value)} kWh` },
      series: [{ type: "sankey", left: 4, right: schmal ? 80 : 110, top: 8, bottom: 8, nodeWidth: 12, nodeGap: 14, nodeAlign: "justify", layoutIterations: 0, draggable: false,
        emphasis: { focus: "adjacency" },
        data: knoten.filter(n => genutzt.has(n[0])).map(([name, f]) => ({ name, itemStyle: { color: css(f), borderWidth: 0 } })),
        links: links.map(([source, target, value]) => ({ source, target, value: Math.round(value) })),
        lineStyle: { color: "source", opacity: 0.32, curveness: 0.5 },
        label: { color: css("--text"), fontSize: schmal ? 11 : 12, lineHeight: 15, formatter: p => schmal ? `${p.name}\n${nk(p.value)}` : `${p.name}  ${nk(p.value)}` } }] };
    chart("ue-c-fluss", o);
    setTable("ue-c-fluss", ["Von", "Nach", "kWh"], links.map(l => [l[0], l[1], nk(l[2])]));
  }
  $m("n-ue-c-fluss").textContent = bil.length ? `${zeitText()}: ${bil.length} Tage mit vollständiger Bilanz.` : "";

  // Woher / Wohin je Monat
  const M = monatsListe(bil);
  const sm = (e, f) => r1(summe(e.tage, f));
  if (!M.length) { keineDaten("ue-c-woher"); keineDaten("ue-c-wohin"); return; }
  let o = oben(base()); monatsAchse(o, M); o.tooltip.formatter = monatsTip(M, v => nk(v) + " kWh");
  o.series = [saeule("PV direkt", M.map(e => sm(e, t => t.direkt)), FB.pv, "s"), saeule("Batterie", M.map(e => sm(e, t => t.entl)), FB.bat, "s"),
    saeule("Netz", M.map(e => sm(e, t => t.bezDirekt)), FB.netz, "s", true)];
  chart("ue-c-woher", o);
  setTable("ue-c-woher", ["Monat", "PV direkt", "Batterie", "Netz", "Verbrauch", "Autarkie"],
    M.map(e => { const h = summe(e.tage, t => t.haus), b = summe(e.tage, t => t.bezDirekt); return [e.ttl, nk(sm(e, t => t.direkt)), nk(sm(e, t => t.entl)), nk(b), nk(h), h ? nf0.format((1 - b / h) * 100) + " %" : "–"]; }));
  o = oben(base()); monatsAchse(o, M); o.tooltip.formatter = monatsTip(M, v => nk(v) + " kWh");
  o.series = [saeule("Direkt verbraucht", M.map(e => sm(e, t => t.direkt)), FB.pv, "s"), saeule("In die Batterie", M.map(e => sm(e, t => t.ladPV)), FB.bat, "s"),
    saeule("Eingespeist", M.map(e => sm(e, t => t.ein)), FB.einsp, "s", true)];
  chart("ue-c-wohin", o);
  setTable("ue-c-wohin", ["Monat", "Erzeugung", "direkt", "Batterie", "eingespeist", "Eigenverbrauch"],
    M.map(e => { const p = summe(e.tage, t => t.pv), x = summe(e.tage, t => t.ein); return [e.ttl, nk(p), nk(sm(e, t => t.direkt)), nk(sm(e, t => t.ladPV)), nk(x), p ? nf0.format((1 - x / p) * 100) + " %" : "–"]; }));
}

// ---------- Bereich: Abgleich der drei Messungen ----------
function bAbgleich() {
  const be = B.abArt === "bezug";
  const wert = { n: t => be ? t.nb : t.ne, e: t => be ? t.eb : t.ee, f: t => be ? t.pbez : t.pein };
  const ok = { n: t => t.nb != null && t.nc >= t.soll, e: t => t.eb != null && t.ec >= t.soll, f: t => wert.f(t) != null };
  const T = bTage(), drei = T.filter(t => ok.n(t) && ok.e(t) && ok.f(t));
  const sN = summe(drei, wert.n), sE = summe(drei, wert.e), sF = summe(drei, wert.f);
  const d = (x, ref) => x == null || !ref ? null : (x - ref) / ref * 100;
  $m("ab-hint").textContent = be ? "Strom aus dem Netz" : "Strom ins Netz";
  $m("ab-kpis").innerHTML =
    kpi("Vergleichstage", nf0.format(drei.length), "", `von ${nf0.format(T.length)} Tagen im Zeitraum`) +
    kpi("Netz NÖ", nk(sN), "kWh", "geeichter Zähler, Referenz") +
    kpi("eFriends", nk(sE), "kWh", `${pz(d(sE, sN))} zu Netz NÖ`) +
    kpi("FusionSolar", nk(sF), "kWh", `${pz(d(sF, sN))} zu Netz NÖ`);

  // 1) Mengen an Tagen, an denen alle drei vollständig sind
  const M = monatsListe(drei);
  if (!M.length) keineDaten("ab-c-menge", "Keine Tage, an denen alle drei Quellen vollständig sind");
  else {
    const o = oben(base()); monatsAchse(o, M); o.tooltip.formatter = monatsTip(M, v => n1(v) + " kWh");
    o.series = [saeule("Netz NÖ", M.map(e => r1(summe(e.tage, wert.n))), FB.netz), saeule("eFriends", M.map(e => r1(summe(e.tage, wert.e))), FB.ef),
      saeule("FusionSolar", M.map(e => r1(summe(e.tage, wert.f))), FB.fs)];
    chart("ab-c-menge", o);
    setTable("ab-c-menge", ["Monat", "Tage", "Netz NÖ", "eFriends", "Δ", "FusionSolar", "Δ"], M.map(e => {
      const n = summe(e.tage, wert.n), x = summe(e.tage, wert.e), f = summe(e.tage, wert.f);
      return [e.ttl, e.tage.length, n1(n), n1(x), pz(d(x, n)), n1(f), pz(d(f, n))];
    }));
  }
  $m("n-ab-c-menge").textContent = drei.length
    ? `Nur Tage, an denen alle drei Quellen vollständige Werte haben (${drei.length} Tage). So zeigen die Balken echte Messunterschiede und keine Datenlücken.`
    : "";

  // 2) Abweichung je Quelle (paarweise: Tage, an denen Netz NÖ und die jeweilige Quelle vollständig sind)
  const MA = monatsListe(T.filter(t => ok.n(t)));
  const paar = (e, q) => { const tt = e.tage.filter(ok[q]); const n = summe(tt, wert.n), x = summe(tt, wert[q]); return { n, x, tage: tt.length, d: n != null && n >= 5 ? d(x, n) : null }; };
  if (!MA.length) keineDaten("ab-c-diff");
  else {
    const o = oben(base()); monatsAchse(o, MA);
    o.tooltip.formatter = ps => `<b>${MONATE_LANG[MA[ps[0].dataIndex].m]} ${MA[ps[0].dataIndex].y}</b><br>` + ps.map(p => {
      const q = p.seriesIndex === 0 ? "e" : "f", r = paar(MA[p.dataIndex], q);
      return `${punkt(p.color)}${p.seriesName}: ${pz(p.value)} <span style="color:${css("--muted")}">(${r.tage} Tage)</span>`;
    }).join("<br>");
    o.yAxis.axisLabel.formatter = v => nf0.format(v) + " %";
    const ser = (name, q, f) => ({ ...saeule(name, MA.map(e => { const r = paar(e, q); return r.d == null ? null : r1(r.d); }), f), itemStyle: { color: css(f), borderRadius: 3 } });
    o.series = [ser("eFriends", "e", FB.ef), ser("FusionSolar", "f", FB.fs)];
    o.series[0].markLine = { silent: true, symbol: "none", data: [{ yAxis: 0 }], lineStyle: { color: css("--text-2"), width: 1, type: "solid" }, label: { show: false } };
    chart("ab-c-diff", o);
    setTable("ab-c-diff", ["Monat", "Netz NÖ", "eFriends", "Δ eFriends", "Tage", "Netz NÖ", "FusionSolar", "Δ FusionSolar", "Tage"], MA.map(e => {
      const a = paar(e, "e"), b = paar(e, "f");
      return [e.ttl, n1(a.n), n1(a.x), pz(a.d), a.tage, n1(b.n), n1(b.x), pz(b.d), b.tage];
    }));
  }
  $m("n-ab-c-diff").textContent = "Je Quelle alle Tage, an denen sie und Netz NÖ vollständig sind. Über null: Quelle misst mehr als der Zähler, unter null: weniger. Monate unter 5 kWh sind ausgeblendet.";

  // 3) Datenabdeckung
  const MM = monatsListe(T);
  if (!MM.length) keineDaten("ab-c-abd");
  else {
    const o = oben(base()); monatsAchse(o, MM); o.tooltip.formatter = monatsTip(MM, v => nf0.format(v) + " Tage");
    o.series = [saeule("Netz NÖ", MM.map(e => e.tage.filter(ok.n).length), FB.netz), saeule("eFriends", MM.map(e => e.tage.filter(ok.e).length), FB.ef),
      saeule("FusionSolar", MM.map(e => e.tage.filter(ok.f).length), FB.fs)];
    chart("ab-c-abd", o);
    setTable("ab-c-abd", ["Monat", "Tage", "Netz NÖ", "eFriends", "FusionSolar", "alle drei"],
      MM.map(e => [e.ttl, new Date(e.y, e.m + 1, 0).getDate(), e.tage.filter(ok.n).length, e.tage.filter(ok.e).length, e.tage.filter(ok.f).length, e.tage.filter(t => ok.n(t) && ok.e(t) && ok.f(t)).length]));
  }
  $m("n-ab-c-abd").textContent = "";

  // 4) Größte Abweichungen
  const kand = T.filter(t => ok.n(t) && (ok.e(t) || ok.f(t))).map(t => {
    const n = wert.n(t), e = ok.e(t) ? wert.e(t) : null, f = ok.f(t) ? wert.f(t) : null;
    return { t, n, e, f, max: Math.max(e == null ? 0 : Math.abs(e - n), f == null ? 0 : Math.abs(f - n)) };
  }).sort((a, b) => b.max - a.max).slice(0, 25);
  const dd = (x, n) => x == null ? "–" : (x - n >= 0 ? "+" : "") + nf1.format(x - n);
  $m("ab-tage").innerHTML = kand.length ? `<table><thead><tr><th>Tag</th><th>Netz NÖ</th><th>eFriends</th><th>Δ</th><th>FusionSolar</th><th>Δ</th><th></th></tr></thead><tbody>${
    kand.map(k => `<tr><td>${dateStr(k.t.y, k.t.m, k.t.d)} ${WOCHENTAGE[new Date(k.t.y, k.t.m, k.t.d).getDay()]}</td><td>${n1(k.n)}</td><td>${n1(k.e)}</td><td>${dd(k.e, k.n)}</td><td>${n1(k.f)}</td><td>${dd(k.f, k.n)}</td>` +
      `<td><button class="tbl-btn" type="button" data-zum-tag="${k.t.tag}">Tag ansehen</button></td></tr>`).join("")}</tbody></table>`
    : `<p class="note">Keine vergleichbaren Tage im Zeitraum.</p>`;
}

// ---------- Bereich: Netz ----------
async function bNetz() {
  const T = bTage().filter(t => t.nb != null);
  const H = await bNetzStunden();
  const voll = T.filter(t => t.nc >= t.soll);
  let spitze = null; for (const h of H) if (!spitze || h[1] > spitze[1]) spitze = h;
  const SL = spitze ? local(spitze[0]) : null;
  $m("nz-kpis").innerHTML =
    kpi("Bezug", nk(summe(T, t => t.nb)), "kWh", `${T.length} Tage`) +
    kpi("Einspeisung", nk(summe(T, t => t.ne)), "kWh", "") +
    kpi("Ø Bezug je Tag", voll.length ? n1(summe(voll, t => t.nb) / voll.length) : "–", "kWh", "vollständige Tage") +
    kpi("Höchste Stunde", spitze ? n1(spitze[1]) : "–", "kWh", SL ? `${dateStr(SL.y, SL.m, SL.d)}, ${hh(SL.h)}` : "");

  const M = monatsListe(T);
  if (!M.length) { keineDaten("nz-c-monat"); keineDaten("nz-c-heat"); keineDaten("nz-c-profil"); return; }
  let o = oben(base()); monatsAchse(o, M); o.tooltip.formatter = monatsTip(M, v => nk(v) + " kWh");
  o.yAxis.axisLabel.formatter = v => nf0.format(Math.abs(v));
  o.series = [saeule("Bezug", M.map(e => r1(summe(e.tage, t => t.nb))), FB.netz, "x", true),
    saeule("Einspeisung", M.map(e => { const v = summe(e.tage, t => t.ne); return v == null ? null : -r1(v); }), FB.einsp, "x", false)];
  chart("nz-c-monat", o);
  setTable("nz-c-monat", ["Monat", "Tage", "Bezug kWh", "Einspeisung kWh", "Ø Bezug je Tag"],
    M.map(e => [e.ttl, e.tage.length, nk(summe(e.tage, t => t.nb)), nk(summe(e.tage, t => t.ne)), n1(summe(e.tage, t => t.nb) / e.tage.length)]));

  // Heatmap Monat × Stunde (Ø kWh je Stunde)
  const acc = new Map(), zeilen = new Map();
  for (const [ts, b] of H) {
    const L = local(ts), rk = L.y * 12 + L.m;
    if (!zeilen.has(rk)) zeilen.set(rk, `${MONATE[L.m]} ${String(L.y).slice(2)}`);
    const k = rk * 24 + L.h, e = acc.get(k) || [0, 0]; e[0] += b; e[1]++; acc.set(k, e);
  }
  const rk = [...zeilen.keys()].sort((a, b) => a - b), ri = new Map(rk.map((k, i) => [k, i]));
  const data = [], vals = [];
  for (const [k, [s, c]] of acc) { const v = s / c; data.push([k % 24, ri.get(Math.floor(k / 24)), +v.toFixed(3)]); vals.push(v); }
  vals.sort((a, b) => a - b);
  const q = p => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0;
  o = base();
  o.tooltip.trigger = "item"; o.tooltip.axisPointer = undefined;
  o.tooltip.formatter = p => `<b>${zeilen.get(rk[p.value[1]])}, ${hh(p.value[0])}–${hh((p.value[0] + 1) % 24)}</b><br>Ø ${n2(p.value[2])} kWh je Stunde`;
  o.grid = { left: 8, right: 12, top: 8, bottom: 56, containLabel: true };
  o.xAxis = { ...o.xAxis, data: Array.from({ length: 24 }, (_, h) => hh(h)), position: "top", axisLine: { show: false }, axisLabel: { ...o.xAxis.axisLabel, interval: window.innerWidth < 600 ? 3 : 1 } };
  o.yAxis = { type: "category", data: rk.map(k => zeilen.get(k)), inverse: true, axisTick: { show: false }, axisLine: { show: false },
    axisLabel: { color: css("--muted"), fontSize: 11, interval: rk.length > 18 ? (i, v) => v.startsWith("Jan") : 0 } };
  o.visualMap = { type: "continuous", min: q(0.02), max: q(0.98), dimension: 2, orient: "horizontal", left: "center", bottom: 0, itemWidth: 10, itemHeight: 180,
    inRange: { color: seqRamp() }, text: [`${n2(q(0.98))}+ kWh`, `≤ ${n2(q(0.02))}`], textStyle: { color: css("--muted"), fontSize: 11 }, calculable: false };
  o.series = [{ type: "heatmap", data, progressive: 0, itemStyle: { borderColor: css("--surface"), borderWidth: rk.length > 18 ? 1 : 2, borderRadius: 2 } }];
  $m("nz-c-heat").style.height = Math.max(260, rk.length * (rk.length > 18 ? 12 : 22) + 110) + "px";
  if (charts["nz-c-heat"]) charts["nz-c-heat"].resize();
  chart("nz-c-heat", o);
  setTable("nz-c-heat", ["Monat", ...Array.from({ length: 24 }, (_, h) => String(h))],
    rk.map(r => [zeilen.get(r), ...Array.from({ length: 24 }, (_, h) => { const e = acc.get(r * 24 + h); return e ? n2(e[0] / e[1]) : "–"; })]));
  $m("n-nz-c-heat").textContent = "Dunkler = mehr Strom aus dem Netz in dieser Stunde (Durchschnitt des Monats). Typisch: Abend- und Nachtstunden im Winter, wenn PV und Batterie nicht reichen.";

  // Typischer Tag
  const ph = Array.from({ length: 24 }, () => [0, 0, 0]);
  for (const [ts, b, e] of H) { const h = local(ts).h; ph[h][0] += b; ph[h][1] += e; ph[h][2]++; }
  o = oben(base()); o.xAxis.data = ph.map((_, h) => hh(h)); o.xAxis.axisLabel.interval = window.innerWidth < 600 ? 3 : 1;
  o.tooltip.formatter = ps => `<b>${ps[0].name}</b><br>` + ps.map(p => `${punkt(p.color)}${p.seriesName}: ${n2(Math.abs(p.value))} kWh`).join("<br>");
  o.yAxis.axisLabel.formatter = v => nf1.format(Math.abs(v));
  o.series = [saeule("Bezug", ph.map(x => x[2] ? r3(x[0] / x[2]) : null), FB.netz, "x", true), saeule("Einspeisung", ph.map(x => x[2] ? -r3(x[1] / x[2]) : null), FB.einsp, "x", false)];
  chart("nz-c-profil", o);
  setTable("nz-c-profil", ["Stunde", "Ø Bezug kWh", "Ø Einspeisung kWh"], ph.map((x, h) => [hh(h), n2(x[2] ? x[0] / x[2] : null), n2(x[2] ? x[1] / x[2] : null)]));
}

// ---------- Bereich: PV und Batterie ----------
function bPV() {
  const T = bTage().filter(t => t.pv != null);
  const pv = summe(T, t => t.pv), lad = summe(T, t => t.lad), entl = summe(T, t => t.entl);
  let best = null; for (const t of T) if (!best || t.pv > best.pv) best = t;
  $m("pv-kpis").innerHTML =
    kpi("Erzeugung", nk(pv), "kWh", `${T.length} Tage`) +
    kpi("Spezifischer Ertrag", B.kwp && pv ? nk(pv / B.kwp) : "–", "kWh/kWp", B.kwp ? `${new Intl.NumberFormat("de-AT", { maximumFractionDigits: 3 }).format(B.kwp)} kWp` : "Anlagenleistung nicht hinterlegt") +
    kpi("Bester Tag", best ? n1(best.pv) : "–", "kWh", best ? dateStr(best.y, best.m, best.d) : "") +
    kpi("Batterie geladen", nk(lad), "kWh", "") +
    kpi("Batterie entladen", nk(entl), "kWh", lad ? `${nf0.format(entl / lad * 100)} % der Ladung` : "");

  // Jahresvergleich (alle Jahre, unabhängig vom Zeitraum)
  const J = new Map();
  for (const t of B.tage || []) if (t.pv != null) { const a = J.get(t.y) || Array(12).fill(null); a[t.m] = (a[t.m] || 0) + t.pv; J.set(t.y, a); }
  const jahre = [...J.keys()].sort(), jahrFarben = [FB.pv, FB.netz, FB.bat, FB.wb, FB.einsp];   // neuestes Jahr zuerst
  let o = oben(base()); o.xAxis.data = MONATE; o.xAxis.axisLabel.interval = 0;
  o.tooltip.formatter = ps => `<b>${MONATE_LANG[ps[0].dataIndex]}</b><br>` + ps.filter(p => p.value != null).map(p => `${punkt(p.color)}${p.seriesName}: ${nk(p.value)} kWh`).join("<br>");
  o.series = jahre.map((y, i) => {
    const alter = jahre.length - 1 - i, c = alter < jahrFarben.length ? css(jahrFarben[alter]) : css("--axis");
    const letzt = alter === 0;
    return { type: "line", name: String(y), data: J.get(y).map(r1), symbol: "circle", symbolSize: letzt ? 7 : 5, lineStyle: { width: letzt ? 3 : 2, color: c }, itemStyle: { color: c }, z: letzt ? 3 : 2 };
  });
  chart("pv-c-jahre", o);
  setTable("pv-c-jahre", ["Monat", ...jahre.map(String)], MONATE_LANG.map((m, i) => [m, ...jahre.map(y => nk(J.get(y)[i]))]));

  // Tageswerte
  if (!T.length) { keineDaten("pv-c-tage"); keineDaten("pv-c-bat"); return; }
  o = oben(base(), false); o.xAxis.data = T.map(t => `${pad2(t.d)}.${pad2(t.m + 1)}.${String(t.y).slice(2)}`);
  o.xAxis.axisLabel.interval = T.length > 120 ? (i => T[i].d === 1 && T[i].m % 3 === 0) : T.length > 40 ? (i => T[i].d === 1) : "auto";
  o.xAxis.axisLabel.formatter = (v, i) => T.length > 40 ? `${MONATE[T[i].m]} ${String(T[i].y).slice(2)}` : v;
  o.tooltip.formatter = ps => `<b>${ps[0].name}</b><br>${punkt(ps[0].color)}${n1(ps[0].value)} kWh`;
  o.series = [{ type: "bar", name: "Erzeugung", data: T.map(t => r1(t.pv)), barMaxWidth: 10, barCategoryGap: "20%", itemStyle: { color: css(FB.pv), borderRadius: [2, 2, 0, 0] } }];
  chart("pv-c-tage", o);
  setTable("pv-c-tage", ["Tag", "Erzeugung", "Verbrauch", "Eigenverbrauch", "Einspeisung", "Batterie laden", "entladen"],
    [...T].reverse().map(t => [dateStr(t.y, t.m, t.d), n1(t.pv), n1(t.verbr), n1(t.eigen), n1(t.pein), n1(t.lad), n1(t.entl)]));

  const M = monatsListe(T);
  o = oben(base()); monatsAchse(o, M); o.tooltip.formatter = monatsTip(M, v => nk(v) + " kWh");
  o.series = [saeule("geladen", M.map(e => r1(summe(e.tage, t => t.lad))), FB.bat), saeule("entladen", M.map(e => r1(summe(e.tage, t => t.entl))), FB.netz)];
  chart("pv-c-bat", o);
  setTable("pv-c-bat", ["Monat", "geladen kWh", "entladen kWh", "Verhältnis"],
    M.map(e => { const l = summe(e.tage, t => t.lad), x = summe(e.tage, t => t.entl); return [e.ttl, nk(l), nk(x), l ? nf0.format(x / l * 100) + " %" : "–"]; }));
}

// ---------- Sonnenstunden (GeoSphere Poysdorf Ost) und Abgleich mit dem PV-Ertrag ----------
B.so = { raster: "monat", daten: null };
try { B.so.raster = localStorage.getItem("so-raster") || "monat"; } catch (_) {}
async function soLaden() {
  if (B.so.daten === null) {
    try { const r = await fetch("data/sonne.json", { cache: "no-store" }); B.so.daten = r.ok ? await r.json() : false; } catch (_) { B.so.daten = false; }
  }
  return B.so.daten;
}
async function bSonne() {
  const S = await soLaden();
  const ids = ["so-c-sonne", "so-c-pv", "so-c-streu"];
  if (!S) { ids.forEach(id => keineDaten(id, "Wetterdaten (data/sonne.json) nicht verfügbar")); return; }
  $m("so-raster").querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", b.dataset.v === B.so.raster));
  // Tage im Zeitraum: Wetter + PV zusammenführen
  const pvTag = new Map((B.tage || []).map(t => [t.tag, t.pv]));
  const z = bZeit();
  const T = [];
  for (const [tag, so, gl, tl] of S.tage) {
    const [y, mo, d] = tag.split("-").map(Number);
    if (!(y * 12 + mo - 1 >= z.a && y * 12 + mo - 1 <= z.b)) continue;
    T.push({ tag, y, m: mo - 1, d, so, gl: gl == null ? null : gl / 360, tl, pv: pvTag.has(tag) ? pvTag.get(tag) : null });   // gl: J/cm² → kWh/m²
  }
  if (!T.length) { ids.forEach(id => keineDaten(id)); $m("so-tage").innerHTML = ""; return; }
  // Anlagenfaktor: PV-kWh je kWh/m² Globalstrahlung (robuster Median der Tagesverhältnisse bei nennenswerter Strahlung)
  const q = T.filter(t => t.pv != null && t.gl != null && t.gl > 1.5).map(t => t.pv / t.gl).sort((a, b) => a - b);
  const faktor = q.length ? q[Math.floor(q.length * 0.6)] : null;     // 60. Perzentil ≈ Tage ohne Störung
  for (const t of T) t.erw = faktor != null && t.gl != null ? t.gl * faktor : null;
  // Gruppierung
  const r = B.so.raster;
  const gruppe = t => {
    if (r === "tag") return { k: t.tag, l: `${pad2(t.d)}.${pad2(t.m + 1)}.${String(t.y).slice(2)}`, lang: dateStr(t.y, t.m, t.d) };
    if (r === "woche") { const w = isoWoche(t.y, t.m, t.d); return { k: `${w.j}-${pad2(w.kw)}`, l: `KW ${w.kw}`, lang: `KW ${w.kw}/${w.j}` }; }
    return { k: `${t.y}-${pad2(t.m + 1)}`, l: `${MONATE[t.m]} ${String(t.y).slice(2)}`, lang: `${MONATE_LANG[t.m]} ${t.y}` };
  };
  const G = new Map();
  for (const t of T) { const g = gruppe(t); let e = G.get(g.k); if (!e) { e = { ...g, tage: [] }; G.set(g.k, e); } e.tage.push(t); }
  const L = [...G.values()];
  for (const e of L) {
    e.so = summe(e.tage, t => t.so); e.gl = summe(e.tage, t => t.gl); e.pv = summe(e.tage, t => t.pv); e.erw = summe(e.tage.filter(t => t.pv != null), t => t.erw);
    e.n = e.tage.filter(t => t.so != null).length; e.nPv = e.tage.filter(t => t.pv != null).length;
  }
  const achse = o => {
    o.xAxis.data = L.map(e => e.l);
    if (r === "tag") { o.xAxis.axisLabel.interval = L.length > 120 ? (i => L[i].tage[0].d === 1 && L[i].tage[0].m % 3 === 0) : L.length > 40 ? (i => L[i].tage[0].d === 1) : "auto"; o.xAxis.axisLabel.formatter = (v, i) => L.length > 40 ? `${MONATE[L[i].tage[0].m]} ${String(L[i].tage[0].y).slice(2)}` : v; }
    else if (r === "woche") { o.xAxis.axisLabel.interval = L.length > 30 ? (i => L[i].tage.some(t => t.d <= 7) && L[i].tage[0].m % (L.length > 80 ? 3 : 1) === 0) : "auto"; if (L.length > 30) o.xAxis.axisLabel.formatter = (v, i) => `${MONATE[L[i].tage[L[i].tage.length - 1].m]} ${String(L[i].tage[0].y).slice(2)}`; }
    else monatsAchse(o, L.map(e => ({ ttl: e.l, m: e.tage[0].m, y: e.tage[0].y })));
    if (r !== "monat" && L.length > 62) { o.grid.bottom = 44; o.dataZoom = [{ type: "inside" }, { type: "slider", height: 18, bottom: 6, borderColor: css("--border"), fillerColor: css("--accent-wash"), handleStyle: { color: css("--surface"), borderColor: css("--axis") }, textStyle: { color: css("--muted"), fontSize: 11 }, dataBackground: { lineStyle: { color: css("--axis") }, areaStyle: { color: css("--grid") } } }]; }
  };
  const einheit = r === "tag" ? "h" : "h";
  // 1) Sonnenstunden
  let o = oben(base(), false); achse(o);
  o.tooltip.formatter = ps => { const e = L[ps[0].dataIndex]; return `<b>${e.lang}</b><br>${punkt(css(FB.pv))}Sonnenstunden: ${n1(e.so)} h${r !== "tag" ? ` (Ø ${n1(e.so / Math.max(e.n, 1))} h/Tag)` : ""}<br><span style="color:${css("--muted")}">Globalstrahlung ${n1(e.gl)} kWh/m²${e.tage[0].tl != null && r === "tag" ? ` · Ø ${n1(e.tage[0].tl)} °C` : ""}</span>`; };
  o.series = [{ type: "bar", name: "Sonnenstunden", data: L.map(e => r1(e.so)), barMaxWidth: r === "tag" ? 10 : 36, barCategoryGap: "20%", itemStyle: { color: css(FB.pv), borderRadius: [3, 3, 0, 0] } }];
  chart("so-c-sonne", o);
  setTable("so-c-sonne", [r === "tag" ? "Tag" : r === "woche" ? "Woche" : "Monat", "Sonnenstunden", "Ø h je Tag", "Globalstrahlung kWh/m²", "Ø Temperatur °C"],
    L.map(e => [e.lang, n1(e.so), n1(e.so / Math.max(e.n, 1)), n1(e.gl), n1(summe(e.tage, t => t.tl) / Math.max(e.tage.filter(t => t.tl != null).length, 1))]));
  const soSum = summe(T, t => t.so), nSo = T.filter(t => t.so != null).length, bestTag = T.reduce((x, t) => (t.so != null && (x == null || t.so > x.so)) ? t : x, null);
  $m("n-so-c-sonne").textContent = `${zeitText()}: ${nf0.format(soSum)} Sonnenstunden an ${nSo} Tagen, Ø ${n1(soSum / Math.max(nSo, 1))} h je Tag` + (bestTag ? `, Maximum ${n1(bestTag.so)} h am ${dateStr(bestTag.y, bestTag.m, bestTag.d)}.` : ".");
  // 2) PV gemessen vs. erwartet
  o = oben(base()); achse(o);
  o.tooltip.formatter = ps => { const e = L[ps[0].dataIndex]; const dv = e.pv != null && e.erw ? (e.pv / e.erw - 1) * 100 : null; return `<b>${e.lang}</b><br>` + ps.filter(p => p.value != null).map(p => `${punkt(p.color)}${p.seriesName}: ${nk(p.value)} kWh`).join("<br>") + (dv != null ? `<br><span style="color:${css("--muted")}">${pz(dv)} gegenüber Erwartung</span>` : ""); };
  o.series = [{ type: "bar", name: "PV gemessen", data: L.map(e => e.pv == null ? null : r1(e.pv)), barMaxWidth: r === "tag" ? 10 : 36, barCategoryGap: "20%", itemStyle: { color: css(FB.pv), borderRadius: [3, 3, 0, 0] } },
    { type: "line", name: "aus Globalstrahlung erwartet", data: L.map(e => e.erw == null ? null : r1(e.erw)), step: r === "tag" ? false : "middle", showSymbol: false, lineStyle: { width: 2, color: css(FB.netz) }, itemStyle: { color: css(FB.netz) }, z: 3 }];
  chart("so-c-pv", o);
  setTable("so-c-pv", [r === "tag" ? "Tag" : r === "woche" ? "Woche" : "Monat", "PV kWh", "erwartet kWh", "Abweichung", "Sonnenstunden", "kWh je Sonnenstunde"],
    L.map(e => [e.lang, nk(e.pv), nk(e.erw), e.pv != null && e.erw ? pz((e.pv / e.erw - 1) * 100) : "–", n1(e.so), e.so ? n1(e.pv / e.so) : "–"]));
  const mitPv = T.filter(t => t.pv != null && t.erw != null);
  const sPv = summe(mitPv, t => t.pv), sErw = summe(mitPv, t => t.erw), sSo = summe(mitPv, t => t.so);
  // Korrelation Tageswerte
  const xs = mitPv.filter(t => t.so != null).map(t => t.so), ys = mitPv.filter(t => t.so != null).map(t => t.pv);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const rKorr = sxx && syy ? sxy / Math.sqrt(sxx * syy) : null, steig = sxx ? sxy / sxx : 0, achs = my - steig * mx;
  $m("n-so-c-pv").textContent = mitPv.length ? `${mitPv.length} Tage mit PV- und Wetterdaten: ${nk(sPv)} kWh gemessen, ${nk(sErw)} kWh aus der Globalstrahlung erwartet (${pz((sPv / sErw - 1) * 100)}). ` +
    `Anlagenfaktor ${n2(faktor)} kWh je kWh/m²${B.kwp ? ` (${nf0.format(faktor / B.kwp * 100)} % Performance Ratio)` : ""}, ${n1(sPv / sSo)} kWh je Sonnenstunde, Korrelation Tagesertrag–Sonnenstunden r = ${n2(rKorr)}.` : "Keine überlappenden PV- und Wetterdaten im Zeitraum.";
  // 3) Streudiagramm Tag
  o = base(); o.grid = { left: 8, right: 16, top: 28, bottom: 30, containLabel: true }; o.tooltip.trigger = "item"; o.tooltip.axisPointer = undefined;
  o.xAxis = { type: "value", name: "Sonnenstunden je Tag", nameLocation: "middle", nameGap: 26, nameTextStyle: { color: css("--muted"), fontSize: 11 }, min: 0, max: 16, interval: 4, axisLabel: { color: css("--muted"), fontSize: 11 }, splitLine: { lineStyle: { color: css("--grid") } } };
  o.yAxis.name = "kWh"; o.yAxis.nameTextStyle = { color: css("--muted"), fontSize: 11 };
  o.tooltip.formatter = p => p.seriesType === "line" ? "" : `<b>${p.data[2]}</b><br>${n1(p.data[0])} h Sonne · ${nk(p.data[1])} kWh${p.data[3] != null ? `<br><span style="color:${css("--muted")}">erwartet ${nk(p.data[3])} kWh</span>` : ""}`;
  const sommer = t => t.m >= 3 && t.m <= 8;
  const pt = f => mitPv.filter(t => t.so != null && f(t)).map(t => [r1(t.so), r1(t.pv), dateStr(t.y, t.m, t.d), r1(t.erw)]);
  o.series = [
    { type: "scatter", name: "Apr–Sep", data: pt(sommer), symbolSize: 7, itemStyle: { color: css(FB.pv), opacity: 0.75 } },
    { type: "scatter", name: "Okt–Mär", data: pt(t => !sommer(t)), symbolSize: 7, itemStyle: { color: css(FB.netz), opacity: 0.75 } },
    { type: "line", name: "Trend", data: [[0, r1(achs)], [16, r1(achs + 16 * steig)]], showSymbol: false, lineStyle: { color: css("--text-2"), width: 1.5, type: "dashed" }, silent: true },
  ];
  o.legend = { top: 0, right: 0, icon: "circle", itemWidth: 8, itemHeight: 8, textStyle: { color: css("--text-2"), fontSize: 12 }, data: ["Apr–Sep", "Okt–Mär"] };
  chart("so-c-streu", o);
  // 4) Auffällige Tage
  const auff = mitPv.filter(t => t.gl != null && t.gl >= 2 && t.erw > 5).map(t => ({ t, d: t.pv / t.erw - 1 })).filter(x => x.d < -0.35).sort((a, b) => a.d - b.d).slice(0, 15);
  $m("so-tage").innerHTML = auff.length ? `<table><thead><tr><th>Tag</th><th>Sonne h</th><th>Strahlung kWh/m²</th><th>Ø °C</th><th>PV kWh</th><th>erwartet</th><th>Abw.</th><th></th></tr></thead><tbody>${
    auff.map(({ t, d }) => `<tr><td>${dateStr(t.y, t.m, t.d)} ${WOCHENTAGE[new Date(t.y, t.m, t.d).getDay()]}</td><td>${n1(t.so)}</td><td>${n1(t.gl)}</td><td>${n1(t.tl)}</td><td>${n1(t.pv)}</td><td>${n1(t.erw)}</td><td>${pz(d * 100)}</td><td><button class="tbl-btn" type="button" data-zum-tag="${t.tag}">Tag</button></td></tr>`).join("")}</tbody></table>`
    : `<p class="note">Keine Tage mit deutlich zu geringem Ertrag im Zeitraum.</p>`;
}

// ---------- Bereich: Wallboxen ----------
function ladungPreis(l) {
  const a = Date.parse(l.start) / 1000; let b = l.ende ? Date.parse(l.ende) / 1000 : a + (l.kwh || 0) / 11 * 3600;
  if (!(b > a)) b = a + 3600;
  let s = 0, n = 0;
  for (let h = Math.floor(a / 3600) * 3600; h < b; h += 3600) { const p = epexAt(h); if (p != null) { const w = Math.min(b, h + 3600) - Math.max(a, h); s += p * w; n += w; } }
  return n ? s / n : null;
}
function bWallbox() {
  const L = (B.laden || []).map(l => { const t = Math.floor(Date.parse(l.start) / 1000); return { ...l, ts: t, L: local(t), name: l.wallbox || String(l.wallbox_id) }; })
    .filter(l => bImZeitraum(l.L.y, l.L.m) && (l.kwh || 0) > 0.05);
  const namen = [...new Set((B.laden || []).map(l => l.wallbox || String(l.wallbox_id)))].sort();
  const farbe = n => [FB.wb, FB.netz, FB.pv, FB.einsp][namen.indexOf(n) % 4];
  for (const l of L) l.preis = ladungPreis(l);
  const ges = summe(L, l => l.kwh) || 0;
  const pw = (() => { let s = 0, w = 0; for (const l of L) if (l.preis != null) { s += l.preis * l.kwh; w += l.kwh; } return w ? s / w : null; })();
  let k = kpi("Geladen", nk(ges), "kWh", `${nf0.format(L.length)} Ladevorgänge`);
  for (const n of namen) { const x = L.filter(l => l.name === n); k += kpi(n, nk(summe(x, l => l.kwh)), "kWh", `${x.length} Ladungen, Ø ${n1(x.length ? summe(x, l => l.kwh) / x.length : null)} kWh`); }
  k += kpi("Ø Börsenpreis beim Laden", fmt(pw), "ct", "netto, nach kWh gewichtet");
  $m("wb-kpis").innerHTML = k;
  $m("wb-anzahl").textContent = L.length ? `${L.length} im Zeitraum` : "";
  if (!L.length) { keineDaten("wb-c-monat", "Keine Ladevorgänge im Zeitraum (Daten ab 03/2026)"); keineDaten("wb-c-uhr"); keineDaten("wb-c-preis"); $m("wb-liste").innerHTML = ""; $m("n-wb-c-preis").textContent = ""; return; }

  // je Monat
  const MM = new Map();
  for (const l of L) { const kk = l.L.y * 12 + l.L.m; let e = MM.get(kk); if (!e) { e = { k: kk, y: l.L.y, m: l.L.m, ttl: `${MONATE[l.L.m]} ${String(l.L.y).slice(2)}`, l: [] }; MM.set(kk, e); } e.l.push(l); }
  const M = [...MM.values()].sort((a, b) => a.k - b.k);
  let o = oben(base()); monatsAchse(o, M); o.tooltip.formatter = monatsTip(M, v => nk(v) + " kWh");
  o.series = namen.map((n, i) => saeule(n, M.map(e => r1(summe(e.l.filter(l => l.name === n), l => l.kwh))), farbe(n), "s", i === namen.length - 1));
  chart("wb-c-monat", o);
  setTable("wb-c-monat", ["Monat", ...namen, "gesamt", "Ladungen"], M.map(e => [e.ttl, ...namen.map(n => nk(summe(e.l.filter(l => l.name === n), l => l.kwh))), nk(summe(e.l, l => l.kwh)), e.l.length]));

  // Ladebeginn nach Uhrzeit
  o = oben(base()); o.xAxis.data = Array.from({ length: 24 }, (_, h) => hh(h)); o.xAxis.axisLabel.interval = window.innerWidth < 600 ? 3 : 2;
  o.tooltip.formatter = ps => `<b>Start ${ps[0].name}</b><br>` + ps.filter(p => p.value).map(p => `${punkt(p.color)}${p.seriesName}: ${nk(p.value)} kWh`).join("<br>");
  o.series = namen.map((n, i) => saeule(n, Array.from({ length: 24 }, (_, h) => r1(summe(L.filter(l => l.name === n && l.L.h === h), l => l.kwh)) || 0), farbe(n), "s", i === namen.length - 1));
  chart("wb-c-uhr", o);
  setTable("wb-c-uhr", ["Startstunde", ...namen], Array.from({ length: 24 }, (_, h) => [hh(h), ...namen.map(n => nk(summe(L.filter(l => l.name === n && l.L.h === h), l => l.kwh)))]));

  // Börsenpreis beim Laden vs. Monatsschnitt
  const monatsSchnitt = (y, m) => { let s = 0, n = 0; if (D) for (let i = 0; i < D.n; i++) if (D.y[i] === y && D.m[i] === m && !Number.isNaN(D.v[i])) { s += D.v[i]; n++; } return n ? s / n : null; };
  const lw = M.map(e => { let s = 0, w = 0; for (const l of e.l) if (l.preis != null) { s += l.preis * l.kwh; w += l.kwh; } return w ? s / w : null; });
  const ms = M.map(e => monatsSchnitt(e.y, e.m));
  o = oben(base()); monatsAchse(o, M); o.tooltip.formatter = monatsTip(M, v => fmt(v) + " ct");
  o.series = [linie("beim Laden", lw.map(v => v == null ? null : +v.toFixed(2)), FB.wb), linie("Monatsschnitt Börse", ms.map(v => v == null ? null : +v.toFixed(2)), "--muted", { dash: true })];
  chart("wb-c-preis", o);
  setTable("wb-c-preis", ["Monat", "Ø beim Laden", "Ø Börse", "Differenz"], M.map((e, i) => [e.ttl, fmt(lw[i]), fmt(ms[i]), lw[i] != null && ms[i] != null ? (lw[i] - ms[i] >= 0 ? "+" : "") + nf2.format(lw[i] - ms[i]) : "–"]));
  const gsch = (() => { let s = 0, w = 0; M.forEach((e, i) => { if (ms[i] != null) { const kw = summe(e.l, l => l.kwh); s += ms[i] * kw; w += kw; } }); return w ? s / w : null; })();
  $m("n-wb-c-preis").textContent = pw != null && gsch != null
    ? (pw <= gsch ? `Du lädst im Schnitt ${nf2.format(gsch - pw)} ct/kWh unter dem Monatsschnitt der Börse.` : `Du lädst im Schnitt ${nf2.format(pw - gsch)} ct/kWh über dem Monatsschnitt der Börse. Mit gezieltem Laden in billigen Stunden ginge es günstiger.`)
    : "";

  // Liste
  const dauer = l => l.ende ? Math.round((Date.parse(l.ende) - Date.parse(l.start)) / 60000) : null;
  const uhr = t => new Date(t).toLocaleTimeString("de-AT", { timeZone: "Europe/Vienna", hour: "2-digit", minute: "2-digit" });
  $m("wb-liste").innerHTML = `<table><thead><tr><th>Beginn</th><th>Wallbox</th><th>kWh</th><th>Dauer</th><th>Ende</th><th>Ø Börse ct</th><th>Akku %</th></tr></thead><tbody>${
    [...L].reverse().map(l => { const m = dauer(l); return `<tr><td>${dateStr(l.L.y, l.L.m, l.L.d)} ${hh(l.L.h).slice(0, 2)}:${pad2(new Date(l.ts * 1000).getUTCMinutes())}</td><td>${esc(l.name)}</td><td>${n1(l.kwh)}</td><td>${m == null ? "–" : `${Math.floor(m / 60)}:${pad2(m % 60)} h`}</td><td>${l.ende ? uhr(l.ende) : "–"}</td><td>${fmt(l.preis)}</td><td>${l.soc_start != null ? `${l.soc_start} → ${l.soc_ende ?? "?"}` : "–"}</td></tr>`; }).join("")}</tbody></table>`;
}

// ---------- Bereich: Kosten und Börse ----------
async function bKosten() {
  const H = await bNetzStunden();
  // Monatswerte: zeitgewichtet, bezugsgewichtet, einspeisegewichtet
  const MM = new Map();
  for (const [ts, b, e] of H) {
    const p = epexAt(ts); if (p == null) continue;
    const L = local(ts), k = L.y * 12 + L.m;
    let x = MM.get(k); if (!x) { x = { k, y: L.y, m: L.m, ttl: `${MONATE[L.m]} ${String(L.y).slice(2)}`, ps: 0, n: 0, pb: 0, b: 0, pe: 0, e: 0, neg: 0, negE: 0 }; MM.set(k, x); }
    x.ps += p; x.n++; x.pb += p * b; x.b += b; x.pe += p * e; x.e += e; if (p < 0) { x.neg++; x.negE += e; }
  }
  const M = [...MM.values()].sort((a, b) => a.k - b.k);
  const S = M.reduce((a, x) => { for (const f of ["ps", "n", "pb", "b", "pe", "e", "neg", "negE"]) a[f] += x[f]; return a; }, { ps: 0, n: 0, pb: 0, b: 0, pe: 0, e: 0, neg: 0, negE: 0 });
  if (!M.length) keineDaten("kb-c-preis", "Keine Netz-NÖ-Werte im Zeitraum");
  else {
    const o = oben(base()); monatsAchse(o, M); o.tooltip.formatter = monatsTip(M, v => fmt(v) + " ct");
    o.series = [linie("Börse Ø", M.map(x => +(x.ps / x.n).toFixed(2)), "--muted", { dash: true }),
      linie("dein Bezug", M.map(x => x.b ? +(x.pb / x.b).toFixed(2) : null), FB.netz), linie("deine Einspeisung", M.map(x => x.e > 1 ? +(x.pe / x.e).toFixed(2) : null), FB.einsp)];
    chart("kb-c-preis", o);
    setTable("kb-c-preis", ["Monat", "Börse Ø", "Ø bei deinem Bezug", "Ø bei deiner Einspeisung", "Stunden < 0 ct", "Einspeisung bei < 0 ct kWh"],
      M.map(x => [x.ttl, fmt(x.ps / x.n), fmt(x.b ? x.pb / x.b : null), fmt(x.e > 1 ? x.pe / x.e : null), x.neg, n1(x.negE)]));
    const sb = S.b ? S.pb / S.b : null, se = S.e ? S.pe / S.e : null, sd = S.n ? S.ps / S.n : null;
    $m("n-kb-c-preis").textContent = sd == null ? "" :
      `${zeitText()}: Börse Ø ${fmt(sd)} ct. Dein Bezug fiel im Schnitt auf Stunden mit ${fmt(sb)} ct (${sb >= sd ? "+" : ""}${nf2.format(sb - sd)}), ` +
      `deine Einspeisung auf Stunden mit ${fmt(se)} ct (${se >= sd ? "+" : ""}${nf2.format(se - sd)}). ` +
      (S.negE > 0.5 ? `${nk(S.negE)} kWh hast du bei negativen Börsenpreisen eingespeist.` : "");
  }
  // Tagesverlauf Börse (Zeitraum) und Bezug
  const [von, bis] = bGrenzen();
  const pp = Array.from({ length: 24 }, () => [0, 0]);
  if (D) for (let i = 0; i < D.n; i++) if (D.ts[i] >= von && D.ts[i] < bis && !Number.isNaN(D.v[i])) { pp[D.h[i]][0] += D.v[i]; pp[D.h[i]][1]++; }
  let o = oben(base(), false); o.xAxis.data = pp.map((_, h) => hh(h)); o.xAxis.axisLabel.interval = window.innerWidth < 600 ? 3 : 2;
  o.tooltip.formatter = ps => `<b>${ps[0].name}</b><br>Ø ${fmt(ps[0].value)} ct/kWh netto`;
  o.series = [linie("Börse", pp.map(x => x[1] ? +(x[0] / x[1]).toFixed(2) : null), FB.netz, { extra: { areaStyle: { color: css("--accent-wash") }, showSymbol: false } })];
  chart("kb-c-tp", o);
  setTable("kb-c-tp", ["Stunde", "Ø ct/kWh netto"], pp.map((x, h) => [hh(h), fmt(x[1] ? x[0] / x[1] : null)]));
  const pl = Array.from({ length: 24 }, () => [0, 0]);
  for (const [ts, b] of H) { const h = local(ts).h; pl[h][0] += b; pl[h][1]++; }
  o = oben(base(), false); o.xAxis.data = pl.map((_, h) => hh(h)); o.xAxis.axisLabel.interval = window.innerWidth < 600 ? 3 : 2;
  o.tooltip.formatter = ps => `<b>${ps[0].name}</b><br>Ø ${n2(ps[0].value)} kWh`;
  o.series = [saeule("Bezug", pl.map(x => x[1] ? r3(x[0] / x[1]) : null), FB.netz)];
  chart("kb-c-tl", o);
  setTable("kb-c-tl", ["Stunde", "Ø kWh"], pl.map((x, h) => [hh(h), n2(x[1] ? x[0] / x[1] : null)]));
  bFlexPreis();
  // eFriends-Abrechnung und Tarifvergleich (bestehende Diagramme)
  msKosten();
}

// ---------- Dein Flex-Preis: Tagesmittel mit Wochen-/Monats-/Jahresmittel ----------
B.fp = { von: null, bis: null, eigen: false, raster: "monat" };
try { B.fp.raster = localStorage.getItem("fp-raster") || "monat"; } catch (_) {}
function isoWoche(y, m, d) {
  const t = new Date(Date.UTC(y, m, d)), wd = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - wd + 3);                       // Donnerstag derselben Woche
  const j = t.getUTCFullYear(), f = new Date(Date.UTC(j, 0, 4));
  return { j, kw: 1 + Math.round(((t - f) / 864e5 - 3 + (f.getUTCDay() + 6) % 7) / 7) };
}
function fpStandard() {
  const z = bZeit(), last = local(D.ts[D.n - 1]);
  const start = MS.tarife.length ? MS.tarife[0].gueltig_ab : "2021-01-01";
  const [sy, sm] = start.split("-").map(Number);
  const a = Math.max(z.a, sy * 12 + sm - 1, D.y[0] * 12 + D.m[0]), b = Math.min(z.b, last.y * 12 + last.m);
  const von = isoTag(Math.floor(a / 12), a % 12, a === sy * 12 + sm - 1 ? +start.slice(8, 10) : 1);
  const bisMon = new Date(Date.UTC(Math.floor(b / 12), b % 12 + 1, 0));
  let bis = isoTag(bisMon.getUTCFullYear(), bisMon.getUTCMonth(), bisMon.getUTCDate());
  const lastTag = isoTag(last.y, last.m, last.d);
  if (bis > lastTag) bis = lastTag;
  return [von, bis];
}
function bFlexPreis() {
  if (!D) return;
  const last = local(D.ts[D.n - 1]);
  const vonIn = $m("fp-von"), bisIn = $m("fp-bis");
  vonIn.min = bisIn.min = isoTag(D.y[0], D.m[0], D.d[0]); vonIn.max = bisIn.max = isoTag(last.y, last.m, last.d);
  if (!B.fp.eigen || !B.fp.von) [B.fp.von, B.fp.bis] = fpStandard();
  if (B.fp.von > B.fp.bis) [B.fp.von, B.fp.bis] = [B.fp.bis, B.fp.von];
  vonIn.value = B.fp.von; bisIn.value = B.fp.bis;
  $m("fp-reset").hidden = !B.fp.eigen;
  $m("fp-raster").querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", b.dataset.v === B.fp.raster));

  // Tagesmittel aus den Stundenpreisen
  const [y0, m0, d0] = B.fp.von.split("-").map(Number), [y1, m1, d1] = B.fp.bis.split("-").map(Number);
  const a = wienMitternacht(y0, m0 - 1, d0), b = wienMitternacht(y1, m1 - 1, d1 + 1);
  let i = 0; { let lo = 0, hi = D.n; while (lo < hi) { const mid = (lo + hi) >> 1; if (D.ts[mid] < a) lo = mid + 1; else hi = mid; } i = lo; }
  const tage = [], idx = new Map();
  let exakt = 0, std = 0;
  for (; i < D.n && D.ts[i] < b; i++) {
    const p = Number.isNaN(D.v[i]) ? null : D.v[i];
    const pr = msPreise(D.ts[i], tarifFuer(D.y[i], D.m[i]), p);
    if (pr.bez == null) continue;
    const k = dayKey(D.y[i], D.m[i], D.d[i]);
    let t = idx.get(k);
    if (!t) { t = { y: D.y[i], m: D.m[i], d: D.d[i], s: 0, n: 0, b: 0, bn: 0, min: Infinity, max: -Infinity }; idx.set(k, t); tage.push(t); }
    t.s += pr.bez; t.n++; if (pr.bez < t.min) t.min = pr.bez; if (pr.bez > t.max) t.max = pr.bez;
    if (p != null) { t.b += p; t.bn++; }
    std++; if (pr.exakt) exakt++;
  }
  if (!tage.length) { keineDaten("fp-c", "Keine Preise im gewählten Zeitraum"); $m("n-fp-c").textContent = ""; return; }
  for (const t of tage) { t.mw = t.s / t.n; t.boerse = t.bn ? t.b / t.bn : null; }

  // Gruppen (Woche / Monat / Jahr)
  const r = B.fp.raster;
  const gruppe = t => {
    if (r === "woche") { const w = isoWoche(t.y, t.m, t.d); return { k: w.j * 100 + w.kw, l: `KW ${w.kw}/${String(w.j).slice(2)}` }; }
    if (r === "jahr") return { k: t.y, l: String(t.y) };
    return { k: t.y * 12 + t.m, l: `${MONATE_LANG[t.m]} ${t.y}` };
  };
  const G = new Map();
  for (const t of tage) {
    const g = gruppe(t); t.g = g.k;
    let e = G.get(g.k); if (!e) { e = { l: g.l, tage: [] }; G.set(g.k, e); } e.tage.push(t);
  }
  for (const e of G.values()) {
    e.mw = e.tage.reduce((s, t) => s + t.mw, 0) / e.tage.length;
    const bt = e.tage.filter(t => t.boerse != null); e.boerse = bt.length ? bt.reduce((s, t) => s + t.boerse, 0) / bt.length : null;
    e.min = e.tage.reduce((x, t) => t.mw < x.mw ? t : x); e.max = e.tage.reduce((x, t) => t.mw > x.mw ? t : x);
  }
  const rasterName = { woche: "Woche", monat: "Monat", jahr: "Jahr" }[r];
  const lab = tage.map(t => `${pad2(t.d)}.${pad2(t.m + 1)}.${String(t.y).slice(2)}`);

  const o = oben(base());
  o.grid.bottom = tage.length > 62 ? 44 : 8;
  o.xAxis.data = lab;
  o.xAxis.axisLabel.interval = tage.length > 400 ? (j => tage[j].d === 1 && tage[j].m === 0) : tage.length > 62 ? (j => tage[j].d === 1) : "auto";
  o.xAxis.axisLabel.formatter = (v, j) => tage.length > 400 ? String(tage[j].y) : tage.length > 62 ? `${MONATE[tage[j].m]} ${String(tage[j].y).slice(2)}` : v;
  o.tooltip.formatter = ps => {
    const t = tage[ps[0].dataIndex], g = G.get(t.g);
    return `<b>${WOCHENTAGE[new Date(t.y, t.m, t.d).getDay()]}, ${dateStr(t.y, t.m, t.d)}</b><br>` +
      `${punkt(css(FB.netz))}Tagesmittel: ${fmt(t.mw)} ct<br><span style="color:${css("--muted")}">Stunden ${fmt(t.min)} bis ${fmt(t.max)} ct</span><br>` +
      `${punkt(css(FB.einsp))}Ø ${g.l}: ${fmt(g.mw)} ct`;
  };
  o.series = [
    { type: "line", name: "Tagesmittel", data: tage.map(t => +t.mw.toFixed(2)), showSymbol: false, lineStyle: { width: tage.length > 120 ? 1 : 1.5, color: css(FB.netz) }, itemStyle: { color: css(FB.netz) },
      areaStyle: { color: css("--accent-wash") } },
    { type: "line", name: `Ø je ${rasterName}`, data: tage.map(t => +G.get(t.g).mw.toFixed(2)), step: "middle", showSymbol: false, lineStyle: { width: 2.5, color: css(FB.einsp) }, itemStyle: { color: css(FB.einsp) }, z: 3 },
  ];
  if (tage.length > 62) o.dataZoom = [{ type: "inside" }, { type: "slider", height: 18, bottom: 6, borderColor: css("--border"), fillerColor: css("--accent-wash"),
    handleStyle: { color: css("--surface"), borderColor: css("--axis") }, textStyle: { color: css("--muted"), fontSize: 11 }, dataBackground: { lineStyle: { color: css("--axis") }, areaStyle: { color: css("--grid") } } }];
  chart("fp-c", o);

  const liste = [...G.values()];
  setTable("fp-c", [rasterName, "Tage", "Ø Flex ct brutto", "günstigster Tag", "teuerster Tag", "Ø Börse ct netto"],
    liste.map(e => [e.l, e.tage.length, fmt(e.mw), `${fmt(e.min.mw)} (${pad2(e.min.d)}.${pad2(e.min.m + 1)}.)`, `${fmt(e.max.mw)} (${pad2(e.max.d)}.${pad2(e.max.m + 1)}.)`, fmt(e.boerse)]));
  const gesamt = tage.reduce((s, t) => s + t.mw, 0) / tage.length;
  const tMin = tage.reduce((x, t) => t.mw < x.mw ? t : x), tMax = tage.reduce((x, t) => t.mw > x.mw ? t : x);
  const gMin = liste.reduce((x, e) => e.mw < x.mw ? e : x), gMax = liste.reduce((x, e) => e.mw > x.mw ? e : x);
  $m("n-fp-c").textContent = `${dateStr(y0, m0 - 1, d0)} bis ${dateStr(y1, m1 - 1, d1)}: Ø ${fmt(gesamt)} ct/kWh über ${nf0.format(tage.length)} Tage. ` +
    `Günstigster Tag ${dateStr(tMin.y, tMin.m, tMin.d)} mit ${fmt(tMin.mw)} ct, teuerster ${dateStr(tMax.y, tMax.m, tMax.d)} mit ${fmt(tMax.mw)} ct.` +
    (liste.length > 1 ? ` ${rasterName === "Woche" ? "Günstigste Woche" : rasterName === "Monat" ? "Günstigster Monat" : "Günstigstes Jahr"}: ${gMin.l} (${fmt(gMin.mw)} ct), ` +
      `${rasterName === "Woche" ? "teuerste" : rasterName === "Monat" ? "teuerster" : "teuerstes"}: ${gMax.l} (${fmt(gMax.mw)} ct).` : "") +
    (exakt ? ` ${nf0.format(exakt)} von ${nf0.format(std)} Stunden mit Preisen direkt von eFriends, der Rest nach der Tarifformel gerechnet (stimmt mit den eFriends-Preisen überein).` : "");
}

// ---------- Bereich: Tag im Detail ----------
async function bQuartal(y) {
  if (!B.quartal.has(y)) {
    B.quartal.set(y, fetch(`data/quarter_${y}.json`, { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null));
  }
  return B.quartal.get(y);
}
async function bTag() {
  if (!B.tag) { keineDaten("tg-c-energie"); return; }
  $m("tg-datum").value = B.tag;
  const [y, m, d] = B.tag.split("-").map(Number);
  if (!B.tagDaten.has(B.tag)) {
    const r = await MS.sb.rpc("tag_alle_json", { tag: B.tag });
    if (r.error) throw r.error;
    B.tagDaten.set(B.tag, r.data || []);
  }
  const R = B.tagDaten.get(B.tag);
  const lab = R.map(x => { const L = local(x[0]); return `${pad2(L.h)}:${pad2(new Date(x[0] * 1000).getUTCMinutes())}`; });
  const sp = i => R.map(x => x[i]);
  const s = i => summe(R, x => x[i]);
  const T = (B.tage || []).find(t => t.tag === B.tag);
  $m("tg-hint").textContent = `${WOCHENTAGE_LANG[new Date(y, m - 1, d).getDay()]}, ${d}. ${MONATE_LANG[m - 1]} ${y}`;

  // Preise: Viertelstunden, wenn vorhanden, sonst Stunden
  const q = await bQuartal(y);
  const preis = R.map(x => {
    if (q && x[0] >= q.start_utc) { const i = Math.round((x[0] - q.start_utc) / q.step_s); if (i >= 0 && i < q.values.length && q.values[i] != null) return q.values[i]; }
    return epexAt(Math.floor(x[0] / 3600) * 3600);
  });
  const pAvg = summe(preis, v => v) / Math.max(1, preis.filter(v => v != null).length);
  $m("tg-kpis").innerHTML =
    kpi("PV-Erzeugung", n1(s(5) ?? T?.pv), "kWh", "FusionSolar") +
    kpi("Verbrauch", n1(s(6) ?? T?.verbr), "kWh", "FusionSolar") +
    kpi("Netzbezug", n1(s(1)), "kWh", "Netz NÖ") +
    kpi("Einspeisung", n1(s(2)), "kWh", "Netz NÖ") +
    kpi("Wallboxen", n1(s(9) ?? (T ? T.wbSum : null)), "kWh", s(9) == null && T && T.wbSum ? "aus Ladevorgängen" : "Monta") +
    kpi("Börse Ø", fmt(preis.some(v => v != null) ? pAvg : null), "ct", "netto");

  if (!R.some(x => x.slice(1).some(v => v != null))) {
    for (const id of ["tg-c-energie", "tg-c-netz", "tg-c-abgl"]) keineDaten(id, "Für diesen Tag liegen keine Messwerte vor");
  } else {
    const achse = o => { o.xAxis.data = lab; const st = window.innerWidth < 600 ? 6 : 3; o.xAxis.axisLabel.interval = i => !!lab[i] && lab[i].endsWith(":00") && +lab[i].slice(0, 2) % st === 0; };
    const tipQ = ps => `<b>${ps[0].name}</b><br>` + ps.filter(p => p.value != null).map(p => `${punkt(p.color)}${p.seriesName}: ${n2(Math.abs(p.value))} kWh`).join("<br>");
    const flaeche = (name, data, f) => ({ type: "line", name, data, step: false, showSymbol: false, lineStyle: { width: 1.5, color: css(f) }, itemStyle: { color: css(f) }, areaStyle: { color: css(f), opacity: 0.22 } });
    let o = oben(base()); achse(o); o.tooltip.formatter = tipQ;
    o.series = [flaeche("PV-Erzeugung", sp(5), FB.pv), linie("Verbrauch", sp(6), "--text-2", { extra: { showSymbol: false, lineStyle: { width: 2, color: css("--text-2") } } }), flaeche("Wallboxen", sp(9), FB.wb)];
    chart("tg-c-energie", o);
    setTable("tg-c-energie", ["Zeit", "PV", "Verbrauch", "Wallboxen"], R.map((x, i) => [lab[i], n2(x[5]), n2(x[6]), n2(x[9])]));

    o = oben(base()); achse(o); o.tooltip.formatter = tipQ; o.yAxis.axisLabel.formatter = v => nf1.format(Math.abs(v));
    const neg = a => a.map(v => v == null ? null : -v);
    o.series = [{ ...saeule("Netzbezug", sp(1), FB.netz, "s", true), barCategoryGap: "15%" }, saeule("Batterie entladen", sp(8), FB.bat, "s", true),
      saeule("Einspeisung", neg(sp(2)), FB.einsp, "s", false), { ...saeule("Batterie laden", neg(sp(7)), FB.bat, "s", false), itemStyle: { color: css(FB.bat), opacity: 0.5, borderRadius: [0, 0, 3, 3] } }];
    chart("tg-c-netz", o);
    setTable("tg-c-netz", ["Zeit", "Netzbezug", "Einspeisung", "Batterie laden", "entladen"], R.map((x, i) => [lab[i], n2(x[1]), n2(x[2]), n2(x[7]), n2(x[8])]));

    o = oben(base()); achse(o); o.tooltip.formatter = tipQ;
    o.series = [linie("Netz NÖ", sp(1), FB.netz, { extra: { showSymbol: false } }), linie("eFriends", sp(3), FB.ef, { dash: true, extra: { showSymbol: false } })];
    chart("tg-c-abgl", o);
    setTable("tg-c-abgl", ["Zeit", "Netz NÖ Bezug", "eFriends Bezug", "Netz NÖ Einsp.", "eFriends Einsp."], R.map((x, i) => [lab[i], n2(x[1]), n2(x[3]), n2(x[2]), n2(x[4])]));
    const v = (a, b) => a == null ? "–" : `${n1(a)}${b != null && a != null && b ? ` (${pz((a - b) / b * 100)})` : ""}`;
    $m("n-tg-c-abgl").textContent = `Tagessumme Bezug: Netz NÖ ${n1(s(1))} kWh · eFriends ${v(s(3), s(1))} · FusionSolar ${v(T?.pbez, s(1))}. ` +
      `Einspeisung: Netz NÖ ${n1(s(2))} · eFriends ${v(s(4), s(2))} · FusionSolar ${v(T?.pein, s(2))} kWh.` +
      (T && T.nc < T.soll ? ` Netz NÖ unvollständig (${T.nc} von ${T.soll} Viertelstunden).` : "") + (T && T.ec && T.ec < T.soll ? ` eFriends unvollständig (${T.ec}/${T.soll}).` : "");
  }
  // Börsenpreis
  const o = oben(base(), false); o.xAxis.data = lab; const st = window.innerWidth < 600 ? 6 : 3;
  o.xAxis.axisLabel.interval = i => !!lab[i] && lab[i].endsWith(":00") && +lab[i].slice(0, 2) % st === 0;
  o.tooltip.formatter = ps => `<b>${ps[0].name}</b><br>${fmt(ps[0].value)} ct/kWh netto`;
  o.series = [{ type: "line", step: "start", data: preis.map(v => v == null ? null : +v.toFixed(2)), showSymbol: false, lineStyle: { width: 2, color: css(FB.netz) }, itemStyle: { color: css(FB.netz) },
    markLine: { silent: true, symbol: "none", data: [{ yAxis: 0 }], lineStyle: { color: css("--axis"), width: 1, type: "solid" }, label: { show: false } } }];
  chart("tg-c-preis", o);
  setTable("tg-c-preis", ["Zeit", "ct/kWh netto"], preis.map((v, i) => [lab[i], fmt(v)]));
}

// ---------- Navigation ----------
const BR = { uebersicht: bUebersicht, abgleich: bAbgleich, netz: bNetz, pv: async () => { bPV(); await bSonne(); }, wallbox: bWallbox, kosten: bKosten, tag: bTag, verwaltung: () => {} };
function bZeichnen() {
  if (!B.tage) return;
  if (!BR[B.sec]) B.sec = "uebersicht";
  const sel = $m("ms-zeit"), z = bZeitraeume();
  if (sel.options.length !== z.length) {
    sel.innerHTML = z.map(x => `<option value="${x.v}">${x.l}</option>`).join("");
  }
  if (!z.some(x => x.v === B.zeit)) B.zeit = "m12";
  sel.value = B.zeit;
  document.querySelectorAll("#ms-nav button").forEach(b => b.setAttribute("aria-current", b.dataset.sec === B.sec));
  document.querySelectorAll(".ms-sec").forEach(s => { s.hidden = s.dataset.sec !== B.sec; });
  $m("ms-zeit-feld").hidden = B.sec === "tag" || B.sec === "verwaltung";
  const sec = document.querySelector(`.ms-sec[data-sec="${B.sec}"]`), lauf = (B.lauf = (B.lauf || 0) + 1);
  const t = setTimeout(() => { if (B.lauf === lauf) { sec.classList.add("laedt"); msMsg("ms-app-msg", "Daten werden geladen …"); } }, 300);
  Promise.resolve().then(BR[B.sec]).then(() => {
    requestAnimationFrame(() => sec.querySelectorAll(".chart").forEach(el => charts[el.id] && charts[el.id].resize()));
  }).catch(e => msMsg("ms-app-msg", "Fehler beim Zeichnen: " + e.message, true))
    .finally(() => { clearTimeout(t); sec.classList.remove("laedt"); if (B.lauf === lauf && $m("ms-app-msg").textContent === "Daten werden geladen …") msMsg("ms-app-msg", ""); });
}
function bTagSetzen(tag) { B.tag = tag; B.sec = "tag"; try { localStorage.setItem("ms-sec", "tag"); } catch (_) {} bZeichnen(); window.scrollTo({ top: $m("ms-nav").getBoundingClientRect().top + window.scrollY - 12, behavior: "smooth" }); }
function bInit() {
  $m("ms-nav").addEventListener("click", e => {
    const b = e.target.closest("button[data-sec]"); if (!b) return;
    B.sec = b.dataset.sec; try { localStorage.setItem("ms-sec", B.sec); } catch (_) {}
    b.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    bZeichnen();
  });
  $m("ms-zeit").addEventListener("change", e => { B.zeit = e.target.value; try { localStorage.setItem("ms-zeit", B.zeit); } catch (_) {} bZeichnen(); });
  $m("ab-art").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    $m("ab-art").querySelectorAll("button").forEach(x => x.setAttribute("aria-checked", x === b)); B.abArt = b.dataset.v; bZeichnen();
  });
  $m("ab-tage").addEventListener("click", e => { const b = e.target.closest("[data-zum-tag]"); if (b) bTagSetzen(b.dataset.zumTag); });
  $m("so-tage").addEventListener("click", e => { const b = e.target.closest("[data-zum-tag]"); if (b) bTagSetzen(b.dataset.zumTag); });
  $m("so-raster").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    B.so.raster = b.dataset.v; try { localStorage.setItem("so-raster", B.so.raster); } catch (_) {} bSonne();
  });
  const fpSetzen = () => { const v = $m("fp-von").value, b = $m("fp-bis").value; if (!v || !b) return; B.fp.von = v; B.fp.bis = b; B.fp.eigen = true; bFlexPreis(); };
  $m("fp-von").addEventListener("change", fpSetzen);
  $m("fp-bis").addEventListener("change", fpSetzen);
  $m("fp-reset").addEventListener("click", () => { B.fp.eigen = false; bFlexPreis(); });
  $m("fp-raster").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    B.fp.raster = b.dataset.v; try { localStorage.setItem("fp-raster", B.fp.raster); } catch (_) {} bFlexPreis();
  });
  $m("tg-datum").addEventListener("change", e => { if (e.target.value) { B.tag = e.target.value; bZeichnen(); } });
  const schritt = n => { if (!B.tag) return; const [y, m, d] = B.tag.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); B.tag = isoTag(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()); bZeichnen(); };
  $m("tg-zurueck").addEventListener("click", () => schritt(-1));
  $m("tg-vor").addEventListener("click", () => schritt(1));
}
bInit();
