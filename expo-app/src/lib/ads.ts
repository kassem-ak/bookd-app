// Sponsored cards: the Partners carousel on Discover and the one in Chat.
//
// The rows come from `ads`, never from the build. A card in the bundle would be
// an offer shown to every member whether or not anybody is running it, with no
// way to withdraw it short of a release.
//
// Reads `*` rather than naming columns: `image_url`, `link_url` and `position`
// arrive in later migrations, and PostgREST refuses a whole query that names
// (or orders by) a column the table does not have yet. Before those migrations
// the cards still draw, without a photo, a button or a chosen order.

import { websiteProblem } from './socialLinks';
import { supabase, isSupabaseConfigured } from './supabase';

export type AdPlacement = 'discover' | 'community';

export type SponsoredAd = {
  id: string;
  brand: string;
  headline: string;
  body: string | null;
  cta: string | null;
  imageUrl: string | null;
  /** Only an address that passed the same check as a member's website. */
  linkUrl: string | null;
  /** Up to three letters drawn in a badge beside the brand. */
  logo: string | null;
  /** The card's colour when there is no photo, as `#RRGGBB`. */
  tint: string | null;
  /** Who the partner said the card is for, in plain lines. Empty: everyone. */
  audience: string[];
  /** Lower comes first; a row without one goes after every row with one. */
  position: number | null;
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function words(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map(text).filter((w): w is string => w !== null && w.length <= 40).slice(0, 5);
}

function joinWords(list: string[]) {
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** `targeting` as sentences a member can read. Unknown keys are ignored rather
 *  than printed: the column is free JSON and a raw key is not an explanation. */
export function audienceLines(targeting: unknown): string[] {
  if (!targeting || typeof targeting !== 'object' || Array.isArray(targeting)) return [];
  const t = targeting as Record<string, unknown>;
  const lines: string[] = [];
  const hobbies = words(t.hobbies);
  const goals = words(t.goal ?? t.goals);
  const communities = words(t.communities);
  if (hobbies.length) lines.push(`People into ${joinWords(hobbies)}`);
  if (goals.length) lines.push(`People whose goal is ${joinWords(goals)}`);
  if (communities.length) lines.push(`Members of ${joinWords(communities)} communities`);
  return lines;
}

/** A row made into a card, or null when it has nothing worth showing.
 *
 *  A card needs a brand and a headline: without either it is an empty box that
 *  says SPONSORED. The button needs both its words and somewhere safe to go,
 *  so one without the other is dropped rather than drawn dead. */
export function toSponsoredAd(row: Record<string, unknown>): SponsoredAd | null {
  const id = text(row.id);
  const brand = text(row.brand);
  const headline = text(row.headline);
  if (!id || !brand || !headline) return null;

  const link = text(row.link_url);
  const linkUrl = link && !websiteProblem(link) ? link : null;
  const cta = text(row.cta);
  const image = text(row.image_url);
  const logo = text(row.logo);
  const tint = text(row.tint);
  const position = typeof row.position === 'number' && Number.isFinite(row.position) ? row.position : null;

  return {
    id,
    brand,
    headline,
    body: text(row.body),
    cta: cta && linkUrl ? cta : null,
    linkUrl: cta ? linkUrl : null,
    imageUrl: image && /^https:\/\//i.test(image) ? image : null,
    logo: logo && /^[\p{L}\p{N}]{1,3}$/u.test(logo) ? logo.toUpperCase() : null,
    tint: tint && /^#[0-9a-f]{6}$/i.test(tint) ? tint : null,
    audience: audienceLines(row.targeting),
    position,
  };
}

/** Chosen order first, then by brand so the rest do not reshuffle per read. */
export function byPosition(a: SponsoredAd, b: SponsoredAd) {
  if (a.position !== null && b.position !== null && a.position !== b.position) return a.position - b.position;
  if (a.position !== null && b.position === null) return -1;
  if (a.position === null && b.position !== null) return 1;
  return a.brand.localeCompare(b.brand) || a.id.localeCompare(b.id);
}

/** The active cards for one placement. A failed read is no cards: an advert is
 *  never worth an error on somebody's screen. */
export async function fetchSponsoredAds(placement: AdPlacement): Promise<SponsoredAd[]> {
  if (!isSupabaseConfigured || !supabase) return [];
  const { data, error } = await supabase
    .from('ads')
    .select('*')
    .eq('placement', placement)
    .eq('active', true);
  if (error || !Array.isArray(data)) return [];
  return data
    .map((row) => toSponsoredAd(row as Record<string, unknown>))
    .filter((ad): ad is SponsoredAd => ad !== null)
    .sort(byPosition);
}

export type AdEventKind = 'view' | 'open';

// One view per card per launch: scrolling back to a card is not a second look
// worth billing, and it keeps a fidgety thumb from flooding the table.
const viewed = new Set<string>();

/** Counts a view or an open on the server, where the partner's numbers live.
 *  Analytics has no sink, so this is the only record a partner can be shown.
 *  Returns whether this one counted (a repeat view does not).
 *  Fire and forget: before the migration the function does not exist, and a
 *  count is never worth an error on screen. */
export function recordAdEvent(adId: string, kind: AdEventKind): boolean {
  if (!isSupabaseConfigured || !supabase) return false;
  if (kind === 'view') {
    if (viewed.has(adId)) return false;
    viewed.add(adId);
  }
  try {
    void Promise.resolve(supabase.rpc('record_ad_event', { p_ad: adId, p_kind: kind })).catch(() => {});
  } catch {
    // A missing client method or a synchronous throw is still not the member's problem.
  }
  return true;
}
