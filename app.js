/* Strompreis AT – Web-App. Vanilla JS + ECharts. Daten: data/hourly_YYYY.json */
"use strict";

// ---------- Konfiguration ----------
const FEE = 1.44;      // ct/kWh Abwicklungsgebühr smartCONTROL
const VAT = 0.20;      // USt
const H = 3600;
const MONATE = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const MONATE_LANG = ["Jänner", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const WOCHENTAGE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const WOCHENTAGE_LANG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

// ---------- Zustand ----------
const S = {
  mode: "netto",          // netto | brutto
  range: "all",           // Verlauf
  pPeriod: "all", pSplit: "all",
  hYear: null, hGrain: "month",
  sPeriod: "all", sThresh: 30,
  win: 3,
  tab: "heute",
};
const charts = {};        // id -> echarts instance
const tables = {};        // id -> {head, rows}
let D = null;             // Daten
let META = null;

// ---------- Zeit (Europe/Vienna, EU-Sommerzeitregel) ----------
function offset(ts) {
  const y = new Date(ts * 1000).getUTCFullYear();
  const lastSun = m => { const d = new Date(Date.UTC(y, m + 1, 0)); return d.getUTCDate() - d.getUTCDay(); };
  const a = Date.UTC(y, 2, lastSun(2), 1) / 1000, b = Date.UTC(y, 9, lastSun(9), 1) / 1000;
  return ts >= a && ts < b ? 7200 : 3600;
}
function local(ts) {            // -> {y,m,d,h,dow,key}
  const t = new Date((ts + offset(ts)) * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), h: t.getUTCHours(), dow: t.getUTCDay() };
}
const dayKey = (y, m, d) => y * 10000 + (m + 1) * 100 + d;

// ---------- Formatierung ----------
const nf2 = new Intl.NumberFormat("de-AT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf1 = new Intl.NumberFormat("de-AT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("de-AT", { maximumFractionDigits: 0 });
const fmt = v => (v == null || Number.isNaN(v)) ? "–" : nf2.format(v);
const price = v => v == null ? null : (S.mode === "brutto" ? (v + FEE) * (1 + VAT) : v);
const einheit = () => S.mode === "brutto" ? "ct/kWh brutto" : "ct/kWh netto";
const hh = h => String(h).padStart(2, "0") + ":00";
const dateStr = (y, m, d) => `${String(d).padStart(2, "0")}.${String(m + 1).padStart(2, "0")}.${y}`;

// ---------- Farben ----------
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function hex2rgb(h) { h = h.replace("#", ""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); }
function mix(a, b, t) { const A = hex2rgb(a), B = hex2rgb(b); return `rgb(${A.map((x, i) => Math.round(x + (B[i] - x) * t)).join(",")})`; }
function divColor(v, mid, r) {
  const t = r ? Math.max(-1, Math.min(1, (v - mid) / r)) : 0;
  return t < 0 ? mix(css("--div-mid"), css("--div-lo"), -t) : mix(css("--div-mid"), css("--div-hi"), t);
}
const seqRamp = () => css("--seq").split(",").map(s => s.trim());

// ---------- ECharts-Basis ----------
function base() {
  return {
    animationDuration: 300,
    textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: css("--text-2") },
    grid: { left: 8, right: 12, top: 28, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis", backgroundColor: css("--surface"), borderColor: css("--border"), borderWidth: 1,
      textStyle: { color: css("--text"), fontSize: 13 }, padding: [8, 10],
      extraCssText: "box-shadow:0 4px 16px rgba(0,0,0,.12);border-radius:8px",
      axisPointer: { type: "line", lineStyle: { color: css("--axis") } },
    },
    xAxis: { type: "category", axisTick: { show: false }, axisLine: { lineStyle: { color: css("--axis") } }, axisLabel: { color: css("--muted"), fontSize: 11 } },
    yAxis: { type: "value", axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: css("--grid") } }, axisLabel: { color: css("--muted"), fontSize: 11 } },
  };
}
function chart(id, option) {
  const el = document.getElementById(id);
  if (!charts[id]) charts[id] = echarts.init(el, null, { renderer: "canvas" });
  charts[id].setOption(option, true);
}
function setTable(id, head, rows) {
  tables[id] = { head, rows };
  const box = document.getElementById("t-" + id);
  if (box && !box.hidden) renderTable(id);
}
function renderTable(id) {
  const box = document.getElementById("t-" + id), t = tables[id];
  if (!t) return;
  box.innerHTML = `<table><thead><tr>${t.head.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${
    t.rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

// ---------- Daten laden ----------
async function load() {
  META = await (await fetch("data/meta.json", { cache: "no-store" })).json();
  const y0 = local(META.erster_utc).y, y1 = local(META.letzter_utc).y;
  const files = [];
  for (let y = y0; y <= y1; y++) files.push(fetch(`data/hourly_${y}.json`, { cache: "no-store" }).then(r => r.ok ? r.json() : null));
  const parts = (await Promise.all(files)).filter(Boolean);
  const n = parts.reduce((a, p) => a + p.values.length, 0);
  const ts = new Float64Array(n), v = new Float32Array(n), y = new Int16Array(n), m = new Int8Array(n), d = new Int8Array(n), h = new Int8Array(n), dow = new Int8Array(n);
  let i = 0;
  for (const p of parts) for (let k = 0; k < p.values.length; k++) {
    const t = p.start_utc + k * p.step_s, L = local(t);
    ts[i] = t; v[i] = p.values[k] ?? NaN; y[i] = L.y; m[i] = L.m; d[i] = L.d; h[i] = L.h; dow[i] = L.dow; i++;
  }
  D = { n, ts, v, y, m, d, h, dow, years: [...new Set(y)].sort() };
}

// Filter: Index-Prädikat für einen Zeitraum
function periodFilter(p) {
  const now = Date.now() / 1000;
  if (p === "all") return () => true;
  if (p === "m12") { const a = now - 365 * 86400; return i => D.ts[i] >= a; }
  if (p === "d30") { const a = now - 30 * 86400; return i => D.ts[i] >= a; }
  if (p === "d90") { const a = now - 90 * 86400; return i => D.ts[i] >= a; }
  const yr = +p; return i => D.y[i] === yr;
}
function periodLabel(p) {
  return { all: "Gesamter Zeitraum", m12: "Letzte 12 Monate", d90: "Letzte 90 Tage", d30: "Letzte 30 Tage" }[p] || p;
}
function fillPeriodSelect(sel) {
  const opts = [["all", "Alle Jahre"], ["m12", "Letzte 12 Monate"], ["d90", "Letzte 90 Tage"], ["d30", "Letzte 30 Tage"],
    ...[...D.years].reverse().map(y => [String(y), String(y)])];
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
}

// ---------- HEUTE ----------
function dayIndices(y, m, d) {
  const out = [];
  for (let i = 0; i < D.n; i++) if (D.y[i] === y && D.m[i] === m && D.d[i] === d) out.push(i);
  return out;
}
function cheapestWindow(idx, n, fromHourIdx = 0) {
  let best = null;
  for (let s = fromHourIdx; s + n <= idx.length; s++) {
    let sum = 0; for (let k = 0; k < n; k++) sum += D.v[idx[s + k]];
    if (best === null || sum < best.sum) best = { s, sum };
  }
  return best ? { start: best.s, end: best.s + n - 1, mean: best.sum / n } : null;
}
function dayChart(id, idx, nowIdx, winN) {
  const vals = idx.map(i => price(D.v[i]));
  const labels = idx.map(i => hh(D.h[i]));
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const r = Math.max(...vals.map(x => Math.abs(x - mean))) || 1;
  const win = cheapestWindow(idx, winN, nowIdx >= 0 ? nowIdx : 0);
  const o = base();
  o.grid.top = 36;
  o.tooltip.formatter = ps => { const p = ps[0]; return `<b>${p.name}</b>–${hh((D.h[idx[p.dataIndex]] + 1) % 24)}<br>${fmt(p.value)} ${einheit()}`; };
  o.xAxis.data = labels;
  o.xAxis.axisLabel.interval = labels.length > 12 ? 2 : 0;
  o.yAxis.name = einheit(); o.yAxis.nameTextStyle = { color: css("--muted"), fontSize: 11, align: "left", padding: [0, 0, 0, -4] };
  o.series = [{
    type: "bar", data: vals.map(x => ({ value: x, itemStyle: { color: divColor(x, mean, r), borderRadius: x >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] } })),
    barCategoryGap: "36%",
    markLine: {
      symbol: "none", silent: true, animation: false,
      lineStyle: { color: css("--text-2"), width: 1, type: "solid" },
      label: { color: css("--text-2"), fontSize: 11 },
      data: [
        { yAxis: mean, label: { formatter: "Ø " + fmt(mean), position: "insideStartTop" } },
        ...(nowIdx >= 0 ? [{ xAxis: labels[nowIdx], label: { formatter: "jetzt", position: "end" }, lineStyle: { color: css("--text"), width: 1.5 } }] : []),
      ],
    },
    markArea: win ? {
      silent: true, itemStyle: { color: css("--accent-wash") },
      label: { show: window.innerWidth >= 600, color: css("--text-2"), fontSize: 11, position: "insideTop", formatter: `günstigstes ${winN}-h-Fenster` },
      data: [[{ xAxis: labels[win.start] }, { xAxis: labels[win.end] }]],
    } : undefined,
  }];
  chart(id, o);
  setTable(id, ["Stunde", einheit()], idx.map((i, k) => [`${hh(D.h[i])}–${hh((D.h[i] + 1) % 24)}`, fmt(vals[k])]));
  return { mean, win, vals };
}
function kpi(l, v, unit, s, hero) {
  return `<div class="kpi${hero ? " hero" : ""}"><div class="l">${l}</div><div class="v">${v}${unit ? `<small>${unit}</small>` : ""}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
}
function renderHeute() {
  const now = Math.floor(Date.now() / 1000), L = local(now);
  const tIdx = dayIndices(L.y, L.m, L.d);
  const tm = new Date((now + offset(now)) * 1000); tm.setUTCDate(tm.getUTCDate() + 1);
  const mIdx = dayIndices(tm.getUTCFullYear(), tm.getUTCMonth(), tm.getUTCDate());
  document.getElementById("d-heute").textContent = `${WOCHENTAGE_LANG[L.dow]}, ${dateStr(L.y, L.m, L.d)}`;
  document.getElementById("d-morgen").textContent = `${WOCHENTAGE_LANG[tm.getUTCDay()]}, ${dateStr(tm.getUTCFullYear(), tm.getUTCMonth(), tm.getUTCDate())}`;

  let k = "";
  if (tIdx.length) {
    const nowPos = tIdx.findIndex(i => D.ts[i] <= now && now < D.ts[i] + H);
    const t = dayChart("c-heute", tIdx, nowPos, S.win);
    const cur = nowPos >= 0 ? t.vals[nowPos] : null;
    const mn = Math.min(...t.vals), mx = Math.max(...t.vals);
    const iMin = t.vals.indexOf(mn), iMax = t.vals.indexOf(mx);
    const d30 = periodFilter("d30"); let s = 0, c = 0; for (let i = 0; i < D.n; i++) if (d30(i) && D.ts[i] <= now) { s += D.v[i]; c++; }
    k += kpi("Jetzt", fmt(cur), "ct", cur != null ? (cur > t.mean ? `${nf0.format((cur / t.mean - 1) * 100)} % über Tages-Ø` : `${nf0.format((1 - cur / t.mean) * 100)} % unter Tages-Ø`) : "", true);
    k += kpi("Heute Ø", fmt(t.mean), "ct", einheit());
    k += kpi("Günstigste Stunde", fmt(mn), "ct", `${hh(D.h[tIdx[iMin]])}–${hh((D.h[tIdx[iMin]] + 1) % 24)}`);
    k += kpi("Teuerste Stunde", fmt(mx), "ct", `${hh(D.h[tIdx[iMax]])}–${hh((D.h[tIdx[iMax]] + 1) % 24)}`);
    k += kpi("30 Tage Ø", fmt(price(s / c)), "ct", "bis jetzt");
    document.getElementById("n-heute").textContent = t.win
      ? `Günstigstes ${S.win}-Stunden-Fenster ab jetzt: ${hh(D.h[tIdx[t.win.start]])}–${hh((D.h[tIdx[t.win.end]] + 1) % 24)} Uhr, Ø ${fmt(price(t.win.mean))} ct.`
      : "Heute bleiben weniger Stunden als das gewählte Fenster.";
  } else {
    document.getElementById("n-heute").textContent = "Für heute liegen keine Daten vor.";
  }
  if (mIdx.length) {
    const t = dayChart("c-morgen", mIdx, -1, S.win);
    k += kpi("Morgen Ø", fmt(t.mean), "ct", einheit());
    document.getElementById("n-morgen").textContent = t.win
      ? `Günstigstes ${S.win}-Stunden-Fenster: ${hh(D.h[mIdx[t.win.start]])}–${hh((D.h[mIdx[t.win.end]] + 1) % 24)} Uhr, Ø ${fmt(price(t.win.mean))} ct.` : "";
    document.getElementById("c-morgen").style.display = "";
  } else {
    k += kpi("Morgen Ø", "–", "", "ab ca. 13:00 Uhr");
    document.getElementById("n-morgen").textContent = "Die Preise für morgen werden von der Börse um ca. 13:00 Uhr veröffentlicht und erscheinen hier nach der nächsten Aktualisierung.";
    document.getElementById("c-morgen").style.display = "none";
  }
  document.getElementById("kpis").innerHTML = k;
}

// ---------- VERLAUF ----------
function monthly(filter) {
  const M = new Map();  // key y*12+m -> {sum,c, days: Map(dayKey->{sum,c})}
  for (let i = 0; i < D.n; i++) {
    if (!filter(i) || Number.isNaN(D.v[i])) continue;
    const k = D.y[i] * 12 + D.m[i];
    let e = M.get(k); if (!e) { e = { y: D.y[i], m: D.m[i], sum: 0, c: 0, days: new Map(), neg: 0, min: Infinity, max: -Infinity, iMin: -1, iMax: -1 }; M.set(k, e); }
    e.sum += D.v[i]; e.c++;
    if (D.v[i] < 0) e.neg++;
    if (D.v[i] < e.min) { e.min = D.v[i]; e.iMin = i; } if (D.v[i] > e.max) { e.max = D.v[i]; e.iMax = i; }
    const dk = D.d[i]; let de = e.days.get(dk); if (!de) { de = { sum: 0, c: 0 }; e.days.set(dk, de); }
    de.sum += D.v[i]; de.c++;
  }
  return [...M.keys()].sort((a, b) => a - b).map(k => {
    const e = M.get(k); const dm = [...e.days.values()].map(x => x.sum / x.c);
    return { ...e, mean: e.sum / e.c, dmin: Math.min(...dm), dmax: Math.max(...dm) };
  });
}
function renderVerlauf() {
  const now = Date.now() / 1000;
  const f = S.range === "all" ? () => true : (() => { const a = now - (+S.range) * 30.44 * 86400; return i => D.ts[i] >= a; })();
  const ms = monthly(f);
  const labels = ms.map(e => `${MONATE[e.m]} ${String(e.y).slice(2)}`);
  const mean = ms.map(e => price(e.mean)), lo = ms.map(e => price(e.dmin)), hi = ms.map(e => price(e.dmax));
  const o = base();
  o.grid.top = 30;
  o.tooltip.formatter = ps => { const i = ps[0].dataIndex, e = ms[i]; return `<b>${MONATE_LANG[e.m]} ${e.y}</b><br>Monatsmittel ${fmt(mean[i])}<br>Tagesmittel ${fmt(lo[i])} bis ${fmt(hi[i])}<br><span style="color:${css("--muted")}">${einheit()}</span>`; };
  o.xAxis.data = labels; o.xAxis.boundaryGap = false;
  o.xAxis.axisLabel.interval = (i) => ms[i].m === 0 || ms.length <= 14;
  o.xAxis.axisLabel.formatter = (val, i) => ms.length <= 14 ? val : String(ms[i].y);
  o.yAxis.name = einheit(); o.yAxis.nameTextStyle = { color: css("--muted"), fontSize: 11, align: "left" };
  o.series = [
    { type: "line", name: "lo", data: lo, stack: "band", symbol: "none", lineStyle: { opacity: 0 }, silent: true, tooltip: { show: false } },
    { type: "line", name: "band", data: hi.map((x, i) => x - lo[i]), stack: "band", symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: css("--series-1"), opacity: 0.14 }, silent: true, tooltip: { show: false } },
    { type: "line", name: "Monatsmittel", data: mean, symbol: "circle", symbolSize: 8, showSymbol: false, lineStyle: { width: 2, color: css("--series-1") }, itemStyle: { color: css("--series-1"), borderColor: css("--surface"), borderWidth: 2 },
      endLabel: { show: true, color: css("--text-2"), fontSize: 11, formatter: p => fmt(p.value) }, labelLayout: { moveOverlap: "shiftY" } },
  ];
  o.grid.right = 48;
  chart("c-monat", o);
  setTable("c-monat", ["Monat", "Ø", "Tagesmittel min", "Tagesmittel max", "Stunde min", "Stunde max", "Negative Stunden"],
    ms.map((e, i) => [`${MONATE[e.m]} ${e.y}`, fmt(mean[i]), fmt(lo[i]), fmt(hi[i]), fmt(price(e.min)), fmt(price(e.max)), e.neg]));

  // Jahresmittel (immer alle Jahre)
  const Y = new Map();
  for (let i = 0; i < D.n; i++) { if (Number.isNaN(D.v[i])) continue; let e = Y.get(D.y[i]); if (!e) { e = { sum: 0, c: 0, neg: 0, min: Infinity, max: -Infinity, gt30: 0 }; Y.set(D.y[i], e); }
    e.sum += D.v[i]; e.c++; if (D.v[i] < 0) e.neg++; if (D.v[i] > 30) e.gt30++; e.min = Math.min(e.min, D.v[i]); e.max = Math.max(e.max, D.v[i]); }
  const ys = [...Y.keys()].sort(), yv = ys.map(y => price(Y.get(y).sum / Y.get(y).c));
  const o2 = base();
  o2.tooltip.formatter = ps => `<b>${ps[0].name}</b><br>${fmt(ps[0].value)} ${einheit()}`;
  o2.xAxis.data = ys.map(y => y === local(META.letzter_utc).y && D.years.length ? `${y}*` : String(y));
  o2.yAxis.name = einheit(); o2.yAxis.nameTextStyle = { color: css("--muted"), fontSize: 11, align: "left" };
  o2.series = [{ type: "bar", data: yv, barMaxWidth: 56, itemStyle: { color: css("--series-1"), borderRadius: [4, 4, 0, 0] },
    label: { show: true, position: "top", color: css("--text-2"), fontSize: 12, formatter: p => fmt(p.value) } }];
  chart("c-jahr", o2);
  setTable("c-jahr", ["Jahr", "Ø", "Min (Stunde)", "Max (Stunde)", "Negative Stunden", "Stunden > 30 ct netto", "Stunden gesamt"],
    ys.map((y, i) => { const e = Y.get(y); return [y, fmt(yv[i]), fmt(price(e.min)), fmt(price(e.max)), e.neg, e.gt30, e.c]; }));
  document.querySelector("#c-jahr").closest(".card").querySelector(".note")?.remove();
  const note = document.createElement("p"); note.className = "note"; note.textContent = "* laufendes Jahr, bis " + local(META.letzter_utc).d + "." + (local(META.letzter_utc).m + 1) + ".";
  document.querySelector("#c-jahr").before(note);
}

// ---------- TAGESPROFIL ----------
function hourProfile(filter, groupFn, groups) {
  const acc = groups.map(() => Array.from({ length: 24 }, () => [0, 0]));
  for (let i = 0; i < D.n; i++) {
    if (!filter(i) || Number.isNaN(D.v[i])) continue;
    const g = groupFn(i); if (g < 0) continue;
    acc[g][D.h[i]][0] += D.v[i]; acc[g][D.h[i]][1]++;
  }
  return acc.map(a => a.map(([s, c]) => c ? price(s / c) : null));
}
function renderProfil() {
  const f = periodFilter(S.pPeriod);
  let groups, gfn, colors;
  if (S.pSplit === "wd") { groups = ["Werktag", "Wochenende"]; gfn = i => (D.dow[i] === 0 || D.dow[i] === 6) ? 1 : 0; colors = ["--series-1", "--series-2"]; }
  else if (S.pSplit === "season") { groups = ["Winter", "Frühling", "Sommer", "Herbst"]; gfn = i => [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 0][D.m[i]]; colors = ["--series-1", "--series-3", "--series-4", "--series-2"]; }
  else { groups = ["Alle Tage"]; gfn = () => 0; colors = ["--series-1"]; }
  const data = hourProfile(f, gfn, groups);
  const narrow = window.innerWidth < 600;
  const o = base();
  o.grid.right = narrow ? 12 : 84; o.grid.top = groups.length > 1 ? 44 : 30;
  o.tooltip.formatter = ps => `<b>${ps[0].name}–${hh((+ps[0].name.slice(0, 2) + 1) % 24)}</b><br>` + ps.map(p => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px"></span>${p.seriesName}: ${fmt(p.value)}`).join("<br>");
  o.xAxis.data = Array.from({ length: 24 }, (_, h) => hh(h)); o.xAxis.boundaryGap = false; o.xAxis.axisLabel.interval = narrow ? 3 : 1;
  o.yAxis.name = einheit(); o.yAxis.nameTextStyle = { color: css("--muted"), fontSize: 11, align: "left" };
  if (groups.length > 1) o.legend = { top: 0, left: 0, icon: "circle", itemWidth: 8, itemHeight: 8, textStyle: { color: css("--text-2"), fontSize: 12 } };
  o.series = groups.map((g, k) => ({
    type: "line", name: g, data: data[k], symbol: "circle", symbolSize: 8, showSymbol: false, smooth: 0.25,
    lineStyle: { width: 2, color: css(colors[k]) }, itemStyle: { color: css(colors[k]), borderColor: css("--surface"), borderWidth: 2 },
    endLabel: { show: !narrow, color: css("--text-2"), fontSize: 11, formatter: p => p.seriesName }, labelLayout: { moveOverlap: "shiftY" },
  }));
  chart("c-profil", o);
  setTable("c-profil", ["Stunde", ...groups], Array.from({ length: 24 }, (_, h) => [`${hh(h)}–${hh((h + 1) % 24)}`, ...data.map(d => fmt(d[h]))]));
}

// ---------- HEATMAP ----------
function renderHeatmap() {
  const yr = +S.hYear, dayGrain = S.hGrain === "day";
  document.getElementById("h-title").textContent = dayGrain ? "Tag" : "Monat";
  const rows = new Map();  // rowKey -> label
  const acc = new Map();   // rowKey*24+h -> [sum,c]
  for (let i = 0; i < D.n; i++) {
    if (D.y[i] !== yr || Number.isNaN(D.v[i])) continue;
    const rk = dayGrain ? D.m[i] * 31 + (D.d[i] - 1) : D.m[i];
    if (!rows.has(rk)) rows.set(rk, dayGrain ? `${String(D.d[i]).padStart(2, "0")}.${String(D.m[i] + 1).padStart(2, "0")}.` : MONATE[D.m[i]]);
    const k = rk * 24 + D.h[i]; const e = acc.get(k) || [0, 0]; e[0] += D.v[i]; e[1]++; acc.set(k, e);
  }
  const rowKeys = [...rows.keys()].sort((a, b) => a - b), rowIdx = new Map(rowKeys.map((k, i) => [k, i]));
  const data = []; const vals = [];
  for (const [k, [s, c]] of acc) { const v = price(s / c); data.push([k % 24, rowIdx.get(Math.floor(k / 24)), +v.toFixed(2)]); vals.push(v); }
  vals.sort((a, b) => a - b);
  const q = p => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  const vmin = q(0.02), vmax = q(0.98);
  const o = base();
  o.tooltip.trigger = "item"; o.tooltip.axisPointer = undefined;
  o.tooltip.formatter = p => `<b>${rows.get(rowKeys[p.value[1]])}${dayGrain ? yr : " " + yr}, ${hh(p.value[0])}–${hh((p.value[0] + 1) % 24)}</b><br>${fmt(p.value[2])} ${einheit()}`;
  o.grid = { left: 8, right: 12, top: 8, bottom: 56, containLabel: true };
  o.xAxis = { ...o.xAxis, data: Array.from({ length: 24 }, (_, h) => hh(h)), splitArea: { show: false }, axisLabel: { ...o.xAxis.axisLabel, interval: window.innerWidth < 600 ? 3 : 1 }, position: "top", axisLine: { show: false } };
  o.yAxis = { type: "category", data: rowKeys.map(k => rows.get(k)), inverse: true, axisTick: { show: false }, axisLine: { show: false },
    axisLabel: { color: css("--muted"), fontSize: 11, interval: dayGrain ? (i, v) => v.startsWith("01.") : 0, formatter: v => dayGrain ? MONATE[+v.slice(3, 5) - 1] : v } };
  o.visualMap = { type: "continuous", min: vmin, max: vmax, dimension: 2, orient: "horizontal", left: "center", bottom: 0, itemWidth: 10, itemHeight: 180,
    inRange: { color: seqRamp() }, text: [`${fmt(vmax)}+`, `≤ ${fmt(vmin)}`], textStyle: { color: css("--muted"), fontSize: 11 }, calculable: false };
  o.series = [{ type: "heatmap", data, progressive: 0, itemStyle: dayGrain ? {} : { borderColor: css("--surface"), borderWidth: 2, borderRadius: 2 }, emphasis: { itemStyle: { borderColor: css("--text"), borderWidth: 1 } } }];
  document.getElementById("c-heat").style.height = (dayGrain ? Math.max(520, rowKeys.length * 2.2 + 110) : 420) + "px";
  if (charts["c-heat"]) charts["c-heat"].resize();
  chart("c-heat", o);
  const grid = rowKeys.map((rk, r) => [rows.get(rk), ...Array.from({ length: 24 }, (_, h) => { const e = acc.get(rk * 24 + h); return e ? fmt(price(e[0] / e[1])) : "–"; })]);
  setTable("c-heat", [dayGrain ? "Tag" : "Monat", ...Array.from({ length: 24 }, (_, h) => String(h))], grid);
}

// ---------- STATISTIK ----------
function renderStatistik() {
  const f = periodFilter(S.sPeriod), th = S.sThresh;
  document.getElementById("n-peak").textContent = `Stunden mit Nettopreis über ${th} ct/kWh.`;
  const M = new Map(); const dow = Array.from({ length: 7 }, () => [0, 0]);
  let sum = 0, c = 0, neg = 0, gt = 0, iMin = -1, iMax = -1;
  const top = [], bottom = [];
  for (let i = 0; i < D.n; i++) {
    if (!f(i) || Number.isNaN(D.v[i])) continue;
    const v = D.v[i];
    sum += v; c++; if (v < 0) neg++; if (v > th) gt++;
    if (iMin < 0 || v < D.v[iMin]) iMin = i; if (iMax < 0 || v > D.v[iMax]) iMax = i;
    dow[D.dow[i]][0] += v; dow[D.dow[i]][1]++;
    const k = D.y[i] * 12 + D.m[i]; const e = M.get(k) || { y: D.y[i], m: D.m[i], neg: 0, gt: 0 }; if (v < 0) e.neg++; if (v > th) e.gt++; M.set(k, e);
    // Top/Bottom 5
    if (top.length < 5 || v > D.v[top[top.length - 1]]) { top.push(i); top.sort((a, b) => D.v[b] - D.v[a]); if (top.length > 5) top.pop(); }
    if (bottom.length < 5 || v < D.v[bottom[bottom.length - 1]]) { bottom.push(i); bottom.sort((a, b) => D.v[a] - D.v[b]); if (bottom.length > 5) bottom.pop(); }
  }
  const ms = [...M.keys()].sort((a, b) => a - b).map(k => M.get(k));
  const labels = ms.map(e => `${MONATE[e.m]} ${String(e.y).slice(2)}`);
  document.getElementById("s-kpis").innerHTML =
    kpi("Ø im Zeitraum", fmt(price(sum / c)), "ct", einheit()) +
    kpi("Negative Stunden", nf0.format(neg), "", `${nf1.format(neg / c * 100)} % aller Stunden`) +
    kpi(`Stunden > ${th} ct`, nf0.format(gt), "", `${nf1.format(gt / c * 100)} % aller Stunden`) +
    kpi("Stunden gesamt", nf0.format(c), "", `${nf0.format(c / 24)} Tage`);

  const bar = (id, vals, color, name) => {
    const o = base();
    o.tooltip.formatter = ps => { const e = ms[ps[0].dataIndex]; return `<b>${MONATE_LANG[e.m]} ${e.y}</b><br>${ps[0].value} ${name}`; };
    o.xAxis.data = labels; o.xAxis.axisLabel.interval = i => ms.length <= 14 || ms[i].m === 0; o.xAxis.axisLabel.formatter = (v, i) => ms.length <= 14 ? v : String(ms[i].y);
    o.yAxis.name = "Stunden"; o.yAxis.nameTextStyle = { color: css("--muted"), fontSize: 11, align: "left" }; o.yAxis.minInterval = 1;
    o.series = [{ type: "bar", data: vals, itemStyle: { color: css(color), borderRadius: [3, 3, 0, 0] }, barCategoryGap: ms.length > 30 ? "10%" : "25%" }];
    chart(id, o);
  };
  bar("c-neg", ms.map(e => e.neg), "--series-1", "Stunden mit negativem Preis");
  bar("c-peak", ms.map(e => e.gt), "--series-2", `Stunden über ${th} ct`);
  setTable("c-neg", ["Monat", "Negative Stunden"], ms.map((e, i) => [labels[i], e.neg]));
  setTable("c-peak", ["Monat", `Stunden > ${th} ct`], ms.map((e, i) => [labels[i], e.gt]));

  const order = [1, 2, 3, 4, 5, 6, 0];
  const dv = order.map(d => dow[d][1] ? price(dow[d][0] / dow[d][1]) : null);
  const o = base();
  o.tooltip.formatter = ps => `<b>${WOCHENTAGE_LANG[order[ps[0].dataIndex]]}</b><br>${fmt(ps[0].value)} ${einheit()}`;
  o.xAxis.data = order.map(d => WOCHENTAGE[d]);
  o.yAxis.name = einheit(); o.yAxis.nameTextStyle = { color: css("--muted"), fontSize: 11, align: "left" };
  const dmin = Math.min(...dv.filter(x => x != null)); o.yAxis.min = Math.floor(Math.min(0, dmin));
  o.series = [{ type: "bar", data: dv, barMaxWidth: 56, itemStyle: { color: css("--series-1"), borderRadius: [4, 4, 0, 0] }, label: { show: true, position: "top", color: css("--text-2"), fontSize: 12, formatter: p => fmt(p.value) } }];
  chart("c-dow", o);
  setTable("c-dow", ["Wochentag", einheit()], order.map((d, i) => [WOCHENTAGE_LANG[d], fmt(dv[i])]));

  const li = i => `<li><b>${fmt(price(D.v[i]))}</b> ct · ${WOCHENTAGE[D.dow[i]]} ${dateStr(D.y[i], D.m[i], D.d[i])}, ${hh(D.h[i])}–${hh((D.h[i] + 1) % 24)}</li>`;
  document.getElementById("records").innerHTML =
    `<div><h3>Teuerste Stunden</h3><ol>${top.map(li).join("")}</ol></div><div><h3>Günstigste Stunden</h3><ol>${bottom.map(li).join("")}</ol></div>`;
}

// ---------- Rendering / Navigation ----------
const RENDER = { heute: renderHeute, verlauf: renderVerlauf, profil: renderProfil, heatmap: renderHeatmap, statistik: renderStatistik };
function showTab(t) {
  if (!RENDER[t]) t = "heute";
  S.tab = t;
  document.querySelectorAll(".tab").forEach(s => s.hidden = s.id !== "tab-" + t);
  document.querySelectorAll(".tabs a").forEach(a => a.setAttribute("aria-selected", a.dataset.tab === t));
  if (D) { RENDER[t](); requestAnimationFrame(() => Object.values(charts).forEach(c => c.resize())); }
}
function rerender() { if (D) RENDER[S.tab](); }

function seg(id, key, cb) {
  const el = document.getElementById(id);
  el.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    el.querySelectorAll("button").forEach(x => x.setAttribute("aria-checked", x === b));
    S[key] = b.dataset.v; cb && cb(b.dataset.v); rerender();
  });
}

function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  Object.values(charts).forEach(c => c.dispose()); for (const k in charts) delete charts[k];
  rerender();
}

async function init() {
  // Theme
  try { const t = localStorage.getItem("theme"); if (t) document.documentElement.dataset.theme = t; } catch (_) {}
  document.getElementById("theme").addEventListener("click", () => {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const cur = document.documentElement.dataset.theme || (dark ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    try { localStorage.setItem("theme", next); } catch (_) {}
    applyTheme(next);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (!document.documentElement.dataset.theme) applyTheme(null); });

  seg("mode", "mode", v => { try { localStorage.setItem("mode", v); } catch (_) {} });
  try { const m = localStorage.getItem("mode"); if (m) { S.mode = m; document.querySelectorAll("#mode button").forEach(b => b.setAttribute("aria-checked", b.dataset.v === m)); } } catch (_) {}
  seg("range", "range"); seg("p-split", "pSplit"); seg("h-grain", "hGrain");
  document.getElementById("win").addEventListener("change", e => { S.win = +e.target.value; rerender(); });
  document.getElementById("p-period").addEventListener("change", e => { S.pPeriod = e.target.value; rerender(); });
  document.getElementById("s-period").addEventListener("change", e => { S.sPeriod = e.target.value; rerender(); });
  document.getElementById("s-thresh").addEventListener("change", e => { S.sThresh = +e.target.value; rerender(); });
  document.getElementById("h-year").addEventListener("change", e => { S.hYear = e.target.value; rerender(); });
  document.querySelectorAll(".tbl-btn").forEach(b => b.addEventListener("click", () => {
    const box = document.getElementById("t-" + b.dataset.tbl); box.hidden = !box.hidden; b.setAttribute("aria-pressed", !box.hidden); if (!box.hidden) renderTable(b.dataset.tbl);
  }));
  window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { Object.values(charts).forEach(c => c.resize()); rerender(); }, 150); });

  try {
    await load();
  } catch (e) {
    const st = document.getElementById("status"); st.className = "status error"; st.textContent = "Daten konnten nicht geladen werden: " + e.message; return;
  }
  document.getElementById("status").remove();
  fillPeriodSelect(document.getElementById("p-period")); fillPeriodSelect(document.getElementById("s-period"));
  const hy = document.getElementById("h-year"); hy.innerHTML = [...D.years].reverse().map(y => `<option value="${y}">${y}</option>`).join(""); S.hYear = String(D.years[D.years.length - 1]);
  const upd = new Date(META.aktualisiert_utc), lastL = local(META.letzter_utc);
  document.getElementById("stand").textContent = `Stand: ${upd.toLocaleString("de-AT", { timeZone: "Europe/Vienna", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })} Uhr · Daten bis ${dateStr(lastL.y, lastL.m, lastL.d)} ${hh(lastL.h)} · ${nf0.format(META.stunden)} Stunden seit ${dateStr(local(META.erster_utc).y, 0, 1)}${META.luecken ? ` · ${META.luecken} Lücken` : " · lückenlos"}`;
  showTab(location.hash.slice(1) || "heute");
}
init();
