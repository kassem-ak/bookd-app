// Sponsored cards: the Partners carousel on Discover.
//
// The rows come from `ads`, never from the build. A card in the bundle would be
// an offer shown to every member whether or not anybody is running it, with no
// way to withdraw it short of a release.
//
// Reads `*` rather than naming columns: `image_url` and `link_url` arrive in
// 2026-10-29_ads_image_and_link.sql, and PostgREST refuses a whole query that
// names a column the table does not have yet. Before that migration the cards
// still draw, without a photo and without a button.

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
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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

  return {
    id,
    brand,
    headline,
    body: text(row.body),
    cta: cta && linkUrl ? cta : null,
    linkUrl: cta ? linkUrl : null,
    imageUrl: image && /^https:\/\//i.test(image) ? image : null,
  };
}

/** The active cards for one placement. A failed read is no cards: an advert is
 *  never worth an error on somebody's Discover screen. */
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
    .filter((ad): ad is SponsoredAd => ad !== null);
}
