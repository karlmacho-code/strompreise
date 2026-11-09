/* "Mein Strom": persönlicher Bereich mit Login (Supabase). Nutzt Hilfsfunktionen aus app.js. */
"use strict";

const MS = {
  sb: null, user: null, recovery: false,
  flex: new Map(),  // ts -> [bezug_ct_netto, einspeise_ct_netto] (exakt aus eFriends-API)
  hours: null,      // Array [ts, von_netz, ins_netz, vom_lief, von_comm, an_lief, an_comm, pv] (Wh)
  status: null, tarife: [],
  tag: null,        // gewählter Tag (YYYY-MM-DD)
  geladen: false,
};

const $m = id => document.getElementById(id);
const kwh = wh => wh / 1000;
const eur = new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" });
const nfk = new Intl.NumberFormat("de-AT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function msView(name) {
  for (const v of ["ms-nocfg", "ms-login", "ms-newpw", "ms-app"]) $m(v).hidden = v !== name;
}
function msMsg(id, text, err) { const e = $m(id); e.textContent = text || ""; e.className = "msg" + (err ? " err" : ""); }

// ---------- Initialisierung ----------
function msInit() {
  const C = window.STROM_CONFIG || {};
  if (!C.supabaseUrl || !C.supabaseKey || !window.supabase) { msView("ms-nocfg"); return; }
  MS.sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  MS.sb.auth.onAuthStateChange((ev, session) => {
    if (ev === "PASSWORD_RECOVERY") { MS.recovery = true; location.hash = "#mein"; msView("ms-newpw"); return; }
    const u = session ? session.user : null;
    const changed = (u && u.id) !== (MS.user && MS.user.id);
    MS.user = u;
    if (changed) { MS.geladen = false; MS.hours = null; }
    if (S.tab === "mein") renderMein();
  });

  $m("ms-login-form").addEventListener("submit", async e => {
    e.preventDefault();
    msMsg("ms-login-msg", "Anmeldung läuft …");
    const { error } = await MS.sb.auth.signInWithPassword({ email: $m("ms-email").value.trim(), password: $m("ms-pw").value });
    if (error) msMsg("ms-login-msg", error.message === "Invalid login credentials" ? "E-Mail oder Passwort falsch." : error.message, true);
    else { msMsg("ms-login-msg", ""); $m("ms-pw").value = ""; }
  });
  $m("ms-forgot").addEventListener("click", async () => {
    const email = $m("ms-email").value.trim();
    if (!email) { msMsg("ms-login-msg", "Bitte zuerst die E-Mail-Adresse eintragen.", true); return; }
    const { error } = await MS.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    msMsg("ms-login-msg", error ? error.message : "Falls das Konto existiert, kommt gleich eine E-Mail mit einem Link.", !!error);
  });
  $m("ms-newpw-form").addEventListener("submit", async e => {
    e.preventDefault();
    const pw = $m("ms-newpw1").value;
    if (pw.length < 12) { msMsg("ms-newpw-msg", "Bitte mindestens 12 Zeichen.", true); return; }
    if (pw !== $m("ms-newpw2").value) { msMsg("ms-newpw-msg", "Die Passwörter stimmen nicht überein.", true); return; }
    const { error } = await MS.sb.auth.updateUser({ password: pw });
    if (error) { msMsg("ms-newpw-msg", error.message, true); return; }
    MS.recovery = false; msMsg("ms-newpw-msg", ""); renderMein();
  });
  $m("ms-logout").addEventListener("click", async () => { await MS.sb.auth.signOut(); MS.hours = null; MS.geladen = false; renderMein(); });
  $m("ms-reload").addEventListener("click", () => { MS.geladen = false; renderMein(); });
  $m("ms-sync-btn").addEventListener("click", msJetztAbrufen);
  $m("ms-file").addEventListener("change", e => msImport([...e.target.files]).finally(() => { e.target.value = ""; }));
  $m("ms-tag").addEventListener("change", e => { MS.tag = e.target.value; msTagChart(); });
  $m("ms-tarif-form").addEventListener("submit", msTarifSpeichern);
}

// ---------- Hauptansicht ----------
async function renderMein() {
  if (!MS.sb) { msView("ms-nocfg"); return; }
  if (MS.recovery) { msView("ms-newpw"); return; }
  if (!MS.user) { msView("ms-login"); return; }
  msView("ms-app");
  $m("ms-user").textContent = MS.user.email || "";
  if (!MS.geladen) {
    $m("ms-app").classList.add("loading");
    try { await msLaden(); } catch (e) { msMsg("ms-app-msg", "Laden fehlgeschlagen: " + e.message, true); }
    $m("ms-app").classList.remove("loading");
  }
  msZeichnen();
}

async function msLaden() {
  const st = await MS.sb.rpc("status_json");
  if (st.error) {
    if (/permission|not allowed|denied/i.test(st.error.message)) throw new Error("Dein Konto ist nicht freigeschaltet (Tabelle app_users).");
    throw st.error;
  }
  MS.status = st.data || {};
  const tr = await MS.sb.from("tarif").select("*").order("gueltig_ab");
  if (tr.error) throw tr.error;
  MS.tarife = tr.data || [];
  MS.hours = [];
  if (MS.status.erste) {
    const von = new Date(MS.status.erste), bis = new Date(Date.parse(MS.status.letzte) + 86400000);
    const r = await MS.sb.rpc("stunden_json", { von: von.toISOString(), bis: bis.toISOString() });
    if (r.error) throw r.error;
    MS.hours = r.data || [];
    const f = await MS.sb.rpc("flex_json", { von: von.toISOString(), bis: bis.toISOString() });
    if (f.error) throw f.error;
    MS.flex = new Map((f.data || []).map(x => [x[0], [x[1], x[2]]]));
  }
  const sl = await MS.sb.from("sync_lauf").select("*").order("id", { ascending: false }).limit(1);
  MS.sync = sl.data && sl.data[0] || null;
  MS.geladen = true;
  if (!MS.tag) {
    const last = MS.status.letzte ? new Date(MS.status.letzte) : new Date();
    const L = local(Math.floor(last.getTime() / 1000));
    MS.tag = `${L.y}-${String(L.m + 1).padStart(2, "0")}-${String(L.d).padStart(2, "0")}`;
  }
  msMsg("ms-app-msg", MS.hours.length ? "" : "Noch keine Messdaten. Lade unten einen 15-Minuten-Export aus der eFriends-App hoch.");
}

// EPEX-Stundenpreis (ct/kWh netto) zu einem UTC-Stundenbeginn
function epexAt(ts) {
  if (!D) return null;
  const i = Math.round((ts - D.ts[0]) / 3600);
  return i >= 0 && i < D.n && D.ts[i] === ts && !Number.isNaN(D.v[i]) ? D.v[i] : null;
}
function tarifFuer(y, m) {
  const key = `${y}-${String(m + 1).padStart(2, "0")}-28`;
  let t = MS.tarife[0] || null;
  for (const x of MS.tarife) if (x.gueltig_ab <= key) t = x;
  return t;
}

// Preise je Stunde (ct/kWh brutto) nach Tarif; exakte API-Preise haben Vorrang
function msPreise(ts, t, p) {
  const ust = t ? +t.ust : VAT;
  const ex = MS.flex.get(ts);
  let bez = null, ein = null, exakt = false;
  if (ex) { bez = ex[0] * (1 + ust); ein = ex[1] * (1 + ust); exakt = true; }
  else if (t && t.art === "fix" && t.bezug_ct_netto != null) bez = +t.bezug_ct_netto * (1 + ust);
  else if (t && p != null) {
    const brutto = p * (1 + ust), auf = Math.max(+t.aufschlag_pct / 100 * brutto, +t.aufschlag_min_ct_brutto);
    bez = brutto + auf; ein = brutto - auf;
  }
  const comm = t && t.community_bezug_ct_netto != null ? (+t.community_bezug_ct_netto + +t.community_gebuehr_ct_netto) * (1 + ust) : bez;
  return { bez, ein, comm, exakt };
}

function msMonate() {
  const M = new Map();
  for (const r of MS.hours) {
    const [ts, vn, inn, vl, vc, al, ac] = r;
    const L = local(ts), k = L.y * 12 + L.m;
    let e = M.get(k);
    if (!e) {
      e = { y: L.y, m: L.m, vn: 0, inn: 0, vl: 0, vc: 0, al: 0, ac: 0, ef: 0, einsp: 0, smart: 0, fix: 0, boerseW: 0, boerseKwh: 0,
            ohnePreis: 0, exakt: 0, std: 0, tage: new Set(), t: tarifFuer(L.y, L.m) };
      M.set(k, e);
    }
    e.vn += vn; e.inn += inn; e.vl += vl; e.vc += vc; e.al += al; e.ac += ac; e.tage.add(L.d); e.std++;
    const p = epexAt(ts), t = e.t, ust = t ? +t.ust : VAT;
    const pr = msPreise(ts, t, p);
    if (pr.bez == null) { e.ohnePreis++; continue; }
    if (pr.exakt) e.exakt++;
    e.ef += (kwh(vl) * pr.bez + kwh(vc) * pr.comm) / 100;
    if (pr.ein != null) e.einsp += kwh(al) * pr.ein / 100;
    if (p != null) { e.smart += kwh(vn) * (p + FEE) * (1 + VAT) / 100; e.boerseW += p * kwh(vn); e.boerseKwh += kwh(vn); }
    if (t && t.vergleich_fix_ct_netto != null) e.fix += kwh(vn) * +t.vergleich_fix_ct_netto * (1 + ust) / 100;
  }
  return [...M.keys()].sort((a, b) => a - b).map(k => {
    const e = M.get(k);
    e.grund = e.t ? +e.t.grundgebuehr_eur_brutto : 0;
    e.ctBezug = e.vn ? e.ef / kwh(e.vn) * 100 : null;                 // Ø bezahlter Preis brutto
    e.ctBoerseLast = e.boerseKwh ? e.boerseW / e.boerseKwh : null;    // lastgewichteter Börsenpreis netto
    e.ctEinsp = e.al ? e.einsp / kwh(e.al) * 100 : null;
    e.quelle = e.exakt === e.std ? "exakt" : e.exakt ? "teils exakt" : "berechnet";
    e.ttl = `${MONATE[e.m]} ${String(e.y).slice(2)}`;
    return e;
  });
}

const QUELLEN = { netz_noe: "Netz NÖ", fusionsolar: "PV", efriends: "eFriends", monta: "Wallboxen" };
function msSyncZeigen() {
  const l = MS.sync, box = $m("ms-sync-txt");
  if (!l) { box.textContent = "Abruf: noch nie gelaufen"; return; }
  const zeit = new Date(l.beendet || l.gestartet).toLocaleString("de-AT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const teile = Object.entries(QUELLEN).map(([k, name]) => {
    const r = (l.ergebnis || {})[k];
    if (!r) return `<span class="q aus" title="läuft noch">${name}</span>`;
    if (r.ok === false) return `<span class="q fehler" title="${esc(r.fehler || "")}">${name}</span>`;
    if (r.übersprungen) return `<span class="q aus" title="${esc(r.übersprungen)}">${name}</span>`;
    return `<span class="q ok" title="${esc(JSON.stringify(r))}">${name}</span>`;
  });
  box.innerHTML = `Abruf ${esc(zeit)}${l.beendet ? "" : " (läuft …)"}: ${teile.join(" ")}`;
}
async function msJetztAbrufen() {
  const btn = $m("ms-sync-btn"); btn.disabled = true; btn.textContent = "Abruf läuft …";
  let text = "", fehlerhaft = false;
  try {
    const { data, error } = await MS.sb.functions.invoke("sync", { body: { ausloeser: "app" } });
    if (error) {
      text = error.message; fehlerhaft = true;
      try { const j = await error.context.json(); text = j.übersprungen ? "Der letzte Abruf ist weniger als 10 Minuten her." : (j.fehler || text); } catch (_) {}
    } else {
      const fehler = Object.entries(data || {}).filter(([, r]) => r && r.ok === false).map(([k, r]) => `${QUELLEN[k] || k}: ${r.fehler}`);
      text = fehler.length ? fehler.join(" · ") : "Abruf erfolgreich."; fehlerhaft = fehler.length > 0;
    }
  } catch (e) { text = e.message; fehlerhaft = true; }
  btn.disabled = false; btn.textContent = "Jetzt abrufen";
  MS.geladen = false; await renderMein();
  msMsg("ms-app-msg", text, fehlerhaft);
}

function msZeichnen() {
  if (!MS.hours) return;
  msSyncZeigen();
  const ms = msMonate();
  const st = MS.status || {};

  // Kopfzeile / Stand
  const exp = st.export_bis ? new Date(st.export_bis).toLocaleDateString("de-AT") : "–";
  const live = st.live_letzter;
  $m("ms-stand").textContent = `${MS.hours.length ? nf0.format(MS.hours.length) + " Stunden Messdaten" : "Keine Messdaten"} · Export bis ${exp}` +
    (live ? ` · Live zuletzt ${new Date(live.ts).toLocaleString("de-AT", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}` : " · Live-Sammler inaktiv");

  // KPIs
  let k = "";
  if (live && Date.now() - Date.parse(live.ts) < 5 * 60 * 1000) {
    const bez = live.von_netz_w || 0, ein = live.ins_netz_w || 0;
    k += kpi("Jetzt", bez >= ein ? nf0.format(bez) : nf0.format(ein), "W", bez >= ein ? `Bezug, davon ${nf0.format(live.von_community_w || 0)} W Community` : `Einspeisung, davon ${nf0.format(live.an_community_w || 0)} W an Community`, true);
  }
  const cur = ms[ms.length - 1];
  if (cur) {
    const commAnteil = cur.vn ? cur.vc / cur.vn * 100 : 0;
    k += kpi(`Bezug ${MONATE_LANG[cur.m]}`, nfk.format(kwh(cur.vn)), "kWh", `${nf1.format(commAnteil)} % aus der Community · ${cur.tage.size} Tage`);
    k += kpi("Kosten eFriends Flex", eur.format(cur.ef + cur.grund), "", `Ø ${fmt(cur.ctBezug)} ct/kWh brutto + ${eur.format(cur.grund)} Gebühren`);
    k += kpi("Zum Vergleich Fixpreis", cur.fix ? eur.format(cur.fix + cur.grund) : "–", "", cur.t && cur.t.vergleich_fix_ct_netto != null ? `bei ${fmt(+cur.t.vergleich_fix_ct_netto)} ct netto` : "");
    k += kpi("Einspeisung", nfk.format(kwh(cur.inn)), "kWh", cur.al ? `${eur.format(cur.einsp)} Vergütung, Ø ${fmt(cur.ctEinsp)} ct` : "");
  }
  $m("ms-kpis").innerHTML = k;

  const xa = (o, list) => { o.xAxis.data = list.map(e => e.ttl); o.xAxis.axisLabel.interval = list.length > 14 ? (i => list[i].m === 0) : 0; if (list.length > 14) o.xAxis.axisLabel.formatter = (v, i) => String(list[i].y); };
  const legend = () => ({ top: 0, left: 0, icon: "circle", itemWidth: 8, itemHeight: 8, textStyle: { color: css("--text-2"), fontSize: 12 } });
  const tip = unit => ps => `<b>${MONATE_LANG[ms[ps[0].dataIndex].m]} ${ms[ps[0].dataIndex].y}</b><br>` + ps.map(p => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px"></span>${p.seriesName}: ${unit(p.value)}`).join("<br>");
  const stackBar = (name, data, color, radius) => ({ type: "bar", name, stack: "s", data, barMaxWidth: 40, itemStyle: { color: css(color), borderRadius: radius, borderColor: css("--surface"), borderWidth: 1 } });

  // Bezug je Monat
  let o = base(); o.grid.top = window.innerWidth < 600 ? 64 : 36; o.legend = legend(); xa(o, ms);
  o.tooltip.formatter = tip(v => nfk.format(v) + " kWh");
  o.series = [stackBar("vom Lieferanten", ms.map(e => +kwh(e.vl).toFixed(1)), "--series-1", [0, 0, 0, 0]),
              stackBar("aus der Community", ms.map(e => +kwh(e.vc).toFixed(1)), "--series-3", [4, 4, 0, 0])];
  chart("ms-c-bezug", o);
  setTable("ms-c-bezug", ["Monat", "Bezug kWh", "vom Lieferanten", "aus Community", "Community-Anteil"],
    ms.map(e => [e.ttl, nfk.format(kwh(e.vn)), nfk.format(kwh(e.vl)), nfk.format(kwh(e.vc)), nf1.format(e.vn ? e.vc / e.vn * 100 : 0) + " %"]));

  // Einspeisung je Monat
  o = base(); o.grid.top = window.innerWidth < 600 ? 64 : 36; o.legend = legend(); xa(o, ms);
  o.tooltip.formatter = tip(v => nfk.format(v) + " kWh");
  o.series = [stackBar("an Lieferanten", ms.map(e => +kwh(e.al).toFixed(1)), "--series-2", [0, 0, 0, 0]),
              stackBar("an Community", ms.map(e => +kwh(e.ac).toFixed(1)), "--series-4", [4, 4, 0, 0])];
  chart("ms-c-einsp", o);
  setTable("ms-c-einsp", ["Monat", "Einspeisung kWh", "an Lieferanten", "an Community", "Ø Einspeisepreis ct brutto", "Vergütung Lieferant", "Preise"],
    ms.map(e => [e.ttl, nfk.format(kwh(e.inn)), nfk.format(kwh(e.al)), nfk.format(kwh(e.ac)), fmt(e.ctEinsp), eur.format(e.einsp), e.quelle]));

  // Kostenvergleich (nur Energie, ohne Grundgebühren und Netz)
  o = base(); o.grid.top = window.innerWidth < 600 ? 84 : 36; o.legend = legend(); xa(o, ms);
  o.tooltip.formatter = tip(v => eur.format(v));
  const bar = (name, data, color) => ({ type: "bar", name, data, barMaxWidth: 18, barGap: "12%", itemStyle: { color: css(color), borderRadius: [3, 3, 0, 0] } });
  o.series = [
    bar("eFriends Flex", ms.map(e => +e.ef.toFixed(2)), "--series-1"),
    bar("smartCONTROL", ms.map(e => +e.smart.toFixed(2)), "--series-2"),
    bar("Fixpreis", ms.map(e => +e.fix.toFixed(2)), "--series-3"),
  ];
  chart("ms-c-kosten", o);
  const sum = key => ms.reduce((a, e) => a + e[key], 0);
  const sEf = sum("ef"), sSm = sum("smart"), sFx = sum("fix");
  const best = [["eFriends Flex", sEf], ["smartCONTROL", sSm], ["Fixpreis", sFx]].sort((a, b) => a[1] - b[1]);
  const ohne = sum("ohnePreis");
  $m("ms-n-kosten").textContent = ms.length
    ? `Summe über ${ms.length} Monate (nur Energie): eFriends Flex ${eur.format(sEf)}, smartCONTROL ${eur.format(sSm)}, Fixpreis ${eur.format(sFx)}. Am günstigsten: ${best[0][0]}.` +
      (ohne ? ` ${nf0.format(ohne)} Stunden ohne Preis nicht bewertet.` : "")
    : "";
  setTable("ms-c-kosten", ["Monat", "Bezug kWh", "Ø Börse lastgewichtet ct netto", "Ø bezahlt ct brutto", "eFriends Flex", "Gebühren", "eFriends gesamt", "smartCONTROL", "Fixpreis", "Preise"],
    ms.map(e => [e.ttl, nfk.format(kwh(e.vn)), fmt(e.ctBoerseLast), fmt(e.ctBezug), eur.format(e.ef), eur.format(e.grund), eur.format(e.ef + e.grund), eur.format(e.smart), eur.format(e.fix), e.quelle]));

  // Tarif-Formular vorbelegen
  const t = MS.tarife[MS.tarife.length - 1];
  if (t) {
    $m("ms-t-ab").value = t.gueltig_ab; $m("ms-t-name").value = t.name; $m("ms-t-art").value = t.art;
    $m("ms-t-auf").value = t.aufschlag_pct; $m("ms-t-min").value = t.aufschlag_min_ct_brutto;
    $m("ms-t-bezug").value = t.bezug_ct_netto ?? ""; $m("ms-t-comm").value = t.community_bezug_ct_netto ?? "";
    $m("ms-t-grund").value = t.grundgebuehr_eur_brutto; $m("ms-t-fix").value = t.vergleich_fix_ct_netto ?? "";
  }
  $m("ms-tag").value = MS.tag || "";
  msTagChart();
  msTarifvergleich();
}

// ---------- Tagesansicht (Viertelstunden) ----------
async function msTagChart() {
  if (!MS.tag || !MS.sb || !MS.user) return;
  const [y, m, d] = MS.tag.split("-").map(Number);
  const start = Date.UTC(y, m - 1, d) / 1000;            // 00:00 UTC des Kalendertags
  const von = start - offset(start), bis = start + 86400 - offset(start + 86400);   // lokale Mitternacht (Wien)
  const r = await MS.sb.rpc("viertel_json", { von: new Date(von * 1000).toISOString(), bis: new Date(bis * 1000).toISOString() });
  if (r.error) { msMsg("ms-app-msg", r.error.message, true); return; }
  const rows = r.data || [];
  const lab = rows.map(x => { const L = local(x[0]); return `${String(L.h).padStart(2, "0")}:${String(new Date(x[0] * 1000).getUTCMinutes()).padStart(2, "0")}`; });
  const o = base(); o.grid.top = window.innerWidth < 600 ? 44 : 36;
  o.legend = { top: 0, left: 0, icon: "circle", itemWidth: 8, itemHeight: 8, textStyle: { color: css("--text-2"), fontSize: 12 } };
  o.xAxis.data = lab; const step = window.innerWidth < 600 ? 6 : 3;
  o.xAxis.axisLabel.interval = i => !!lab[i] && lab[i].endsWith(":00") && +lab[i].slice(0, 2) % step === 0;
  o.tooltip.formatter = ps => `<b>${ps[0].name}</b><br>` + ps.map(p => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px"></span>${p.seriesName}: ${nf2.format(Math.abs(p.value))} kWh`).join("<br>");
  o.series = [
    { type: "bar", name: "Bezug", stack: "x", data: rows.map(x => +(x[1] / 1000).toFixed(3)), itemStyle: { color: css("--series-1"), borderRadius: [3, 3, 0, 0] }, barCategoryGap: "20%" },
    { type: "bar", name: "Einspeisung", stack: "x", data: rows.map(x => -(x[2] / 1000).toFixed(3)), itemStyle: { color: css("--series-2"), borderRadius: [0, 0, 3, 3] } },
  ];
  chart("ms-c-tag", o);
  const sb = rows.reduce((a, x) => a + x[1], 0), se = rows.reduce((a, x) => a + x[2], 0);
  $m("ms-n-tag").textContent = rows.length ? `Bezug ${nf2.format(sb / 1000)} kWh, Einspeisung ${nf2.format(se / 1000)} kWh · ${rows.length} Viertelstunden` : "Für diesen Tag liegen keine Messdaten vor.";
  setTable("ms-c-tag", ["Zeit", "Bezug kWh", "Einspeisung kWh", "Quelle"], rows.map((x, i) => [lab[i], nf2.format(x[1] / 1000), nf2.format(x[2] / 1000), x[8]]));
}

// ---------- Import ----------
// Liefert eine Liste von Paketen {tabelle, onConflict, rows, text}
function msParse(name, text) {
  const t = text.trim();
  if (t.startsWith("{")) {
    const o = JSON.parse(t);
    if (o.quelle === "netznoe") return parseNetzNoe(o);
    if (o.quelle === "fusionsolar") return parseFusion(o);
    if (o.quelle === "monta") {
      const rows = (o.ladevorgaenge || []).filter(c => c.start && c.wallbox_id).map(c => ({
        wallbox_id: c.wallbox_id, start: c.start, wallbox: c.wallbox, ende: c.ende || null, voll: c.voll || null, kwh: c.kwh,
        zaehler_start: c.zaehler_start, zaehler_ende: c.zaehler_ende, soc_start: c.soc_start, soc_ende: c.soc_ende,
        preis_cent: c.preis, preis_kwh_cent: c.preis_kwh, kosten_cent: c.kosten, status: c.state, smart: c.smart, start_quelle: c.quelle_start }));
      return [{ tabelle: "laden", onConflict: "wallbox_id,start", rows, text: `Wallboxen: ${nf0.format(rows.length)} Ladevorgänge` }];
    }
    if (o.quelle === "efriends") {   // Sammeldatei: [periodFrom, periodTo, fromGrid, toGrid, fromSupplier, fromCommunity, toSupplier, toCommunity, inverterProduction, quality]
      const rows = o.rows.filter(r => Date.parse(r[1]) - Date.parse(r[0]) === 900e3).map(r => ({
        ts_start: new Date(Date.parse(r[0])).toISOString(), quelle: "export",
        von_netz_wh: r[2], ins_netz_wh: r[3], vom_lieferant_wh: r[4], von_community_wh: r[5],
        an_lieferant_wh: r[6], an_community_wh: r[7], pv_wh: r[8], qualitaet: r[9] == null ? null : Math.round(r[9]) }));
      return [{ tabelle: "messung_15min", onConflict: "ts_start,quelle", rows, text: `eFriends: ${nf0.format(rows.length)} Viertelstunden` }];
    }
    throw new Error("unbekanntes Dateiformat");
  }
  return [parseEfriends(name, t)];
}

function parseEfriends(name, text) {
  const out = [];
  const add = (from, to, u, q, gap) => {
    const a = Date.parse(from), b = Date.parse(to);
    if (!(b - a === 900000)) return false;             // nur Viertelstunden
    out.push({
      ts_start: new Date(a).toISOString(), quelle: "export",
      von_netz_wh: +u.fromGrid || 0, ins_netz_wh: +u.toGrid || 0,
      vom_lieferant_wh: +u.fromSupplier || 0, von_community_wh: +u.fromCommunity || 0,
      an_lieferant_wh: +u.toSupplier || 0, an_community_wh: +u.toCommunity || 0,
      pv_wh: +u.inverterProduction || 0, qualitaet: q == null ? null : Math.round(+q), luecke: !!gap,
    });
    return true;
  };
  let skipped = 0;
  if (/\.json$/i.test(name) || text.startsWith("[")) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error("unerwartetes JSON-Format");
    for (const x of arr) if (!x.usage || !add(x.periodFrom, x.periodTo, x.usage, x.readingQuality, x.isGap === true || x.isGap === "true")) skipped++;
  } else {
    const lines = text.split(/\r?\n/).filter(Boolean), h = lines[0].split(";");
    const idx = n => h.indexOf(n);
    for (const line of lines.slice(1)) {
      const c = line.split(";"), u = {};
      for (const f of ["fromGrid", "toGrid", "fromSupplier", "fromCommunity", "toSupplier", "toCommunity", "inverterProduction"]) u[f] = c[idx("usage." + f)];
      if (!add(c[idx("periodFrom")], c[idx("periodTo")], u, null, c[idx("isGap")] === "true")) skipped++;
    }
  }
  const rows = out.filter(r => !r.luecke), gaps = out.length - rows.length;   // Lücken nicht als 0 speichern
  if (!rows.length) return { rows, text: `eFriends: keine Viertelstundenwerte${skipped ? " (bitte „15-Min (json)“ wählen)" : ""}` };
  rows.forEach(r => delete r.luecke);
  return { tabelle: "messung_15min", onConflict: "ts_start,quelle", rows, text: `eFriends: ${nf0.format(rows.length)} Viertelstunden${gaps ? `, ${gaps} Lücken übersprungen` : ""}` };
}

// Lokale Wiener Zeit "YYYY-MM-DD[T ]HH:MM" → UTC-ms. dst: true/false wenn bekannt, sonst null (dann nach Reihenfolge)
function wienUtc(str, dst, nach) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(str); if (!m) return null;
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const kand = [base - 7200e3, base - 3600e3].filter(c => (offset(c / 1000 - 1) * 1000) === base - c);
  if (dst === true) return base - 7200e3;
  if (dst === false) return base - 3600e3;
  const ok = kand.filter(c => nach == null || c > nach);
  return ok.length ? Math.min(...ok) : (kand.length ? kand[0] : null);
}

function parseNetzNoe(o) {
  const pakete = [];
  for (const richtung of ["bezug", "einspeisung"]) {
    const tage = o.days?.[richtung] || {}; const rows = []; let last = null, geschaetzt = 0;
    for (const tag of Object.keys(tage).sort()) {
      const d = tage[tag];
      for (let i = 0; i < d.v.length; i++) {
        let val = d.v[i], est = false;
        if (val == null && d.e?.[i] != null) { val = d.e[i]; est = true; }
        if (val == null || !d.t?.[i]) continue;
        const ende = wienUtc(d.t[i], null, last); if (ende == null) continue;
        last = ende; if (est) geschaetzt++;
        rows.push({ ts_start: new Date(ende - 900e3).toISOString(), richtung, kwh: +val, geschaetzt: est, zaehlpunkt: o.zaehlpunkte?.[richtung] || null });
      }
    }
    if (rows.length) pakete.push({ tabelle: "netz_15min", onConflict: "ts_start,richtung", rows,
      text: `Netz NÖ ${richtung}: ${nf0.format(rows.length)} Viertelstunden${geschaetzt ? ` (${geschaetzt} geschätzt)` : ""}` });
  }
  return pakete;
}

function parseFusion(o) {
  const num = x => (x == null || x === "--" || x === "") ? null : +x;
  const q = new Map();   // 15-min-Bucket → Summen (Wh)
  const felder = [["pv_wh", "productPower"], ["verbrauch_wh", "usePower"], ["eigen_wh", "selfUsePower"], ["laden_wh", "chargePower"], ["entladen_wh", "dischargePower"]];
  for (const tag of Object.keys(o.tage || {}).sort()) {
    const d = o.tage[tag], xs = d.xAxis || [];
    for (let i = 0; i < xs.length; i++) {
      const utc = wienUtc(xs[i], /DST/.test(xs[i]), null); if (utc == null) continue;
      const b = utc - utc % 900e3;
      for (const [f, k] of felder) {
        const kw = num((d[k] || [])[i]); if (kw == null) continue;
        const e = q.get(b) || {}; e[f] = (e[f] || 0) + kw * 1000 / 12; q.set(b, e);
      }
    }
  }
  const rows15 = [...q.entries()].sort((a, b) => a[0] - b[0]).map(([b, e]) => ({ ts_start: new Date(b).toISOString(), ...Object.fromEntries(felder.map(([f]) => [f, e[f] != null ? +e[f].toFixed(1) : null])) }));
  const tage = new Map();
  for (const mon of Object.keys(o.monate || {}).sort()) {
    const d = o.monate[mon];
    (d.xAxis || []).forEach((x, i) => {
      const tag = `${mon}-${String(x).padStart(2, "0")}`;
      const r = { tag, pv_kwh: num(d.productPower?.[i]), verbrauch_kwh: num(d.usePower?.[i]), eigen_kwh: num(d.selfUsePower?.[i]),
                  laden_kwh: num(d.chargePower?.[i]), entladen_kwh: num(d.dischargePower?.[i]), einspeisung_kwh: num(d.onGridPower?.[i]), bezug_kwh: num(d.disGridPower?.[i]) };
      if (Object.values(r).some((v, j) => j > 0 && v != null)) tage.set(tag, r);
    });
  }
  for (const [tag, d] of Object.entries(o.tage || {})) {     // Tagessummen aus der Tagesansicht ergänzen
    const r = tage.get(tag) || { tag };
    if (num(d.totalOnGridPower) != null) r.einspeisung_kwh = num(d.totalOnGridPower);
    if (num(d.totalBuyPower) != null) r.bezug_kwh = num(d.totalBuyPower);
    if (r.pv_kwh == null && num(d.totalProductPower) != null) r.pv_kwh = num(d.totalProductPower);
    if (r.verbrauch_kwh == null && num(d.totalUsePower) != null) r.verbrauch_kwh = num(d.totalUsePower);
    tage.set(tag, r);
  }
  const rowsTag = [...tage.values()].sort((a, b) => a.tag < b.tag ? -1 : 1);
  return [
    { tabelle: "pv_tag", onConflict: "tag", rows: rowsTag, text: `PV-Anlage: ${nf0.format(rowsTag.length)} Tage` },
    { tabelle: "pv_15min", onConflict: "ts_start", rows: rows15, text: `PV-Anlage: ${nf0.format(rows15.length)} Viertelstunden` },
  ].filter(p => p.rows.length);
}

async function msImport(files) {
  if (!files.length) return;
  const log = [];
  msMsg("ms-imp-msg", "Import läuft …");
  for (const f of files) {
    try {
      const pakete = msParse(f.name, await f.text());
      if (!pakete.some(p => p.rows.length)) { log.push(`${f.name}: ${pakete[0]?.text || "keine Daten gefunden"}.`); continue; }
      for (const p of pakete) {
        if (!p.rows.length) continue;
        for (let i = 0; i < p.rows.length; i += 500) {
          msMsg("ms-imp-msg", `${f.name}: ${p.text} … ${Math.min(100, Math.round((i + 500) / p.rows.length * 100))} %`);
          const { error } = await MS.sb.from(p.tabelle).upsert(p.rows.slice(i, i + 500), { onConflict: p.onConflict });
          if (error) throw error;
        }
        log.push(`${f.name}: ${p.text} übernommen.`);
      }
    } catch (e) {
      log.push(`${f.name}: Fehler – ${e.message}`);
    }
  }
  $m("ms-imp-msg").innerHTML = log.map(esc).join("<br>");
  $m("ms-imp-msg").className = "msg" + (log.some(l => l.includes("Fehler")) ? " err" : "");
  MS.geladen = false; renderMein();
}

// ---------- Tarif ----------
async function msTarifSpeichern(e) {
  e.preventDefault();
  const num = id => { const v = $m(id).value.trim().replace(",", "."); return v === "" ? null : +v; };
  const row = {
    gueltig_ab: $m("ms-t-ab").value, name: $m("ms-t-name").value.trim(), art: $m("ms-t-art").value,
    aufschlag_pct: num("ms-t-auf") ?? 10, aufschlag_min_ct_brutto: num("ms-t-min") ?? 2.28,
    bezug_ct_netto: num("ms-t-bezug"), community_bezug_ct_netto: num("ms-t-comm"),
    grundgebuehr_eur_brutto: num("ms-t-grund") ?? 0, vergleich_fix_ct_netto: num("ms-t-fix"),
  };
  if (!row.gueltig_ab || !row.name) { msMsg("ms-t-msg", "Bitte Datum und Tarifname angeben.", true); return; }
  if (row.art === "fix" && row.bezug_ct_netto == null) { msMsg("ms-t-msg", "Für einen Fixtarif bitte den Bezugspreis angeben.", true); return; }
  const { error } = await MS.sb.from("tarif").upsert(row, { onConflict: "gueltig_ab" });
  msMsg("ms-t-msg", error ? error.message : "Gespeichert.", !!error);
  if (!error) { MS.geladen = false; renderMein(); }
}


// ---------- Tarifvergleich ----------
const TV = { cache: new Map(), zeit: "m12" };
function tvZeitraeume() {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const opts = [["m12", "Letzte 12 Monate", new Date(y, m - 12, 1), new Date(y, m, 1)]];
  for (let j = y - 1; j >= 2024; j--) opts.push([String(j), String(j), new Date(j, 0, 1), new Date(j + 1, 0, 1)]);
  return opts;
}
async function msTarifvergleich() {
  const sel = $m("tv-zeit");
  if (!sel.options.length) {
    sel.innerHTML = tvZeitraeume().map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    sel.addEventListener("change", () => { TV.zeit = sel.value; msTarifvergleich(); });
  }
  const [, label, von, bis] = tvZeitraeume().find((z) => z[0] === TV.zeit);
  let rows = TV.cache.get(TV.zeit);
  if (!rows) {
    const r = await MS.sb.rpc("netz_stunden_json", { von: von.toISOString(), bis: bis.toISOString() });
    if (r.error) { $m("tv-note").textContent = r.error.message; return; }
    rows = r.data || []; TV.cache.set(TV.zeit, rows);
  }
  if (!rows.length) { $m("tv-note").textContent = "Für diesen Zeitraum liegen keine Netz-NÖ-Werte vor."; return; }
  const v = tarifVergleichRechnen(rows, epexAt, local);
  const akt = v.bezug.find((t) => t.aktuell), aktE = v.einsp.find((t) => t.aktuell);
  const bestB = [...v.bezug].sort((a, b) => a.gesamt - b.gesamt)[0], bestE = [...v.einsp].sort((a, b) => b.gesamt - a.gesamt)[0];
  $m("tv-note").textContent = `${label}: ${nf0.format(v.kwhBez)} kWh Bezug, ${nf0.format(v.kwhEin)} kWh Einspeisung (${v.monate} Monate). ` +
    (bestB.id === akt.id ? `Beim Bezug war dein eFriends FLEX am günstigsten.` : `Beim Bezug wäre ${bestB.name} um ${eur.format(akt.gesamt - bestB.gesamt)} günstiger gewesen als dein FLEX (${eur.format(akt.gesamt)}).`) + " " +
    (bestE.id === aktE.id ? `Bei der Einspeisung brachte FLEX am meisten.` : `Bei der Einspeisung hätte ${bestE.name} ${eur.format(bestE.gesamt - aktE.gesamt)} mehr gebracht.`);

  const balken = (id, liste, aufsteigend, achse) => {
    const l = [...liste].sort((a, b) => aufsteigend ? b.gesamt - a.gesamt : a.gesamt - b.gesamt);   // ECharts zeichnet y von unten
    const o = base();
    o.grid = { left: 8, right: 70, top: 8, bottom: 8, containLabel: true };
    o.tooltip.trigger = "item"; o.tooltip.axisPointer = undefined;
    o.tooltip.formatter = (pp) => { const t = l[pp.dataIndex]; return `<b>${esc(t.name)}</b><br>${esc(t.info)}<br>Energie ${eur.format(t.energie)} · Gebühr ${eur.format(t.gebuehr)}<br>Ø ${fmt(t.ct)} ct/kWh`; };
    o.xAxis = { type: "value", axisLabel: { color: css("--muted"), fontSize: 11, formatter: (x) => nf0.format(x) + " €" }, splitLine: { lineStyle: { color: css("--grid") } } };
    o.yAxis = { type: "category", data: l.map((t) => t.name), axisTick: { show: false }, axisLine: { lineStyle: { color: css("--axis") } },
      axisLabel: { color: css("--text-2"), fontSize: 12, fontWeight: (v, i) => l[i]?.aktuell ? 600 : 400 } };
    o.series = [{ type: "bar", barMaxWidth: 22, data: l.map((t) => ({ value: +t.gesamt.toFixed(2), itemStyle: { color: t.aktuell ? css("--series-1") : css("--axis"), borderRadius: [0, 4, 4, 0] } })),
      label: { show: true, position: "right", color: css("--text-2"), fontSize: 11, formatter: (pp) => eur.format(pp.value) } }];
    chart(id, o);
  };
  balken("tv-c-bezug", v.bezug, true);
  balken("tv-c-einsp", v.einsp, false);
  setTable("tv-c-bezug", ["Tarif", "Ø ct/kWh brutto", "Energie", "Grundgebühr", "Gesamt", "Differenz zu FLEX", "Konditionen"],
    [...v.bezug].sort((a, b) => a.gesamt - b.gesamt).map((t) => [t.name + (t.aktuell ? " (aktuell)" : ""), fmt(t.ct), eur.format(t.energie), eur.format(t.gebuehr), eur.format(t.gesamt), eur.format(t.gesamt - akt.gesamt), esc(t.info)]));
  setTable("tv-c-einsp", ["Tarif", "Ø ct/kWh netto", "Vergütung", "Gebühr", "Netto-Erlös", "Differenz zu FLEX", "Konditionen"],
    [...v.einsp].sort((a, b) => b.gesamt - a.gesamt).map((t) => [t.name + (t.aktuell ? " (aktuell)" : ""), fmt(t.ct), eur.format(t.energie), eur.format(t.gebuehr), eur.format(t.gesamt), eur.format(t.gesamt - aktE.gesamt), esc(t.info)]));
}

RENDER.mein = renderMein;
msInit();
