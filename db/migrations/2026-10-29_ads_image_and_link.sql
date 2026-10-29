-- Sponsored cards on Discover: a picture and somewhere to go.
--
-- The v2 design puts sponsored cards in a carousel at the top of Discover's
-- Partners view. Each one is a photo with a brand, a headline, a line of copy
-- and a button that leaves the app. `ads` already holds the words; it has no
-- column for the photo or for where the button goes, so this adds both.
--
-- Nothing is inserted here. Until somebody adds a row with `placement =
-- 'discover'` and `active = true`, the app shows no carousel at all.
--
-- Existing rows: untouched. Both columns are new and nullable. A row without
-- `image_url` draws on a plain dark card; a row without `link_url` shows no
-- button, because a button that goes nowhere is worse than none.
--
-- Reversible:
--   alter table public.ads drop constraint if exists ads_link_url,
--                          drop constraint if exists ads_image_url,
--                          drop column if exists link_url,
--                          drop column if exists image_url;

alter table public.ads
  add column if not exists image_url text,
  add column if not exists link_url  text;

-- The same rule a member's own website goes through (2026-09-27_website_link):
-- http or https, a real host, no credentials. The app checks again before it
-- opens anything, but a 'javascript:' link should never get as far as a row.
alter table public.ads
  drop constraint if exists ads_link_url,
  add constraint ads_link_url check (public.is_web_url(link_url));

alter table public.ads
  drop constraint if exists ads_image_url,
  add constraint ads_image_url check (image_url is null or image_url ~* '^https://');

-- Reading is already open to anyone signed in (`ads_read`, active rows only).
-- Said again here so the carousel does not depend on a default grant nobody
-- wrote down. Writes stay revoked (hardening.sql); ads are added from the
-- console with the service role.
grant select on public.ads to authenticated;
