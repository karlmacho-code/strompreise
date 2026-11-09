-- =====================================================================
-- Strompreis AT – persönlicher Bereich "Mein Strom" (Supabase / Postgres)
--
-- Einmal komplett im Supabase SQL Editor ausführen. Das Skript kann
-- gefahrlos erneut ausgeführt werden (idempotent).
--
-- Sicherheitsprinzip:
--   * Zugriff nur für Benutzer in public.app_users (Login nötig).
--   * Row Level Security auf allen Tabellen; anonyme Zugriffe sehen nichts.
--   * eFriends-Zugangsdaten nur im Supabase Vault (verschlüsselt),
--     nie in Tabellen, im Code oder im Browser.
--   * Sammel-Funktionen liegen im Schema "private" (nicht über die API erreichbar).
-- =====================================================================

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Benutzer-Freigabe
-- ---------------------------------------------------------------------
create table if not exists public.app_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  angelegt timestamptz not null default now()
);
alter table public.app_users enable row level security;

create or replace function private.ist_freigegeben()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.app_users where user_id = auth.uid()) $$;
grant usage on schema private to authenticated;
revoke all on function private.ist_freigegeben() from public, anon;
grant execute on function private.ist_freigegeben() to authenticated;

drop policy if exists app_users_self on public.app_users;
create policy app_users_self on public.app_users for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- Messwerte je Viertelstunde (Wh). quelle: 'export' = Datei aus der
-- eFriends-App (maßgeblich), 'live' = aus der Live-Schnittstelle gemittelt.
-- ---------------------------------------------------------------------
create table if not exists public.messung_15min (
  ts_start          timestamptz not null,
  quelle            text not null check (quelle in ('export', 'live')),
  von_netz_wh       real not null default 0,   -- Bezug gesamt (fromGrid)
  ins_netz_wh       real not null default 0,   -- Einspeisung gesamt (toGrid)
  vom_lieferant_wh  real not null default 0,   -- Bezug von eFriends Energy (fromSupplier)
  von_community_wh  real not null default 0,   -- Bezug aus der Community (fromCommunity)
  an_lieferant_wh   real not null default 0,   -- Einspeisung an eFriends Energy (toSupplier)
  an_community_wh   real not null default 0,   -- Einspeisung an die Community (toCommunity)
  pv_wh             real not null default 0,   -- Wechselrichter-Erzeugung (inverterProduction)
  qualitaet         smallint,                  -- readingQuality (0–100) bzw. Anteil Live-Samples
  luecke            boolean not null default false,
  samples           integer,                   -- nur 'live': Anzahl 10-s-Werte
  geaendert         timestamptz not null default now(),
  primary key (ts_start, quelle)
);
alter table public.messung_15min enable row level security;

drop policy if exists messung_lesen on public.messung_15min;
create policy messung_lesen on public.messung_15min for select to authenticated
  using ((select private.ist_freigegeben()));
drop policy if exists messung_import on public.messung_15min;
create policy messung_import on public.messung_15min for insert to authenticated
  with check ((select private.ist_freigegeben()) and quelle = 'export');
drop policy if exists messung_import_upd on public.messung_15min;
create policy messung_import_upd on public.messung_15min for update to authenticated
  using ((select private.ist_freigegeben()) and quelle = 'export')
  with check ((select private.ist_freigegeben()) and quelle = 'export');
drop policy if exists messung_loeschen on public.messung_15min;
create policy messung_loeschen on public.messung_15min for delete to authenticated
  using ((select private.ist_freigegeben()) and quelle = 'export');

-- Je Viertelstunde der beste Wert: Export vor Live
create or replace view public.messung_beste with (security_invoker = true) as
  select distinct on (ts_start) *
  from public.messung_15min
  order by ts_start, (quelle = 'export') desc;

-- ---------------------------------------------------------------------
-- Live-Werte (10-Sekunden-Perioden der eFriends-Schnittstelle), 7 Tage
-- ---------------------------------------------------------------------
create table if not exists public.live_werte (
  ts                 timestamptz primary key,   -- Ende der 10-s-Periode
  start_ts           timestamptz not null,
  von_netz_w         real, ins_netz_w real,
  vom_lieferant_w    real, an_lieferant_w real,
  von_community_w    real, an_community_w real,
  community_bilanz_w real
);
alter table public.live_werte enable row level security;
drop policy if exists live_lesen on public.live_werte;
create policy live_lesen on public.live_werte for select to authenticated
  using ((select private.ist_freigegeben()));

-- ---------------------------------------------------------------------
-- Tarif (für die Kostenrechnung), gültig ab Datum
-- art 'flex': Preis je Stunde = Börse inkl. USt ± max(aufschlag_pct % davon, aufschlag_min_ct_brutto)
-- art 'fix' : bezug_ct_netto fix
-- ---------------------------------------------------------------------
create table if not exists public.tarif (
  gueltig_ab                 date primary key,
  name                       text not null,
  art                        text not null default 'flex' check (art in ('flex', 'fix')),
  bezug_ct_netto             numeric,                    -- nur 'fix'
  aufschlag_pct              numeric not null default 10,
  aufschlag_min_ct_brutto    numeric not null default 2.28,
  community_bezug_ct_netto   numeric,                    -- Ø Community-Preis (optional, sonst wie Lieferant)
  community_gebuehr_ct_netto numeric not null default 1.2,
  grundgebuehr_eur_brutto    numeric not null default 8.98, -- Grundgebühr 5,99 + Plattform 2,99
  vergleich_fix_ct_netto     numeric default 14.0,       -- Vergleichsfixpreis ("Der bessere Tarif")
  ust                        numeric not null default 0.20
);
alter table public.tarif enable row level security;
drop policy if exists tarif_alles on public.tarif;
create policy tarif_alles on public.tarif for all to authenticated
  using ((select private.ist_freigegeben())) with check ((select private.ist_freigegeben()));

insert into public.tarif (gueltig_ab, name, art)
  values ('2023-07-01', 'Der bessere Flex Tarif', 'flex')
  on conflict (gueltig_ab) do nothing;

-- ---------------------------------------------------------------------
-- Exakte Flex-Preise aus der eFriends-Schnittstelle (inkl. Auf-/Abschlag, exkl. USt)
-- ---------------------------------------------------------------------
create table if not exists public.flex_preise (
  ts_start          timestamptz primary key,
  ts_ende           timestamptz not null,
  bezug_ct_netto    real not null,
  einspeise_ct_netto real not null,
  tarif             text,
  abgerufen         timestamptz not null default now()
);
alter table public.flex_preise enable row level security;
drop policy if exists flex_lesen on public.flex_preise;
create policy flex_lesen on public.flex_preise for select to authenticated
  using ((select private.ist_freigegeben()));

-- Anonyme Zugriffe grundsätzlich entziehen (zusätzlich zu RLS)
revoke all on public.app_users, public.messung_15min, public.live_werte, public.tarif, public.flex_preise from anon;
revoke all on public.messung_beste from anon;
grant select on public.app_users, public.messung_15min, public.live_werte, public.tarif, public.messung_beste, public.flex_preise to authenticated;
grant insert, update, delete on public.messung_15min, public.tarif to authenticated;

-- ---------------------------------------------------------------------
-- Netz NÖ Smart Meter (geeichte Verrechnungswerte), 15 min, kWh
-- ---------------------------------------------------------------------
create table if not exists public.netz_15min (
  ts_start   timestamptz not null,
  richtung   text not null check (richtung in ('bezug', 'einspeisung')),
  kwh        real not null,
  geschaetzt boolean not null default false,
  zaehlpunkt text,
  geaendert  timestamptz not null default now(),
  primary key (ts_start, richtung)
);
alter table public.netz_15min enable row level security;
drop policy if exists netz_alles on public.netz_15min;
create policy netz_alles on public.netz_15min for all to authenticated
  using ((select private.ist_freigegeben())) with check ((select private.ist_freigegeben()));

-- ---------------------------------------------------------------------
-- PV-Anlage (Huawei FusionSolar): 15-min aus 5-min-Kurven, plus Tageswerte
-- ---------------------------------------------------------------------
create table if not exists public.pv_15min (
  ts_start      timestamptz primary key,
  pv_wh         real,   -- Erzeugung Wechselrichter
  verbrauch_wh  real,   -- Hausverbrauch
  eigen_wh      real,   -- direkt selbst genutzte PV
  laden_wh      real,   -- Batterie laden
  entladen_wh   real,   -- Batterie entladen
  geaendert     timestamptz not null default now()
);
alter table public.pv_15min enable row level security;
drop policy if exists pv15_alles on public.pv_15min;
create policy pv15_alles on public.pv_15min for all to authenticated
  using ((select private.ist_freigegeben())) with check ((select private.ist_freigegeben()));

create table if not exists public.pv_tag (
  tag            date primary key,
  pv_kwh         real,
  verbrauch_kwh  real,
  eigen_kwh      real,
  laden_kwh      real,
  entladen_kwh   real,
  einspeisung_kwh real,
  bezug_kwh      real,
  geaendert      timestamptz not null default now()
);
alter table public.pv_tag enable row level security;
drop policy if exists pvtag_alles on public.pv_tag;
create policy pvtag_alles on public.pv_tag for all to authenticated
  using ((select private.ist_freigegeben())) with check ((select private.ist_freigegeben()));

revoke all on public.netz_15min, public.pv_15min, public.pv_tag from anon;
grant select, insert, update, delete on public.netz_15min, public.pv_15min, public.pv_tag to authenticated;

-- ---------------------------------------------------------------------
-- Wallboxen (Monta): Ladevorgänge
-- ---------------------------------------------------------------------
create table if not exists public.laden (
  wallbox_id      bigint not null,
  start           timestamptz not null,
  wallbox         text,
  ende            timestamptz,
  voll            timestamptz,
  kwh             real,
  zaehler_start   real,
  zaehler_ende    real,
  soc_start       smallint,
  soc_ende        smallint,
  preis_cent      integer,
  preis_kwh_cent  integer,
  kosten_cent     integer,
  status          text,
  smart           boolean,
  start_quelle    text,
  geaendert       timestamptz not null default now(),
  primary key (wallbox_id, start)
);
alter table public.laden enable row level security;
drop policy if exists laden_alles on public.laden;
create policy laden_alles on public.laden for all to authenticated
  using ((select private.ist_freigegeben())) with check ((select private.ist_freigegeben()));
revoke all on public.laden from anon;
grant select, insert, update, delete on public.laden to authenticated;

-- Tagessummen aller Quellen für die Web-App
create or replace function public.tage_json(von date, bis date)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  with t as (select generate_series(von, bis, interval '1 day')::date tag),
  n as (select (ts_start at time zone 'Europe/Vienna')::date tag,
               sum(kwh) filter (where richtung = 'bezug') bez, sum(kwh) filter (where richtung = 'einspeisung') ein
        from public.netz_15min where ts_start >= von::timestamp at time zone 'Europe/Vienna'
          and ts_start < (bis + 1)::timestamp at time zone 'Europe/Vienna' group by 1)
  select coalesce(jsonb_agg(jsonb_build_array(t.tag, n.bez, n.ein, p.pv_kwh, p.verbrauch_kwh, p.eigen_kwh, p.laden_kwh, p.entladen_kwh) order by t.tag), '[]'::jsonb)
  from t left join n using (tag) left join public.pv_tag p using (tag)
  where n.tag is not null or p.tag is not null
$$;
revoke all on function public.tage_json(date, date) from public, anon;
grant execute on function public.tage_json(date, date) to authenticated;

-- ---------------------------------------------------------------------
-- Abfragen für die Web-App: ganze Zeitreihe als ein JSON (kein 1000-Zeilen-Limit)
-- Stundensummen: [unix_sekunden, von_netz, ins_netz, vom_lieferant, von_community, an_lieferant, an_community, pv] in Wh
-- ---------------------------------------------------------------------
create or replace function public.stunden_json(von timestamptz, bis timestamptz)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_array(
           extract(epoch from h)::bigint, round(a::numeric,1), round(b::numeric,1), round(c::numeric,1),
           round(d::numeric,1), round(e::numeric,1), round(f::numeric,1), round(g::numeric,1)) order by h), '[]'::jsonb)
  from (
    select date_trunc('hour', ts_start) h,
           sum(von_netz_wh) a, sum(ins_netz_wh) b, sum(vom_lieferant_wh) c, sum(von_community_wh) d,
           sum(an_lieferant_wh) e, sum(an_community_wh) f, sum(pv_wh) g
    from public.messung_beste
    where ts_start >= von and ts_start < bis
    group by 1
  ) x
$$;

-- Viertelstunden eines Zeitraums (für die Tagesansicht)
create or replace function public.viertel_json(von timestamptz, bis timestamptz)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_array(
           extract(epoch from ts_start)::bigint, von_netz_wh, ins_netz_wh, vom_lieferant_wh,
           von_community_wh, an_lieferant_wh, an_community_wh, pv_wh, quelle) order by ts_start), '[]'::jsonb)
  from public.messung_beste
  where ts_start >= von and ts_start < bis
$$;

-- Flex-Preise als Stundenmittel: [unix_sekunden, bezug_ct_netto, einspeise_ct_netto]
create or replace function public.flex_json(von timestamptz, bis timestamptz)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_array(extract(epoch from h)::bigint, round(b::numeric, 4), round(e::numeric, 4)) order by h), '[]'::jsonb)
  from (select date_trunc('hour', ts_start) h, avg(bezug_ct_netto) b, avg(einspeise_ct_netto) e
        from public.flex_preise where ts_start >= von and ts_start < bis group by 1) x
$$;

-- Status für die Kopfzeile
create or replace function public.status_json()
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'erste',  (select min(ts_start) from public.messung_15min),
    'letzte', (select max(ts_start) from public.messung_15min),
    'export_bis', (select max(ts_start) from public.messung_15min where quelle = 'export'),
    'live_letzter', (select to_jsonb(l) from (select * from public.live_werte order by ts desc limit 1) l),
    'anzahl', (select count(*) from public.messung_15min),
    'flex_bis', (select max(ts_start) from public.flex_preise)
  )
$$;

revoke all on function public.stunden_json(timestamptz, timestamptz), public.viertel_json(timestamptz, timestamptz), public.flex_json(timestamptz, timestamptz), public.status_json() from public, anon;
grant execute on function public.stunden_json(timestamptz, timestamptz), public.viertel_json(timestamptz, timestamptz), public.flex_json(timestamptz, timestamptz), public.status_json() to authenticated;

-- ---------------------------------------------------------------------
-- Live-Sammler: fragt die eFriends-Schnittstelle (Cube/WATCH+) ab.
-- Benötigt zwei Vault-Secrets (Dashboard → Project Settings → Vault, oder SQL):
--   efriends_host     z. B. 2e64...79.balena-devices.com  (eFriends-App → Expertenmodus)
--   efriends_api_key  aus eFriends-App → Einstellungen → API Manager
-- Ohne diese Secrets tut der Sammler nichts.
-- ---------------------------------------------------------------------
create table if not exists private.ef_anfragen (
  id bigint primary key,
  art text not null default 'live',
  angelegt timestamptz not null default now()
);
alter table private.ef_anfragen add column if not exists art text not null default 'live';

create or replace function private.try_jsonb(t text)
returns jsonb language plpgsql immutable as $$
begin return t::jsonb; exception when others then return null; end $$;

create or replace function private.ef_abfragen()
returns void language plpgsql security definer set search_path = ''
as $$
declare h text; k text;
begin
  select decrypted_secret into h from vault.decrypted_secrets where name = 'efriends_host';
  select decrypted_secret into k from vault.decrypted_secrets where name = 'efriends_api_key';
  if h is null or k is null then return; end if;
  h := regexp_replace(trim(h), '^https?://|/+$', '', 'g');
  insert into private.ef_anfragen (id)
  values (net.http_get(
    url := 'https://' || h || '/v3/MeterDataAPI/TradingSummary',
    headers := jsonb_build_object('apiKey', k),
    timeout_milliseconds := 8000));
end $$;

-- Flex-Preise für heute bis übermorgen abrufen (ab ca. 17:00 inkl. morgen)
create or replace function private.ef_preise_abrufen()
returns void language plpgsql security definer set search_path = ''
as $$
declare k text; t text; heute date := (now() at time zone 'Europe/Vienna')::date;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'efriends_api_key';
  select name into t from public.tarif where art = 'flex' order by gueltig_ab desc limit 1;
  if k is null or t is null then return; end if;
  insert into private.ef_anfragen (id, art)
  values (net.http_get(
    url := 'https://backendsvc.efriends.at/rest/v2.3/app/Prices/' || replace(t, ' ', '%20') || '/' || heute || '/' || (heute + 2),
    headers := jsonb_build_object('efToken', k),
    timeout_milliseconds := 15000), 'preise');
end $$;

create or replace function private.ef_verarbeiten()
returns void language plpgsql security definer set search_path = ''
as $$
declare ab timestamptz := date_bin('15 minutes', now() - interval '2 hours', timestamptz '2000-01-01 00:00+00');
begin
  -- 1) Antworten übernehmen
  insert into public.live_werte (ts, start_ts, von_netz_w, ins_netz_w, vom_lieferant_w, an_lieferant_w,
                                 von_community_w, an_community_w, community_bilanz_w)
  select (j->>'endTime')::timestamptz, (j->>'startTime')::timestamptz,
         (a->>'fromGrid')::real, (a->>'toGrid')::real, (a->>'fromSupplier')::real, (a->>'toSupplier')::real,
         (a->>'fromCommunity')::real, (a->>'toCommunity')::real, (a->>'balance')::real
  from private.ef_anfragen q
  join net._http_response r on r.id = q.id
  cross join lateral (select private.try_jsonb(r.content) j) x
  cross join lateral (select x.j->'aggregatedData' a) y
  where q.art = 'live' and r.status_code = 200 and y.a is not null and x.j ? 'endTime'
  on conflict (ts) do nothing;

  insert into public.flex_preise (ts_start, ts_ende, bezug_ct_netto, einspeise_ct_netto, tarif, abgerufen)
  select distinct on ((p->>'startt')::timestamptz)            -- mehrere Antworten: je Viertelstunde die neueste
         (p->>'startt')::timestamptz, (p->>'endt')::timestamptz, (p->>'cons')::real / 10, (p->>'gen')::real / 10,
         (select name from public.tarif where art = 'flex' order by gueltig_ab desc limit 1), now()
  from private.ef_anfragen q
  join net._http_response r on r.id = q.id
  cross join lateral (select private.try_jsonb(r.content) j) x
  cross join lateral jsonb_array_elements(case when jsonb_typeof(x.j->'data') = 'array' then x.j->'data' else '[]'::jsonb end) p
  where q.art = 'preise' and r.status_code = 200 and (x.j->>'bSuccess')::boolean is true
    and nullif(p->>'cons', '') is not null and nullif(p->>'gen', '') is not null   -- noch offene Viertelstunden kommen leer
  order by (p->>'startt')::timestamptz, r.created desc
  on conflict (ts_start) do update set bezug_ct_netto = excluded.bezug_ct_netto,
    einspeise_ct_netto = excluded.einspeise_ct_netto, ts_ende = excluded.ts_ende, abgerufen = now();

  delete from private.ef_anfragen q
  where exists (select 1 from net._http_response r where r.id = q.id)
     or q.angelegt < now() - interval '1 hour';

  -- 2) Viertelstunden der letzten 2 Stunden neu bilden (Ø Leistung × 0,25 h = Wh)
  insert into public.messung_15min (ts_start, quelle, von_netz_wh, ins_netz_wh, vom_lieferant_wh, von_community_wh,
                                    an_lieferant_wh, an_community_wh, samples, qualitaet, geaendert)
  select b, 'live',
         avg(von_netz_w) * 0.25, avg(ins_netz_w) * 0.25, avg(vom_lieferant_w) * 0.25, avg(von_community_w) * 0.25,
         avg(an_lieferant_w) * 0.25, avg(an_community_w) * 0.25,
         count(*), least(100, round(count(*) * 100.0 / 90)), now()
  from (select date_bin('15 minutes', start_ts, timestamptz '2000-01-01 00:00+00') b, * from public.live_werte where start_ts >= ab) s
  group by b
  on conflict (ts_start, quelle) do update set
    von_netz_wh = excluded.von_netz_wh, ins_netz_wh = excluded.ins_netz_wh,
    vom_lieferant_wh = excluded.vom_lieferant_wh, von_community_wh = excluded.von_community_wh,
    an_lieferant_wh = excluded.an_lieferant_wh, an_community_wh = excluded.an_community_wh,
    samples = excluded.samples, qualitaet = excluded.qualitaet, geaendert = now();

  -- 3) Aufräumen
  delete from public.live_werte where ts < now() - interval '7 days';
end $$;

revoke all on function private.ef_abfragen(), private.ef_preise_abrufen(), private.ef_verarbeiten(), private.try_jsonb(text) from public, anon, authenticated;

-- Zeitpläne (pg_cron, UTC). Vorhandene gleichnamige Jobs werden ersetzt.
select cron.unschedule(jobid) from cron.job where jobname in ('ef-abfragen', 'ef-verarbeiten', 'ef-preise');
select cron.schedule('ef-abfragen', '10 seconds', $$select private.ef_abfragen()$$);
select cron.schedule('ef-verarbeiten', '* * * * *', $$select private.ef_verarbeiten()$$);
-- Flex-Preise: 15:15–18:15 UTC stündlich (Veröffentlichung ca. 17:00 Wiener Zeit)
select cron.schedule('ef-preise', '15 15,16,17,18 * * *', $$select private.ef_preise_abrufen()$$);

-- =====================================================================
-- Täglicher Abruf (Edge Function "sync")
-- =====================================================================
-- Nicht geheime Einstellungen (Zugangsdaten liegen als Edge-Function-Secrets!)
create table if not exists public.sync_einstellung (
  schluessel text primary key,
  wert       text not null
);
alter table public.sync_einstellung enable row level security;
drop policy if exists sync_einst_lesen on public.sync_einstellung;
create policy sync_einst_lesen on public.sync_einstellung for select to authenticated using ((select private.ist_freigegeben()));

-- Protokoll jedes Laufs
create table if not exists public.sync_lauf (
  id        bigint generated always as identity primary key,
  gestartet timestamptz not null default now(),
  beendet   timestamptz,
  ausloeser text,
  ergebnis  jsonb
);
alter table public.sync_lauf enable row level security;
drop policy if exists sync_lauf_lesen on public.sync_lauf;
create policy sync_lauf_lesen on public.sync_lauf for select to authenticated using ((select private.ist_freigegeben()));

-- Wallbox: Monta-Kennung und Viertelstunden-Verlauf je Ladung
alter table public.laden add column if not exists monta_id text;
alter table public.laden add column if not exists verlauf_geholt timestamptz;
create table if not exists public.laden_15min (
  ts_start    timestamptz not null,
  wallbox_id  bigint not null,
  kwh         real not null,
  ladung_start timestamptz,
  primary key (ts_start, wallbox_id)
);
alter table public.laden_15min enable row level security;
drop policy if exists laden15_lesen on public.laden_15min;
create policy laden15_lesen on public.laden_15min for select to authenticated using ((select private.ist_freigegeben()));

revoke all on public.sync_einstellung, public.sync_lauf, public.laden_15min from anon;
grant select on public.sync_einstellung, public.sync_lauf, public.laden_15min to authenticated;
grant all on public.sync_einstellung, public.sync_lauf, public.laden_15min, public.laden, public.netz_15min,
  public.pv_15min, public.pv_tag, public.messung_15min, public.app_users to service_role;

-- Einstellungen werden einmalig direkt in der Datenbank gesetzt (nicht im öffentlichen Repo), z. B.:
-- insert into public.sync_einstellung values ('efriends_cube','P01_…'), ('fusionsolar_station','NE=…'),
--   ('fusionsolar_login_host','eu5.fusionsolar.huawei.com'), ('monta_wallboxen','<id>:<Name>,<id>:<Name>');

-- Zeitplan: 05:20 und 17:20 UTC (06:20/18:20 bzw. 07:20/19:20 Wiener Zeit)
select cron.unschedule(jobid) from cron.job where jobname = 'sync-taeglich';
select cron.schedule('sync-taeglich', '20 5,17 * * *', $$
  select net.http_post(
    url := 'https://kdwrfhcflewvmuegmgwm.supabase.co/functions/v1/sync',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"ausloeser": "zeitplan"}'::jsonb,
    timeout_milliseconds := 10000)
$$);

-- eFriends: Edge Function legt den API-Schlüssel in den Vault (für Live-Sammler und Flex-Preise)
create or replace function public.sync_vault_setzen(p_name text, p_wert text)
returns void language plpgsql security definer set search_path = ''
as $$
declare vid uuid;
begin
  if p_name not in ('efriends_api_key', 'efriends_host') then raise exception 'nicht erlaubt'; end if;
  select id into vid from vault.secrets where name = p_name;
  if vid is null then perform vault.create_secret(p_wert, p_name);
  elsif (select decrypted_secret from vault.decrypted_secrets where id = vid) is distinct from p_wert then perform vault.update_secret(vid, p_wert);
  end if;
end $$;
revoke all on function public.sync_vault_setzen(text, text) from public, anon, authenticated;
grant execute on function public.sync_vault_setzen(text, text) to service_role;

create or replace function public.sync_efriends_stand()
returns jsonb language sql security definer set search_path = ''
as $$
  select jsonb_build_object(
    'cube_host_hinterlegt', exists (select 1 from vault.secrets where name = 'efriends_host'),
    'live_letzter', (select max(ts) from public.live_werte),
    'flex_preise_bis', (select max(ts_start) from public.flex_preise))
$$;
revoke all on function public.sync_efriends_stand() from public, anon, authenticated;
grant execute on function public.sync_efriends_stand() to service_role;

-- Tarifvergleich: Netz-NÖ-Werte als Stundensummen [unix_sekunden, bezug_kwh, einspeisung_kwh]
create or replace function public.netz_stunden_json(von timestamptz, bis timestamptz)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_array(extract(epoch from h)::bigint, round(b::numeric, 4), round(e::numeric, 4)) order by h), '[]'::jsonb)
  from (select date_trunc('hour', ts_start) h,
               coalesce(sum(kwh) filter (where richtung = 'bezug'), 0) b,
               coalesce(sum(kwh) filter (where richtung = 'einspeisung'), 0) e
        from public.netz_15min where ts_start >= von and ts_start < bis group by 1) x
$$;
revoke all on function public.netz_stunden_json(timestamptz, timestamptz) from public, anon;
grant execute on function public.netz_stunden_json(timestamptz, timestamptz) to authenticated;

-- =====================================================================
-- Täglicher Statusbericht per E-Mail (Edge Function "bericht")
-- Empfänger steht nur in der Datenbank: sync_einstellung 'bericht_empfaenger'
-- Versand über Resend (Secret RESEND_API_KEY)
-- =====================================================================
create table if not exists public.bericht_versand (
  id        bigint generated always as identity primary key,
  gesendet  timestamptz not null default now(),
  ausloeser text,
  ok        boolean not null,
  betreff   text,
  antwort   text
);
alter table public.bericht_versand enable row level security;
revoke all on public.bericht_versand from anon, authenticated;
grant all on public.bericht_versand to service_role;

create or replace function public.bericht_json()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'laeufe', (select coalesce(jsonb_agg(to_jsonb(l) order by l.gestartet), '[]'::jsonb)
               from public.sync_lauf l where l.gestartet > now() - interval '26 hours'),
    'netz_bis', (select jsonb_object_agg(richtung, bis) from (select richtung, max(ts_start) bis from public.netz_15min group by richtung) n),
    'pv_15min_bis', (select max(ts_start) from public.pv_15min),
    'pv_tag_bis', (select max(tag) from public.pv_tag),
    'laden_letzte', (select max(start) from public.laden),
    'flex_bis', (select max(ts_start) from public.flex_preise),
    'live_letzter', (select max(ts) from public.live_werte),
    'cron', (select jsonb_object_agg(jobname, active) from cron.job),
    'cron_fehler', (select coalesce(jsonb_object_agg(jobname, n), '{}'::jsonb) from (
                      select j.jobname, count(*) n from cron.job_run_details d join cron.job j using (jobid)
                      where d.start_time > now() - interval '24 hours' and d.status = 'failed' group by 1) f),
    'empfaenger', (select wert from public.sync_einstellung where schluessel = 'bericht_empfaenger'),
    'letzter_versand', (select max(gesendet) from public.bericht_versand where ok and ausloeser = 'zeitplan')
  )
$$;
revoke all on function public.bericht_json() from public, anon, authenticated;
grant execute on function public.bericht_json() to service_role;

-- Zeitplan: täglich 05:50 UTC (06:50 Winter- bzw. 07:50 Sommerzeit), nach dem Morgen-Sync um 05:20
select cron.unschedule(jobid) from cron.job where jobname = 'bericht-taeglich';
select cron.schedule('bericht-taeglich', '50 5 * * *', $$
  select net.http_post(
    url := 'https://kdwrfhcflewvmuegmgwm.supabase.co/functions/v1/bericht',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"ausloeser": "zeitplan"}'::jsonb,
    timeout_milliseconds := 10000)
$$);

-- =====================================================================
-- Auswertungen über alle Quellen (Bereiche in „Mein Strom“)
-- =====================================================================
-- Tageswerte je Quelle (kWh, Wiener Kalendertag):
-- [tag, netz_bezug, netz_einsp, netz_viertel, ef_bezug, ef_einsp, ef_pv, ef_viertel,
--  pv_erzeugung, pv_verbrauch, pv_eigen, bat_laden, bat_entladen, pv_einsp, pv_bezug, {wallbox: kwh}]
create or replace function public.tage_alle_json(von date, bis date)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  with g as (select von::timestamp at time zone 'Europe/Vienna' a, (bis + 1)::timestamp at time zone 'Europe/Vienna' b),
  n as (select (ts_start at time zone 'Europe/Vienna')::date tag,
               sum(kwh) filter (where richtung = 'bezug') bez, sum(kwh) filter (where richtung = 'einspeisung') ein,
               count(*) filter (where richtung = 'bezug') cnt
        from public.netz_15min, g where ts_start >= g.a and ts_start < g.b group by 1),
  e as (select (ts_start at time zone 'Europe/Vienna')::date tag,
               sum(von_netz_wh) / 1000 bez, sum(ins_netz_wh) / 1000 ein, sum(pv_wh) / 1000 pv,
               count(*) filter (where coalesce(qualitaet, 100) >= 50 and not luecke) cnt   -- eFriends-Qualität < 50 = unbrauchbar
        from public.messung_beste, g where ts_start >= g.a and ts_start < g.b group by 1),
  w as (select tag, jsonb_object_agg(coalesce(wallbox, wallbox_id::text), kwh) wb
        from (select (start at time zone 'Europe/Vienna')::date tag, wallbox_id, max(wallbox) wallbox, sum(kwh) kwh
              from public.laden, g where start >= g.a and start < g.b group by 1, 2) x group by 1),
  t as (select tag from n union select tag from e union select tag from public.pv_tag where tag between von and bis union select tag from w)
  select coalesce(jsonb_agg(jsonb_build_array(
           t.tag, round(n.bez::numeric, 3), round(n.ein::numeric, 3), n.cnt,
           round(e.bez::numeric, 3), round(e.ein::numeric, 3), round(e.pv::numeric, 3), e.cnt,
           p.pv_kwh, p.verbrauch_kwh, p.eigen_kwh, p.laden_kwh, p.entladen_kwh, p.einspeisung_kwh, p.bezug_kwh,
           coalesce(w.wb, '{}'::jsonb)) order by t.tag), '[]'::jsonb)
  from t left join n using (tag) left join e using (tag) left join public.pv_tag p using (tag) left join w using (tag)
$$;
revoke all on function public.tage_alle_json(date, date) from public, anon;
grant execute on function public.tage_alle_json(date, date) to authenticated;

-- Ein Tag in Viertelstunden, alle Quellen (kWh):
-- [unix_sekunden, netz_bezug, netz_einsp, ef_bezug, ef_einsp, pv_erzeugung, pv_verbrauch, bat_laden, bat_entladen, wallbox]
create or replace function public.tag_alle_json(tag date)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  with g as (select tag::timestamp at time zone 'Europe/Vienna' a, (tag + 1)::timestamp at time zone 'Europe/Vienna' b),
  s as (select generate_series(g.a, g.b - interval '15 minutes', interval '15 minutes') ts from g),
  n as (select ts_start ts, sum(kwh) filter (where richtung = 'bezug') bez, sum(kwh) filter (where richtung = 'einspeisung') ein
        from public.netz_15min, g where ts_start >= g.a and ts_start < g.b group by 1),
  e as (select ts_start ts, von_netz_wh / 1000 bez, ins_netz_wh / 1000 ein from public.messung_beste, g where ts_start >= g.a and ts_start < g.b),
  p as (select date_bin('15 minutes', ts_start, timestamptz '2000-01-01 00:00+00') ts,
               sum(pv_wh) / 1000 pv, sum(verbrauch_wh) / 1000 verbr, sum(laden_wh) / 1000 lad, sum(entladen_wh) / 1000 entl
        from public.pv_15min, g where ts_start >= g.a and ts_start < g.b group by 1),
  w as (select ts_start ts, sum(kwh) kwh from public.laden_15min, g where ts_start >= g.a and ts_start < g.b group by 1)
  select coalesce(jsonb_agg(jsonb_build_array(extract(epoch from s.ts)::bigint,
           round(n.bez::numeric, 4), round(n.ein::numeric, 4), round(e.bez::numeric, 4), round(e.ein::numeric, 4),
           round(p.pv::numeric, 4), round(p.verbr::numeric, 4), round(p.lad::numeric, 4), round(p.entl::numeric, 4),
           round(w.kwh::numeric, 4)) order by s.ts), '[]'::jsonb)
  from s left join n using (ts) left join e using (ts) left join p using (ts) left join w using (ts)
$$;
revoke all on function public.tag_alle_json(date) from public, anon;
grant execute on function public.tag_alle_json(date) to authenticated;

-- Netzspitzen: alle Viertelstunden mit Netzbezug über einer Schwelle (kW) als [unix_sekunden, kw]
create or replace function public.netz_spitzen_json(von timestamptz, bis timestamptz, min_kw real)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_array(extract(epoch from ts_start)::bigint, round((kwh * 4)::numeric, 2)) order by ts_start), '[]'::jsonb)
  from public.netz_15min
  where richtung = 'bezug' and ts_start >= von and ts_start < bis and kwh * 4 > min_kw
$$;
revoke all on function public.netz_spitzen_json(timestamptz, timestamptz, real) from public, anon;
grant execute on function public.netz_spitzen_json(timestamptz, timestamptz, real) to authenticated;
