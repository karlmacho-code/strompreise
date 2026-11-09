# Einrichtung „Mein Strom“ (Supabase)

Einmalig, ca. 15 Minuten. Schritte mit 🔐 machst du selbst (Zugangsdaten), den Rest kann Claude übernehmen.

## 1. Projekt anlegen 🔐
1. https://supabase.com → **Start your project** → **Continue with GitHub**
2. **New project**: Name `strompreise`, ein starkes Datenbank-Passwort (im Passwortmanager speichern, wird selten gebraucht),
   **Region: Central EU (Frankfurt)**, Plan **Free**.

## 2. Datenbank einrichten
**SQL Editor → New query** → Inhalt von `supabase/schema.sql` einfügen → **Run**.
Legt Tabellen, Zugriffsregeln (Row Level Security), Abfragefunktionen und den Live-Sammler an.

## 3. Registrierung sperren, Benutzer anlegen 🔐
1. **Authentication → Sign In / Providers → Email**: „Allow new users to sign up“ **ausschalten**.
2. **Authentication → Users → Add user → Create new user**: deine E-Mail, Passwort (mind. 12 Zeichen), „Auto Confirm User“ an.
3. **Authentication → URL Configuration → Site URL**: `https://karlmacho-code.github.io/strompreise/`
   (für den „Passwort vergessen“-Link).
4. Benutzer freischalten (SQL Editor):
   ```sql
   insert into public.app_users (user_id)
   select id from auth.users where email = 'DEINE@EMAIL.AT';
   ```

## 4. Web-App verbinden
**Project Settings → API Keys**: Project URL und den **publishable** Key (`sb_publishable_…`) in `config.js` eintragen.
Dieser Schlüssel ist öffentlich gedacht. **Niemals** den `secret`/`service_role`-Key verwenden.

## 5. Live-Sammler aktivieren (optional) 🔐
Nur mit eFriends Cube oder WATCH+.
1. eFriends-App → Einstellungen → **API Manager** → neuen Key anlegen (Beschreibung „Supabase“).
2. eFriends-App → **Expertenmodus** → Hostname notieren (z. B. `…balena-devices.com`).
3. Supabase → SQL Editor (Werte selbst einsetzen, nicht weitergeben):
   ```sql
   select vault.create_secret('HOSTNAME', 'efriends_host', 'eFriends Cube Hostname');
   select vault.create_secret('API-KEY', 'efriends_api_key', 'eFriends API Manager');
   ```
   Der Sammler startet automatisch (alle 10 Sekunden), Viertelstundenwerte erscheinen nach ~1 Minute.
   Abschalten: Key in der eFriends-App löschen oder `select cron.unschedule('ef-abfragen');`

## 6. Historie importieren
eFriends-App → Menü → **Downloads** → je Monat „15-Min (json)“ herunterladen (verfügbar ab 7/2023),
dann Web-App → **Mein Strom** → „Dateien wählen“ → alle Dateien auf einmal auswählen.

## 7. Tarif
Vorbelegt: „Der bessere Flex Tarif“ (Börse inkl. USt ± 10 %, mind. 2,28 ct; 8,98 €/Monat Gebühren), gültig ab 01.07.2023.
Wenn du früher einen anderen Tarif hattest, in **Mein Strom → Tarif** einen Eintrag mit dem passenden „Gültig ab“ anlegen.
Mit hinterlegtem API-Key (Schritt 5) holt Supabase täglich die **exakten** Flex-Preise; diese haben Vorrang vor der Formel.

## Kontrolle
```sql
select jobname, schedule, active from cron.job;                 -- Zeitpläne
select * from cron.job_run_details order by start_time desc limit 5;  -- letzte Läufe
select count(*), max(ts) from public.live_werte;                 -- Live-Werte
select quelle, count(*), min(ts_start), max(ts_start) from public.messung_15min group by 1;
```

## 8. Täglicher Abruf (Edge Function `sync`)
Code: `supabase/functions/sync/index.ts`. Bereitstellen (einmalig `npx supabase@2.122.0 login`):
```bash
npx supabase@2.122.0 functions deploy sync --project-ref <ref> --no-verify-jwt --use-api
```
- Zeitplan `sync-taeglich` (pg_cron): 05:20 und 17:20 UTC. Ohne Anmeldung höchstens alle 3 h, aus der App („Jetzt abrufen“) alle 10 min.
- Zugangsdaten nur als **Edge Function Secrets** (Dashboard → Edge Functions → Secrets):
  `NETZNOE_USER`, `NETZNOE_PASSWORT`, `FUSIONSOLAR_USER`, `FUSIONSOLAR_PASSWORT`, `EFRIENDS_API_KEY`,
  `MONTA_CLIENT_ID`, `MONTA_CLIENT_SECRET` (Monta Hub → Profil → Applications).
- Nicht geheime Einstellungen in `public.sync_einstellung` (Cube-Name, Anlage, Server, Wallboxen) – nicht im Repo.
- Ergebnis jedes Laufs: `public.sync_lauf` (in der App als Statuszeile; Mausüber zeigt Details/Fehler).

## 9. Täglicher Statusbericht per E-Mail

Die Edge Function `bericht` prüft jeden Morgen um 05:50 UTC (06:50 bzw. 07:50 Wiener Zeit) alle Quellen
(Sync-Läufe, Netz NÖ, FusionSolar, Monta, eFriends-Preise und -Cube, Börsenpreise auf GitHub, Datenbank-Zeitpläne)
und schickt eine Mail mit ✅ / ⚠️ / ❌ je Quelle.

1. Konto bei [resend.com](https://resend.com) **mit der Empfängeradresse** anlegen (kostenlos, 3.000 Mails/Monat).
   Ohne eigene Domain stellt Resend vom Absender `onboarding@resend.dev` nur an die Konto-Adresse zu – genau das wird gebraucht.
2. Resend → **API Keys** → *Create API Key* (Permission: *Sending access*), Schlüssel kopieren.
3. Supabase → Edge Functions → **Secrets** → `RESEND_API_KEY` = Schlüssel.
4. Empfänger steht nur in der Datenbank:
   `insert into public.sync_einstellung values ('bericht_empfaenger', '<adresse>') on conflict (schluessel) do update set wert = excluded.wert;`
5. Testmail (höchstens 1× pro Stunde):
   `curl -X POST https://<ref>.supabase.co/functions/v1/bericht -H "Content-Type: application/json" -d '{"ausloeser":"test"}'`

Versandprotokoll: Tabelle `bericht_versand`.
