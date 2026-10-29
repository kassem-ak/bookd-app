-- Sponsored cards: a chosen order, and numbers a partner can be shown.
--
-- Follows 2026-10-29_ads_image_and_link.sql. Apply that one first.
--
-- 1. `ads.position`: lower comes first in a carousel. The app sorts on it in
--    the client (it reads `*`, so it keeps working before this lands); rows
--    without one go last, by brand.
--
-- 2. `ad_daily_stats`: one row per card per day with a count of views and of
--    button opens. Analytics in the app has no sink, so without this nobody
--    can tell a partner whether their card was seen. It holds counts only: no
--    member id, no device, nothing that says who looked.
--
-- 3. `record_ad_event(p_ad, p_kind)`: the only way in. A signed-in member can
--    add one to today's count for an active card, and nothing else -- the
--    table itself is not readable or writable by clients.
--
-- Existing rows: untouched. `position` is new and nullable; the stats table
-- starts empty. Nothing is inserted.
--
-- Reversible:
--   drop function if exists public.record_ad_event(uuid, text);
--   drop table if exists public.ad_daily_stats;
--   alter table public.ads drop column if exists position;

alter table public.ads
  add column if not exists position integer;

create table if not exists public.ad_daily_stats (
  ad_id uuid not null references public.ads(id) on delete cascade,
  day   date not null default (now() at time zone 'utc')::date,
  views integer not null default 0 check (views >= 0),
  opens integer not null default 0 check (opens >= 0),
  primary key (ad_id, day)
);

alter table public.ad_daily_stats enable row level security;
-- No policies: clients go through record_ad_event, the console reads with the
-- service role.
revoke all on public.ad_daily_stats from public, anon, authenticated;
grant select on public.ad_daily_stats to service_role;

-- ponytail: one counter row per card per day, no per-member dedupe on the
-- server. The app sends at most one view per card per launch; a client that
-- loops on the RPC can still inflate a count. If partners are ever billed on
-- these numbers, add a per-user-per-day guard table before doing so.
create or replace function public.record_ad_event(p_ad uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind not in ('view', 'open') then
    raise exception 'Unknown ad event %.', p_kind;
  end if;
  -- A withdrawn card stops counting the moment it is switched off, even on a
  -- phone that still has it on screen.
  if not exists (select 1 from public.ads where id = p_ad and active) then
    return;
  end if;
  insert into public.ad_daily_stats as s (ad_id, day, views, opens)
  values (p_ad, (now() at time zone 'utc')::date,
          case when p_kind = 'view' then 1 else 0 end,
          case when p_kind = 'open' then 1 else 0 end)
  on conflict (ad_id, day) do update
    set views = s.views + excluded.views,
        opens = s.opens + excluded.opens;
end;
$$;

revoke all on function public.record_ad_event(uuid, text) from public, anon;
grant execute on function public.record_ad_event(uuid, text) to authenticated;
