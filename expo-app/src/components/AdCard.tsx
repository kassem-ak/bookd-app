import React from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { track } from '../lib/analytics';
import { SponsoredAd } from '../lib/ads';
import { dark, fonts } from '../theme';
import { Icon, PhotoScrim } from './ui';

// A sponsored card: a photo, who is paying, what they offer, and a button out.
//
// Drawn dark in both themes. It is a photo with white type over it, and the
// light theme's pale surface would put that type on near-white wherever the
// photo is missing or still loading.

const SHADOW = { textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 8 };

export function AdCard({ ad, width }: { ad: SponsoredAd; width: number }) {
  const [failed, setFailed] = React.useState(false);

  const open = () => {
    if (!ad.linkUrl) return;
    track('ad_opened', { ad_id: ad.id });
    // A new tab on the web: openBrowserAsync navigates the page itself, which
    // would unmount the app behind it. Same reasoning as SocialLinks.
    if (Platform.OS === 'web') window.open(ad.linkUrl, '_blank', 'noopener,noreferrer');
    else void WebBrowser.openBrowserAsync(ad.linkUrl).catch(() => {});
  };

  return (
    <View
      accessible={!ad.linkUrl}
      accessibilityLabel={`Sponsored by ${ad.brand}. ${ad.headline}.${ad.body ? ` ${ad.body}` : ''}`}
      style={{
        width,
        height: 230,
        borderRadius: 20,
        overflow: 'hidden',
        padding: 16,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: dark.surface2,
        justifyContent: 'space-between',
      }}
    >
      {ad.imageUrl && !failed && (
        <Image source={{ uri: ad.imageUrl }} onError={() => setFailed(true)} resizeMode="cover"
          style={StyleSheet.absoluteFill} accessibilityIgnoresInvertColors />
      )}
      <PhotoScrim from={0.3} opacity={0.55} />

      <View style={{
        alignSelf: 'flex-start', height: 22, paddingHorizontal: 9, borderRadius: 999, justifyContent: 'center',
        backgroundColor: 'rgba(13,14,17,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
      }}>
        <Text style={{ fontFamily: fonts.archivo800, fontSize: 9, letterSpacing: 1.2, color: '#FFFFFF' }}>SPONSORED</Text>
      </View>

      <View>
        <Text numberOfLines={1} style={[SHADOW, { fontFamily: fonts.hanken700, fontSize: 12, color: 'rgba(255,255,255,0.85)', marginBottom: 3 }]}>
          {ad.brand}
        </Text>
        <Text numberOfLines={2} style={[SHADOW, { fontFamily: fonts.archivo800, fontSize: 20, lineHeight: 24, letterSpacing: -0.3, color: '#FFFFFF', textShadowRadius: 10 }]}>
          {ad.headline}
        </Text>
        {ad.body ? (
          <Text numberOfLines={2} style={[SHADOW, { fontFamily: fonts.hanken400, fontSize: 13, lineHeight: 19, color: 'rgba(255,255,255,0.9)', marginTop: 5, textShadowColor: 'rgba(0,0,0,0.6)' }]}>
            {ad.body}
          </Text>
        ) : null}
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
    </View>
  );
}
