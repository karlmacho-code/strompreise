// Supabase Edge Function "bericht": schickt einmal täglich eine E-Mail, ob alle Importe geklappt haben.
//
// Versand über Resend (https://resend.com). Secret: RESEND_API_KEY.
// Empfänger: public.sync_einstellung 'bericht_empfaenger' (steht nur in der Datenbank).
// Optional: sync_einstellung 'bericht_absender' (Standard: onboarding@resend.dev; damit stellt
// Resend nur an die eigene Konto-Adresse zu – genau das, was wir brauchen).
//
// Aufruf: POST /functions/v1/bericht
//   - vom Zeitplan (pg_cron): höchstens eine Mail pro 20 Stunden
//   - Test {"ausloeser":"test"}: ohne Anmeldung höchstens 1× pro Stunde, mit Benutzer-Token alle 5 Minuten
//   Die Mail geht immer nur an den hinterlegten Empfänger.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

function dienstSchluessel(): string {
  const alt = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (alt) return alt;
  try { const neu = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return neu.default || Object.values(neu)[0] as string; } catch { return ""; }
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, dienstSchluessel(), { auth: { persistSession: false, autoRefreshToken: false } });
const APP = "https://karlmacho-code.github.io/strompreise/#mein";
const META = "https://raw.githubusercontent.com/karlmacho-code/strompreise/main/data/meta.json";
const H = 3600e3;

type Stufe = "ok" | "warn" | "fehler";
type Punkt = { name: string; stufe: Stufe; text: string };

// ---------------------------------------------------------------- Zeit (Europe/Vienna)
const wien = (d: string | number | Date | null | undefined, mitZeit = true) => {
  if (!d) return "–";
  return new Intl.DateTimeFormat("de-AT", { timeZone: "Europe/Vienna", day: "2-digit", month: "2-digit", year: "numeric",
    ...(mitZeit ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(new Date(d));
};
/** Mitternacht (Wiener Zeit) des heutigen Tages als UTC-ms */
function heuteMitternacht(): number {
  const jetzt = Date.now();
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Vienna", hourCycle: "h23", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(jetzt)).map((x) => [x.type, x.value]));
  const lokalAlsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  const offset = lokalAlsUtc - Math.floor(jetzt / 60000) * 60000;
  return Date.UTC(+p.year, +p.month - 1, +p.day) - offset;
}
const alterStd = (d: string | null | undefined) => d ? (Date.now() - Date.parse(d)) / H : Infinity;

// ---------------------------------------------------------------- Prüfungen
// deno-lint-ignore no-explicit-any
function pruefen(s: any, meta: any): Punkt[] {
  const P: Punkt[] = [];
  const mitternacht = heuteMitternacht();
  const laeufe = (s.laeufe || []) as { gestartet: string; beendet: string | null; ausloeser: string; ergebnis: Record<string, any> | null }[];

  // 1) Sync-Läufe der letzten 26 Stunden
  const fertig = laeufe.filter((l) => l.ergebnis);
  if (!fertig.length) {
    P.push({ name: "Täglicher Abruf", stufe: "fehler", text: laeufe.length ? "Lauf gestartet, aber nicht beendet" : "kein Lauf in den letzten 26 Stunden" });
  } else {
    P.push({ name: "Täglicher Abruf", stufe: "ok", text: `${fertig.length} Lauf/Läufe, zuletzt ${wien(fertig.at(-1)!.gestartet)}` });
  }
  const letzter = fertig.at(-1)?.ergebnis || {};
  const quelle = (k: string) => letzter[k] as { ok: boolean; fehler?: string; übersprungen?: string; [x: string]: unknown } | undefined;
  const syncText = (k: string) => {
    const q = quelle(k);
    if (!q) return { stufe: "fehler" as Stufe, text: "kein Ergebnis" };
    if (!q.ok) return { stufe: "fehler" as Stufe, text: `Fehler: ${q.fehler}` };
    if (q.übersprungen) return { stufe: "warn" as Stufe, text: String(q.übersprungen) };
    return null;
  };

  // 2) Netz NÖ (Daten für gestern kommen meist im Lauf des Folgetags)
  {
    const f = syncText("netz_noe");
    const nb = s.netz_bis || {};
    const minBis = Math.min(Date.parse(nb.bezug || 0), Date.parse(nb.einspeisung || 0));
    const rueckstandTage = (mitternacht - minBis) / (24 * H);
    const txt = `Bezug bis ${wien(nb.bezug)}, Einspeisung bis ${wien(nb.einspeisung)}`;
    if (f) P.push({ name: "Smart Meter Netz NÖ", stufe: f.stufe, text: `${f.text} · ${txt}` });
    else P.push({ name: "Smart Meter Netz NÖ", stufe: rueckstandTage > 3 ? "fehler" : rueckstandTage > 1.1 ? "warn" : "ok", text: txt });
  }
  // 3) FusionSolar
  {
    const f = syncText("fusionsolar");
    const txt = `5-Min-Werte bis ${wien(s.pv_15min_bis)}, Tageswerte bis ${wien(s.pv_tag_bis, false)}`;
    const alt = alterStd(s.pv_15min_bis);
    if (f) P.push({ name: "PV-Anlage FusionSolar", stufe: f.stufe, text: `${f.text} · ${txt}` });
    else P.push({ name: "PV-Anlage FusionSolar", stufe: alt > 48 ? "fehler" : alt > 20 ? "warn" : "ok", text: txt });
  }
  // 4) Monta
  {
    const f = syncText("monta");
    const txt = `letzte Ladung ${wien(s.laden_letzte)}`;
    P.push(f ? { name: "Wallboxen Monta", stufe: f.stufe, text: `${f.text} · ${txt}` } : { name: "Wallboxen Monta", stufe: "ok", text: txt });
  }
  // 5) eFriends Flex-Preise (sollten mindestens bis heute Abend reichen)
  {
    const bis = Date.parse(s.flex_bis || 0);
    const txt = `Preise bis ${wien(s.flex_bis)}`;
    P.push({ name: "eFriends Flex-Preise", stufe: bis < Date.now() ? "fehler" : bis < mitternacht + 22 * H ? "warn" : "ok", text: txt });
  }
  // 6) eFriends Live-Sammler (Cube)
  {
    const aktiv = s.cron?.["ef-abfragen"];
    const alt = alterStd(s.live_letzter);
    if (aktiv === false) P.push({ name: "eFriends Cube (live)", stufe: "warn", text: `pausiert · letzter Wert ${wien(s.live_letzter)}` });
    else if (aktiv === undefined) P.push({ name: "eFriends Cube (live)", stufe: "warn", text: "Zeitplan nicht angelegt" });
    else P.push({ name: "eFriends Cube (live)", stufe: alt > 1 ? "fehler" : alt > 0.25 ? "warn" : "ok", text: `letzter Wert ${wien(s.live_letzter)}` });
  }
  // 7) Börsenpreise (GitHub Actions)
  if (!meta) P.push({ name: "Börsenpreise EPEX (GitHub)", stufe: "fehler", text: "meta.json nicht abrufbar" });
  else {
    const bis = Date.parse(meta.letzter_lokal);
    const alt = alterStd(meta.aktualisiert_utc);
    const txt = `Preise bis ${wien(meta.letzter_lokal)}, aktualisiert ${wien(meta.aktualisiert_utc)}${meta.luecken ? `, ${meta.luecken} Lücken` : ""}`;
    P.push({ name: "Börsenpreise EPEX (GitHub)", stufe: bis < mitternacht + 23 * H || alt > 30 ? "fehler" : meta.luecken ? "warn" : "ok", text: txt });
  }
  // 8) Fehlgeschlagene Datenbank-Jobs
  {
    const f = Object.entries(s.cron_fehler || {}) as [string, number][];
    P.push(f.length
      ? { name: "Datenbank-Zeitpläne", stufe: "warn", text: "fehlgeschlagen in 24 h: " + f.map(([j, n]) => `${j} ${n}×`).join(", ") }
      : { name: "Datenbank-Zeitpläne", stufe: "ok", text: "keine Fehler in 24 h" });
  }
  return P;
}

// ---------------------------------------------------------------- Mail
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const SYMBOL: Record<Stufe, string> = { ok: "✅", warn: "⚠️", fehler: "❌" };
const FARBE: Record<Stufe, string> = { ok: "#1a7f37", warn: "#9a6700", fehler: "#cf222e" };

function mail(P: Punkt[]) {
  const nF = P.filter((p) => p.stufe === "fehler").length, nW = P.filter((p) => p.stufe === "warn").length;
  const kopf = nF ? `❌ ${nF} Fehler${nW ? `, ${nW} Hinweis${nW > 1 ? "e" : ""}` : ""}` : nW ? `⚠️ ${nW} Hinweis${nW > 1 ? "e" : ""}` : "✅ alles ok";
  const betreff = `Strom-Import ${wien(Date.now(), false)}: ${kopf}`;
  const zeilen = P.map((p) => `<tr>
    <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:16px;vertical-align:top">${SYMBOL[p.stufe]}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top"><b>${esc(p.name)}</b><br>
      <span style="color:${p.stufe === "ok" ? "#57606a" : FARBE[p.stufe]};font-size:13px">${esc(p.text)}</span></td></tr>`).join("");
  const html = `<!doctype html><html><body style="margin:0;padding:16px;background:#f6f8fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2328">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #d0d7de;border-radius:10px;overflow:hidden">
    <div style="padding:14px 16px;background:#2a78d6;color:#fff"><b style="font-size:17px">⚡ Strompreis AT – Tagesbericht</b><br>
      <span style="font-size:13px;opacity:.9">${esc(wien(Date.now()))}</span></div>
    <div style="padding:14px 16px;font-size:15px"><b>${esc(kopf)}</b></div>
    <table style="width:100%;border-collapse:collapse">${zeilen}</table>
    <div style="padding:14px 16px;font-size:13px"><a href="${APP}" style="color:#2a78d6">Mein Strom öffnen</a></div>
  </div></body></html>`;
  const text = `Strompreis AT – Tagesbericht ${wien(Date.now())}\n${kopf}\n\n` +
    P.map((p) => `${SYMBOL[p.stufe]} ${p.name}: ${p.text}`).join("\n") + `\n\n${APP}\n`;
  return { betreff, html, text };
}

async function senden(an: string, von: string, m: { betreff: string; html: string; text: string }) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("Secret RESEND_API_KEY fehlt");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: von, to: [an], subject: m.betreff, html: m.html, text: m.text }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Resend ${r.status}: ${body.slice(0, 300)}`);
  return body;
}

// ---------------------------------------------------------------- Aufruf
Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ fehler: "nur POST" }, 405);

  // Wer ruft? Mit gültigem Benutzer-Token = Test aus der App, sonst Zeitplan
  let ausloeser = "zeitplan", sperre = 20 * H;
  let body: { ausloeser?: string } = {};
  try { body = await req.json(); } catch { /* leer */ }
  if (body.ausloeser === "test") { ausloeser = "test"; sperre = H; }   // Testmail ohne Anmeldung: höchstens 1× pro Stunde
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (token && token.split(".").length === 3) {
    const { data: u } = await db.auth.getUser(token);
    if (u?.user) {
      const { data: frei } = await db.from("app_users").select("user_id").eq("user_id", u.user.id).maybeSingle();
      if (!frei) return json({ fehler: "nicht freigeschaltet" }, 403);
      ausloeser = "test"; sperre = 5 * 60e3;
    }
  }
  const { data: letzte } = await db.from("bericht_versand").select("gesendet").eq("ausloeser", ausloeser).eq("ok", true)
    .order("gesendet", { ascending: false }).limit(1).maybeSingle();
  if (letzte && Date.now() - Date.parse(letzte.gesendet) < sperre) return json({ übersprungen: "schon gesendet", letzte: letzte.gesendet }, 429);

  const { data: s, error } = await db.rpc("bericht_json");
  if (error) return json({ fehler: error.message }, 500);
  let meta = null;
  try { const r = await fetch(META + "?t=" + Date.now()); if (r.ok) meta = await r.json(); } catch { /* bleibt null */ }

  const punkte = pruefen(s, meta);
  const m = mail(punkte);
  const an = s?.empfaenger;
  if (!an) return json({ fehler: "kein Empfänger (sync_einstellung bericht_empfaenger)" }, 500);
  const { data: abs } = await db.from("sync_einstellung").select("wert").eq("schluessel", "bericht_absender").maybeSingle();
  const von = `Strompreis AT <${abs?.wert || "onboarding@resend.dev"}>`;
  try {
    const antwort = await senden(an, von, m);
    await db.from("bericht_versand").insert({ ausloeser, ok: true, betreff: m.betreff, antwort: antwort.slice(0, 500) });
    return json({ gesendet: true, betreff: m.betreff, punkte });
  } catch (e) {
    const fehler = String((e as Error).message || e);
    await db.from("bericht_versand").insert({ ausloeser, ok: false, betreff: m.betreff, antwort: fehler.slice(0, 500) });
    return json({ gesendet: false, fehler, betreff: m.betreff, punkte }, 502);
  }
});
