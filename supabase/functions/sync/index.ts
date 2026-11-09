// Supabase Edge Function "sync": holt täglich neue Daten von Netz NÖ, FusionSolar und eFriends.
//
// Zugangsdaten ausschließlich als Edge-Function-Secrets (Dashboard → Edge Functions → Secrets):
//   NETZNOE_USER, NETZNOE_PASSWORT            Login smartmeter.netz-noe.at
//   FUSIONSOLAR_USER, FUSIONSOLAR_PASSWORT    Login FusionSolar
//   EFRIENDS_API_KEY                          eFriends-App → API Manager
//   MONTA_CLIENT_ID, MONTA_CLIENT_SECRET      Monta Hub → Profil → Applications (offizielle Public API)
// Nicht geheime Einstellungen stehen in public.sync_einstellung.
// Fehlt ein Secret, wird die Quelle übersprungen. Ergebnis jedes Laufs → public.sync_lauf.
//
// Aufruf: POST /functions/v1/sync
//   - vom Zeitplan (pg_cron) ohne Anmeldung: läuft höchstens alle 3 Stunden
//   - aus der Web-App mit Benutzer-Token: höchstens alle 10 Minuten, nur für freigeschaltete Benutzer
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

function dienstSchluessel(): string {
  const alt = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (alt) return alt;
  try { const neu = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return neu.default || Object.values(neu)[0] as string; } catch { return ""; }
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, dienstSchluessel(), { auth: { persistSession: false, autoRefreshToken: false } });
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const TAG = 86400e3;

// ---------------------------------------------------------------- Zeit (Europe/Vienna)
const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Vienna", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function wienOffset(utcMs: number): number {
  const p = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(utcMs / 60000) * 60000;
}
/** Lokale Wiener Zeit → UTC-ms. ende=true: Zeitpunkt ist ein Intervall-Ende. dst bekannt oder null (dann nach Reihenfolge). */
function wienUtc(s: string, opt: { dst?: boolean | null; nach?: number | null; ende?: boolean } = {}): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (opt.dst === true) return base - 7200e3;
  if (opt.dst === false) return base - 3600e3;
  const kand = [base - 7200e3, base - 3600e3].filter((c) => wienOffset(opt.ende ? c - 1000 : c) === base - c);
  const ok = kand.filter((c) => opt.nach == null || c > opt.nach);
  return ok.length ? Math.min(...ok) : kand.length ? kand[0] : null;
}
function wienMitternacht(y: number, m: number, d: number): number {
  return wienUtc(`${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}T00:00`)!;
}
function wienDatum(utcMs: number) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month - 1, d: +p.day, iso: `${p.year}-${p.month}-${p.day}` };
}
function tageAb(startIso: string, bisIso: string): { y: number; m: number; d: number; iso: string }[] {
  const out = [];
  for (let t = Date.parse(startIso + "T12:00:00Z"); t <= Date.parse(bisIso + "T12:00:00Z"); t += TAG) {
    const d = new Date(t);
    out.push({ y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), iso: d.toISOString().slice(0, 10) });
  }
  return out;
}
const isoMinus = (iso: string, tage: number) => new Date(Date.parse(iso + "T12:00:00Z") - tage * TAG).toISOString().slice(0, 10);

// ---------------------------------------------------------------- HTTP mit Cookie-Speicher
class Sitzung {
  cookies = new Map<string, string>();
  async req(url: string, init: RequestInit & { json?: unknown } = {}, folgen = 5): Promise<Response> {
    const h = new Headers(init.headers);
    h.set("User-Agent", UA);
    h.set("Accept", h.get("Accept") || "application/json, text/plain, */*");
    if (this.cookies.size) h.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    let body = init.body;
    if (init.json !== undefined) { body = JSON.stringify(init.json); h.set("Content-Type", "application/json"); }
    const r = await fetch(url, { ...init, body, headers: h, redirect: "manual" });
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";"); const i = kv.indexOf("=");
      if (i > 0) this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get("location") && folgen > 0) {
      await r.body?.cancel();
      return this.req(new URL(r.headers.get("location")!, url).toString(), { method: "GET", headers: init.headers }, folgen - 1);
    }
    return r;
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function upsert(tabelle: string, rows: Record<string, unknown>[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from(tabelle).upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(`${tabelle}: ${error.message}`);
  }
  return rows.length;
}
async function einstellung(k: string): Promise<string | null> {
  const { data } = await db.from("sync_einstellung").select("wert").eq("schluessel", k).maybeSingle();
  return data?.wert ?? null;
}

// ---------------------------------------------------------------- Netz NÖ
async function netzNoe() {
  const user = Deno.env.get("NETZNOE_USER"), pwd = Deno.env.get("NETZNOE_PASSWORT");
  if (!user || !pwd) return { übersprungen: "NETZNOE_USER/NETZNOE_PASSWORT fehlen" };
  const B = "https://smartmeter.netz-noe.at/orchestration";
  const s = new Sitzung();
  const xsrf = () => s.cookies.get("XSRF-TOKEN") ? { "X-XSRF-TOKEN": decodeURIComponent(s.cookies.get("XSRF-TOKEN")!) } : {};
  const login = await s.req(`${B}/Authentication/Login`, { method: "POST", json: { user, pwd } });
  if (!login.ok) throw new Error(`Login Netz NÖ fehlgeschlagen (HTTP ${login.status})`);
  await login.body?.cancel();
  const info = await s.req(`${B}/User/GetBasicInfo`, { headers: xsrf() }); await info.body?.cancel();

  // Zählpunkte und letzter Stand je Richtung aus der Datenbank
  const ergebnis: Record<string, unknown> = {};
  const gestern = wienDatum(Date.now() - TAG).iso;
  for (const richtung of ["bezug", "einspeisung"]) {
    const { data: zp } = await db.from("netz_15min").select("zaehlpunkt, ts_start").eq("richtung", richtung).not("zaehlpunkt", "is", null).order("ts_start", { ascending: false }).limit(1).maybeSingle();
    const zaehlpunkt = zp?.zaehlpunkt || await einstellung(`netznoe_zp_${richtung}`);
    if (!zaehlpunkt) { ergebnis[richtung] = "kein Zählpunkt bekannt"; continue; }
    const ab = zp ? isoMinus(wienDatum(Date.parse(zp.ts_start)).iso, 3) : isoMinus(gestern, 30);
    const rows: Record<string, unknown>[] = [];
    let last: number | null = null, tage = 0;
    for (const t of tageAb(ab, gestern)) {
      const r = await s.req(`${B}/ConsumptionRecord/Day?meterId=${encodeURIComponent(zaehlpunkt)}&day=${t.y}-${t.m + 1}-${t.d}`, { headers: xsrf() });
      if (r.status === 401) throw new Error("Netz NÖ: Sitzung abgelaufen");
      const j = await r.json().catch(() => null);
      const d = Array.isArray(j) ? j[0] : j;
      const v = d?.meteredValues || [], e = d?.estimatedValues || [], ts = d?.peakDemandTimes || [];
      let n = 0;
      for (let i = 0; i < v.length; i++) {
        let val = v[i], est = false;
        if (val == null && e[i] != null) { val = e[i]; est = true; }
        if (val == null || !ts[i]) continue;
        const ende = wienUtc(ts[i], { nach: last, ende: true });
        if (ende == null) continue;
        last = ende; n++;
        rows.push({ ts_start: new Date(ende - 900e3).toISOString(), richtung, kwh: +val, geschaetzt: est, zaehlpunkt, geaendert: new Date().toISOString() });
      }
      if (n) tage++;
      await pause(300);
    }
    ergebnis[richtung] = { ab, bis: gestern, tage_mit_werten: tage, viertelstunden: await upsert("netz_15min", rows, "ts_start,richtung") };
  }
  await s.req(`${B}/Authentication/Logout`, { method: "GET", headers: xsrf() }).then((r) => r.body?.cancel()).catch(() => {});
  return ergebnis;
}

// ---------------------------------------------------------------- FusionSolar
function pemZuSpki(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (!/BEGIN RSA PUBLIC KEY/.test(pem)) return der;             // bereits SPKI
  // PKCS#1 → SPKI einpacken
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const len = (n: number) => n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  const bitStr = [0x03, ...len(der.length + 1), 0x00, ...der];
  const inner = [...algId, ...bitStr];
  return new Uint8Array([0x30, ...len(inner.length), ...inner]);
}
async function fusionSolar() {
  const user = Deno.env.get("FUSIONSOLAR_USER"), pwd = Deno.env.get("FUSIONSOLAR_PASSWORT");
  if (!user || !pwd) return { übersprungen: "FUSIONSOLAR_USER/FUSIONSOLAR_PASSWORT fehlen" };
  const loginHost = (await einstellung("fusionsolar_login_host")) || "eu5.fusionsolar.huawei.com";
  const station = (await einstellung("fusionsolar_station")) || "";
  if (!station) return { übersprungen: "fusionsolar_station fehlt in sync_einstellung" };
  const s = new Sitzung();

  // 1) Anmelden wie die Webseite: Passwort URL-kodiert, in 270-Zeichen-Blöcken RSA-OAEP/SHA-384, Blöcke mit "00000001" verbunden, + version
  const pk = await (await s.req(`https://${loginHost}/unisso/pubkey`)).json();
  if (!pk.enableEncrypt) throw new Error("FusionSolar: unverschlüsselter Login (v2) wird nicht unterstützt");
  const key = await crypto.subtle.importKey("spki", pemZuSpki(pk.pubKey), { name: "RSA-OAEP", hash: "SHA-384" }, false, ["encrypt"]);
  const quote = (x: string) => encodeURIComponent(x).replace(/%2F/g, "/").replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const kodiert = quote(pwd);
  const bloecke: string[] = [];
  for (let i = 0; i < Math.floor(kodiert.length / 270) + 1; i++) {
    const enc = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, new TextEncoder().encode(kodiert.slice(i * 270, (i + 1) * 270))));
    let bin = ""; for (const b of enc) bin += String.fromCharCode(b);
    bloecke.push(btoa(bin));
  }
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const lr = await s.req(`https://${loginHost}/unisso/v3/validateUser.action?timeStamp=${pk.timeStamp}&nonce=${nonce}`,
    { method: "POST", json: { organizationName: "", username: user, password: bloecke.join("00000001") + pk.version } });
  const lj = await lr.json().catch(() => ({}));
  let datenHost = (await einstellung("fusionsolar_daten_host")) || "";
  if (String(lj.errorCode) === "470" && lj.respMultiRegionName?.[1]) {
    // 470 = Anmeldung ok, Region-Weiterleitung folgen
    const r = await s.req(`https://${loginHost}${lj.respMultiRegionName[1]}`);
    if (!datenHost) datenHost = new URL(r.url).host;
    await r.body?.cancel();
  } else if (lj.errorMsg || (lj.errorCode && String(lj.errorCode) !== "0")) {
    const msg = String(lj.errorMsg || "");
    if (/verification code/i.test(msg)) throw new Error("FusionSolar verlangt ein Captcha – bitte einmal im Browser anmelden, dann erneut versuchen");
    throw new Error(`FusionSolar-Login abgelehnt (errorCode ${lj.errorCode}${msg ? ": " + msg : ""})`);
  } else if (lj.redirectURL) {
    const r = await s.req(new URL(lj.redirectURL, `https://${loginHost}`).toString());
    if (!datenHost) datenHost = new URL(r.url).host;
    await r.body?.cancel();
  }
  if (!datenHost) datenHost = loginHost;
  const ka = await s.req(`https://${datenHost}/rest/dpcloud/auth/v1/keep-alive`);
  const kaJ = await ka.json().catch(() => ({}));
  if (kaJ.code !== 0 && kaJ.code !== "0") throw new Error(`FusionSolar: Sitzung nach Login ungültig (keep-alive ${ka.status}, Host ${datenHost})`);
  const hdr: Record<string, string> = kaJ.payload ? { roarand: String(kaJ.payload) } : {};

  // 2) Ab wann holen?
  const heute = wienDatum(Date.now()).iso;
  const { data: l15 } = await db.from("pv_15min").select("ts_start").order("ts_start", { ascending: false }).limit(1).maybeSingle();
  const ab = l15 ? isoMinus(wienDatum(Date.parse(l15.ts_start)).iso, 1) : isoMinus(heute, 7);
  const num = (x: unknown) => (x == null || x === "--" || x === "") ? null : +x;
  const felder: [string, string][] = [["pv_wh", "productPower"], ["verbrauch_wh", "usePower"], ["eigen_wh", "selfUsePower"], ["laden_wh", "chargePower"], ["entladen_wh", "dischargePower"]];
  const q = new Map<number, Record<string, number>>();
  const tagRows: Record<string, unknown>[] = [];
  for (const t of tageAb(ab, heute)) {
    const u = `https://${datenHost}/rest/pvms/web/station/v3/overview/energy-balance?stationDn=${encodeURIComponent(station)}&timeDim=2&timeZone=1.0&timeZoneStr=Europe%2FVienna&queryTime=${wienMitternacht(t.y, t.m, t.d)}&dateStr=${encodeURIComponent(t.iso + " 00:00:00")}&_=${Date.now()}`;
    const r = await s.req(u, { headers: hdr });
    const j = await r.json().catch(() => null);
    if (!j?.success) throw new Error(`FusionSolar-Daten ${t.iso}: HTTP ${r.status}`);
    const d = j.data || {};
    (d.xAxis || []).forEach((x: string, i: number) => {
      const utc = wienUtc(x, { dst: /DST/.test(x) }); if (utc == null) return;
      const b = utc - (utc % 900e3);
      for (const [f, k] of felder) {
        const kw = num(d[k]?.[i]); if (kw == null) continue;
        const e = q.get(b) || {}; e[f] = (e[f] || 0) + kw * 1000 / 12; q.set(b, e);
      }
    });
    tagRows.push({ tag: t.iso, pv_kwh: num(d.totalProductPower), verbrauch_kwh: num(d.totalUsePower), eigen_kwh: num(d.totalSelfUsePower),
      einspeisung_kwh: num(d.totalOnGridPower), bezug_kwh: num(d.totalBuyPower), geaendert: new Date().toISOString() });
    await pause(700);
  }
  // Tageswerte Laden/Entladen aus der Monatsansicht ergänzen
  const monate = [...new Set(tagRows.map((r) => String(r.tag).slice(0, 7)))];
  for (const mon of monate) {
    const [y, m] = mon.split("-").map(Number);
    const u = `https://${datenHost}/rest/pvms/web/station/v3/overview/energy-balance?stationDn=${encodeURIComponent(station)}&timeDim=4&timeZone=1.0&timeZoneStr=Europe%2FVienna&queryTime=${wienMitternacht(y, m - 1, 1)}&dateStr=${encodeURIComponent(mon + "-01 00:00:00")}&_=${Date.now()}`;
    const j = await (await s.req(u, { headers: hdr })).json().catch(() => null);
    const d = j?.data || {};
    (d.xAxis || []).forEach((x: string, i: number) => {
      const r = tagRows.find((t) => t.tag === `${mon}-${String(x).padStart(2, "0")}`);
      if (r) { r.laden_kwh = num(d.chargePower?.[i]); r.entladen_kwh = num(d.dischargePower?.[i]); }
    });
    await pause(700);
  }
  const rows15 = [...q.entries()].sort((a, b) => a[0] - b[0]).map(([b, e]) => ({ ts_start: new Date(b).toISOString(),
    ...Object.fromEntries(felder.map(([f]) => [f, e[f] != null ? +e[f].toFixed(1) : null])), geaendert: new Date().toISOString() }));
  const ohneNull = tagRows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)));
  return { ab, bis: heute, daten_host: datenHost, viertelstunden: await upsert("pv_15min", rows15, "ts_start"), tage: await upsert("pv_tag", ohneNull, "tag") };
}

// ---------------------------------------------------------------- eFriends
// Die Messdaten-Downloads akzeptieren den API-Manager-Schlüssel nicht (nur App-Sitzung). Laufende Daten kommen daher
// über den Live-Sammler (pg_cron, alle 10 s vom Cube) und die Flex-Preise (pg_cron) – beide lesen den Schlüssel
// aus dem Vault. Diese Funktion hält den Vault-Eintrag synchron mit dem Edge-Secret und meldet den Stand.
async function eFriends() {
  const key = Deno.env.get("EFRIENDS_API_KEY");
  if (!key) return { übersprungen: "EFRIENDS_API_KEY fehlt" };
  const { error } = await db.rpc("sync_vault_setzen", { p_name: "efriends_api_key", p_wert: key });
  if (error) throw new Error(`Vault: ${error.message}`);
  const { data: st } = await db.rpc("sync_efriends_stand");
  return { vault: "Schlüssel aktuell", ...(st || {}) };
}

// ---------------------------------------------------------------- Monta (offizielle Public API, max. 10 Anfragen/Minute)
async function monta() {
  const id = Deno.env.get("MONTA_CLIENT_ID"), secret = Deno.env.get("MONTA_CLIENT_SECRET");
  if (!id || !secret) return { übersprungen: "MONTA_CLIENT_ID/MONTA_CLIENT_SECRET fehlen" };
  const boxen = Object.fromEntries(((await einstellung("monta_wallboxen")) || "").split(",").filter(Boolean).map((x) => { const [i, ...n] = x.split(":"); return [i.trim(), n.join(":").trim()]; }));
  if (!Object.keys(boxen).length) return { übersprungen: "monta_wallboxen fehlt in sync_einstellung" };
  const API = "https://public-api.monta.com/api/v1";
  let letzteAnfrage = 0;
  const takt = async () => { const w = letzteAnfrage + 6500 - Date.now(); if (w > 0) await pause(w); letzteAnfrage = Date.now(); };
  await takt();
  const tr = await fetch(`${API}/auth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: id, clientSecret: secret }) });
  if (!tr.ok) throw new Error(`Monta-Token: HTTP ${tr.status}`);
  const auth = { Authorization: `Bearer ${(await tr.json()).accessToken}`, Accept: "application/json" };
  // Große Ganzzahl-IDs als Text lesen (JSON-Zahlen > 2^53 würden verfälscht)
  const json = async (r: Response) => JSON.parse((await r.text()).replace(/"(id|chargeId|chargePointId)"\s*:\s*(\d{15,})/g, '"$1":"$2"'));
  const zuCent = (x: unknown) => x == null ? null : Math.round(+x * 100);   // Public API liefert Beträge in Euro (Prüfung beim ersten Lauf)

  const ergebnis: Record<string, unknown> = {};
  const neueLadungen: { id: string; wallbox_id: number; start: string }[] = [];
  for (const [cp, name] of Object.entries(boxen)) {
    const { data: l } = await db.from("laden").select("start").eq("wallbox_id", +cp).order("start", { ascending: false }).limit(1).maybeSingle();
    // Alte (importierte) Ladungen ohne Monta-Kennung? Dann einmalig die ganze Liste holen.
    const { count: ohneId } = await db.from("laden").select("start", { count: "exact", head: true }).eq("wallbox_id", +cp).is("monta_id", null);
    const ab = ohneId ? "2020-01-01T00:00:00Z" : new Date((l ? Date.parse(l.start) : Date.now() - 30 * TAG) - 2 * TAG).toISOString().replace(/\.\d+Z$/, "Z");
    const liste: any[] = [];
    for (let page = 0; page < 10; page++) {
      await takt();
      const r = await fetch(`${API}/charges?chargePointId=${cp}&fromDate=${ab}&perPage=100&page=${page}`, { headers: auth });
      if (!r.ok) throw new Error(`Monta-Ladevorgänge ${name}: HTTP ${r.status}`);
      const j = await json(r);
      liste.push(...(j.data || []));
      if (page + 1 >= (j.meta?.totalPageCount ?? 1)) break;
    }
    const rows = [];
    for (const c of liste) {
      const isoOk = (x: unknown) => (x && Number.isFinite(Date.parse(String(x)))) ? new Date(Date.parse(String(x))).toISOString() : null;
      const start = isoOk(c.startedAt) || isoOk(c.cablePluggedInAt) || isoOk(c.createdAt);
      if (!start) continue;
      // Gleiche Ladung aus dem früheren Import (anderer Startzeitpunkt) über den Zählerstand wiedererkennen
      let key = start;
      if (c.startMeterKwh != null) {
        const { data: alt } = await db.from("laden").select("start").eq("wallbox_id", +cp).gte("zaehler_start", c.startMeterKwh - 0.0005).lte("zaehler_start", +c.startMeterKwh + 0.0005).limit(1).maybeSingle();
        if (alt) key = alt.start;
      }
      rows.push({ wallbox_id: +cp, start: key, wallbox: name, ende: isoOk(c.stoppedAt), voll: isoOk(c.fullyChargedAt), kwh: c.consumedKwh,
        zaehler_start: c.startMeterKwh, zaehler_ende: c.endMeterKwh, soc_start: c.soc?.percentage ?? null, preis_cent: zuCent(c.price), kosten_cent: zuCent(c.cost),
        preis_kwh_cent: zuCent(c.averagePricePerKwh), status: c.state, start_quelle: "public-api", monta_id: String(c.id), geaendert: new Date().toISOString() });
      if ((c.state === "completed" || c.state === "stopped") && key === start && Date.parse(start) > Date.now() - 3 * TAG) neueLadungen.push({ id: String(c.id), wallbox_id: +cp, start: key });
    }
    const eindeutig = [...new Map(rows.map((r) => [`${r.wallbox_id}|${r.start}`, r])).values()];
    ergebnis[name] = { ab, ladevorgaenge: await upsert("laden", eindeutig, "wallbox_id,start"), doppelt: rows.length - eindeutig.length };
  }
  // Viertelstunden-Verbrauch je Ladung: erst neue, dann ältere ohne Verlauf (Rest im nächsten Lauf)
  const { data: offen } = await db.from("laden").select("wallbox_id, start, monta_id").is("verlauf_geholt", null).not("monta_id", "is", null).order("start", { ascending: false }).limit(5);
  const todo = [...new Map([...neueLadungen.map((n) => ({ ...n, monta_id: n.id })), ...(offen || [])].map((c) => [c.monta_id, c])).values()].slice(0, 5);
  let verlaeufe = 0, verlaufFelder = "";
  for (const c of todo) {
    await takt();
    const r = await fetch(`${API}/charges/${c.monta_id}/kwh-consumption?consumptionPeriodSizeInSeconds=900`, { headers: auth });
    if (!r.ok) continue;
    const j = await json(r);
    const liste = j.kwhConsumption || j.data || [];
    if (!verlaufFelder && liste[0]) verlaufFelder = Object.keys(liste[0]).join(",");
    const rows = liste.map((x: any) => {
      const zeit = x.time ?? x.timestamp ?? x.from ?? x.startedAt ?? x.date;
      const t = typeof zeit === "number" ? (zeit < 1e12 ? zeit * 1000 : zeit) : Date.parse(zeit);
      const wert = x.value ?? x.kwh ?? x.consumedKwh;
      if (!Number.isFinite(t) || wert == null) return null;
      return { ts_start: new Date(t - (t % 900e3)).toISOString(), wallbox_id: c.wallbox_id, kwh: +wert, ladung_start: c.start };
    }).filter(Boolean);
    await upsert("laden_15min", rows, "ts_start,wallbox_id");
    await db.from("laden").update({ verlauf_geholt: new Date().toISOString() }).eq("wallbox_id", c.wallbox_id).eq("start", c.start);
    verlaeufe++;
  }
  return { ...ergebnis, verlaeufe_geholt: verlaeufe, verlauf_felder: verlaufFelder || undefined };
}

// ---------------------------------------------------------------- Ablauf
async function lauf(ausloeser: string) {
  const { data: l } = await db.from("sync_lauf").insert({ ausloeser }).select("id").single();
  const ergebnis: Record<string, unknown> = {};
  for (const [name, fn] of [["netz_noe", netzNoe], ["fusionsolar", fusionSolar], ["efriends", eFriends], ["monta", monta]] as const) {
    const t0 = Date.now();
    try { ergebnis[name] = { ok: true, ...(await fn()), sekunden: Math.round((Date.now() - t0) / 1000) }; }
    catch (e) { ergebnis[name] = { ok: false, fehler: String((e as Error).message || e).slice(0, 300), sekunden: Math.round((Date.now() - t0) / 1000) }; }
  }
  await db.from("sync_lauf").update({ beendet: new Date().toISOString(), ergebnis }).eq("id", l!.id);
  return ergebnis;
}

Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return new Response("nur POST", { status: 405, headers: cors });

  // Wer ruft? Mit gültigem Benutzer-Token = App, sonst Zeitplan
  let ausloeser = "zeitplan", sperre = 3 * 3600e3;
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (token && token.split(".").length === 3) {
    const { data: u } = await db.auth.getUser(token);
    if (u?.user) {
      const { data: frei } = await db.from("app_users").select("user_id").eq("user_id", u.user.id).maybeSingle();
      if (!frei) return new Response(JSON.stringify({ fehler: "nicht freigeschaltet" }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });
      ausloeser = "app"; sperre = 10 * 60e3;
    }
  }
  const { data: letzter } = await db.from("sync_lauf").select("gestartet").order("gestartet", { ascending: false }).limit(1).maybeSingle();
  if (letzter && Date.now() - Date.parse(letzter.gestartet) < sperre) {
    return new Response(JSON.stringify({ übersprungen: "letzter Lauf zu kurz her", letzter: letzter.gestartet }), { status: 429, headers: { ...cors, "Content-Type": "application/json" } });
  }
  if (ausloeser === "app") {
    const ergebnis = await lauf(ausloeser);           // App wartet auf das Ergebnis
    return new Response(JSON.stringify(ergebnis), { headers: { ...cors, "Content-Type": "application/json" } });
  }
  // @ts-ignore EdgeRuntime ist in Supabase verfügbar
  EdgeRuntime.waitUntil(lauf(ausloeser));
  return new Response(JSON.stringify({ gestartet: true }), { status: 202, headers: { ...cors, "Content-Type": "application/json" } });
});
