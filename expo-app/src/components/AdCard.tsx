import React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { track } from '../lib/analytics';
import { AdPlacement, fetchSponsoredAds, recordAdEvent, SponsoredAd } from '../lib/ads';
import { dark, fonts, useTheme } from '../theme';
import { Button, CoverPhoto, FormSheet, Icon, PhotoScrim, pillBlur, SectionHeading, SnapCarousel } from './ui';

// A sponsored card: a photo, who is paying, what they offer, and a button out.
//
// Drawn dark in both themes. It is a photo with white type over it, and the
// light theme's pale surface would put that type on near-white wherever the
// photo is missing or still loading.

const SHADOW = { textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 8 };

export function AdCard({ ad, width, placement }: { ad: SponsoredAd; width: number; placement: AdPlacement }) {
  const [failed, setFailed] = React.useState(false);
  const [why, setWhy] = React.useState(false);

  const open = () => {
    if (!ad.linkUrl) return;
    recordAdEvent(ad.id, 'open');
    track('ad_opened', { ad_id: ad.id, placement });
    // A new tab on the web: openBrowserAsync navigates the page itself, which
    // would unmount the app behind it. Same reasoning as SocialLinks.
    if (Platform.OS === 'web') window.open(ad.linkUrl, '_blank', 'noopener,noreferrer');
    else void WebBrowser.openBrowserAsync(ad.linkUrl).catch(() => {});
  };

  return (
    <View
      style={{
        width,
        height: 230,
        borderRadius: 20,
        overflow: 'hidden',
        padding: 16,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        // The partner's own colour stands in for a missing photo.
        backgroundColor: ad.tint ?? dark.surface2,
        justifyContent: 'space-between',
      }}
    >
      {ad.imageUrl && !failed && <CoverPhoto uri={ad.imageUrl} onError={() => setFailed(true)} />}
      <PhotoScrim from={0.3} opacity={0.55} />

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={[{
          height: 22, paddingHorizontal: 9, borderRadius: 999, justifyContent: 'center',
          backgroundColor: 'rgba(13,14,17,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
        }, pillBlur]}>
          <Text style={{ fontFamily: fonts.archivo800, fontSize: 9, letterSpacing: 1.2, color: '#FFFFFF' }}>SPONSORED</Text>
        </View>
        <Pressable onPress={() => { setWhy(true); track('ad_why_opened', { ad_id: ad.id, placement }); }}
          accessibilityRole="button" accessibilityLabel={`Why am I seeing this ad from ${ad.brand}?`}
          hitSlop={{ top: 11, bottom: 11, left: 11, right: 11 }}
          style={[{
            width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(13,14,17,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
          }, pillBlur]}>
          <Icon name="info" size={13} color="#FFFFFF" />
        </Pressable>
      </View>

      <View>
        {/* One stop for a screen reader: who, what, and the line of copy. The
            buttons stay separate so each can still be reached. */}
        <View accessible accessibilityLabel={`Sponsored by ${ad.brand}. ${ad.headline}.${ad.body ? ` ${ad.body}` : ''}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 4 }}>
            {ad.logo ? (
              <View style={{ minWidth: 20, height: 20, paddingHorizontal: 4, borderRadius: 6, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontFamily: fonts.archivo800, fontSize: 9, color: dark.ink }}>{ad.logo}</Text>
              </View>
            ) : null}
            <Text numberOfLines={1} style={[SHADOW, { flexShrink: 1, fontFamily: fonts.hanken700, fontSize: 12, color: 'rgba(255,255,255,0.85)' }]}>
              {ad.brand}
            </Text>
          </View>
          <Text numberOfLines={2} style={[SHADOW, { fontFamily: fonts.archivo800, fontSize: 20, lineHeight: 24, letterSpacing: -0.3, color: '#FFFFFF', textShadowRadius: 10 }]}>
            {ad.headline}
          </Text>
          {ad.body ? (
            <Text numberOfLines={2} style={[SHADOW, { fontFamily: fonts.hanken400, fontSize: 13, lineHeight: 19, color: 'rgba(255,255,255,0.9)', marginTop: 5, textShadowColor: 'rgba(0,0,0,0.6)' }]}>
              {ad.body}
            </Text>
          ) : null}
        </View>
        {ad.cta && ad.linkUrl ? (
          <Pressable onPress={open} accessibilityRole="link"
            accessibilityLabel={`${ad.cta}, ${ad.brand}`} accessibilityHint="Opens in your browser"
            // 40 tall as designed; the slop brings the target to the 44 every
            // other control in the app clears.
            hitSlop={{ top: 2, bottom: 2 }}
            style={{
              marginTop: 12, height: 40, borderRadius: 13, paddingHorizontal: 14, alignSelf: 'flex-start',
              flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: dark.volt,
            }}>
            <Text style={{ fontFamily: fonts.archivo800, fontSize: 15, color: dark.ink }}>{ad.cta}</Text>
            <Icon name="arrow-up-right" size={15} color={dark.ink} />
          </Pressable>
        ) : null}
      </View>

      <WhyThisAd ad={ad} visible={why} onClose={() => setWhy(false)} />
    </View>
  );
}

// What a member is owed about an advert: who paid, who the partner meant it
// for, and what BOOK'D does and does not do with them. Every line here has to
// stay true -- if cards are ever chosen from a member's profile, the first
// paragraph changes with that code.
function WhyThisAd({ ad, visible, onClose }: { ad: SponsoredAd; visible: boolean; onClose: () => void }) {
  const { c, t } = useTheme();
  return (
    <FormSheet visible={visible} title="Why this ad?" subtitle={`Sponsored by ${ad.brand}`} onClose={onClose}
      footer={<Button label="Got it" full onPress={onClose} />}>
      <Text style={[t.body, { color: c.txt, lineHeight: 21 }]}>
        {ad.brand} paid BOOK'D to show this card. Everyone who opens this screen sees the same cards; BOOK'D does not
        pick them from your profile, your sports or your messages.
      </Text>
      {ad.audience.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={[t.label, { color: c.txt }]}>Who {ad.brand} says it is for</Text>
          {ad.audience.map((line) => (
            <Text key={line} style={[t.bodySm, { color: c.txt2 }]}>{`• ${line}`}</Text>
          ))}
        </View>
      )}
      <Text style={[t.bodySm, { color: c.txt2, lineHeight: 19 }]}>
        BOOK'D counts how many times each card is seen and how many times its button is tapped, per day, so the partner
        knows it reached people. It does not record who saw it or who tapped it.
      </Text>
    </FormSheet>
  );
}

/** A heading-less carousel of the live cards for one placement. Draws nothing
 *  while loading, on a failed read, or when nobody is advertising.
 *
 *  `reloadKey` refetches: bump it from a screen's own retry so a card the
 *  partner just switched off goes away with everything else. */
export function AdCarousel({ placement, reloadKey = 0, heading, style }: {
  placement: AdPlacement; reloadKey?: number; heading?: string; style?: object;
}) {
  const [ads, setAds] = React.useState<SponsoredAd[]>([]);
  React.useEffect(() => {
    let active = true;
    fetchSponsoredAds(placement).then((rows) => { if (active) setAds(rows); });
    return () => { active = false; };
  }, [placement, reloadKey]);
  if (ads.length === 0) return null;
  return (
    <View style={style}>
      {heading ? <SectionHeading style={{ marginBottom: 11 }}>{heading}</SectionHeading> : null}
      <SnapCarousel items={ads} keyOf={(ad) => ad.id}
        // The card at the start of the row is the one on screen; the peek of
        // the next one is not a view.
        onIndexChange={(i) => {
          const ad = ads[i];
          if (ad && recordAdEvent(ad.id, 'view')) track('ad_viewed', { ad_id: ad.id, placement });
        }}
        renderItem={(ad, width) => <AdCard ad={ad} width={width} placement={placement} />} />
    </View>
  );
}
