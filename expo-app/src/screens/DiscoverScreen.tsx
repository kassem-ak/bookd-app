import React, { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
  Avatar, Button, Card, Chip, Field, Icon, MicroBadge, Note, PhotoScrim, Row, SectionHeading, Segmented, SnapCarousel, Stars,
  StatusLine,
} from '../components/ui';
import { AdCard } from '../components/AdCard';
import { fetchSponsoredAds, SponsoredAd } from '../lib/ads';
import { distanceKmBetween, formatDistanceKm, GeoPoint, getDevicePoint, parseGeoPoint } from '../lib/geo';
import { track } from '../lib/analytics';
import { Person, firstName, initials } from '../state/models';
import * as D from '../state/sampleData';
import { useSports } from '../components/useSports';
import { SportSearch } from '../components/SportSearch';
import { useStore } from '../state/store';
import { alpha, dark, fonts, useTheme } from '../theme';


type GeoPerson = Person & { coordinates?: GeoPoint | null };
type DiscoverEntry = { person: Person; index: number; distanceKm: number | null; distanceLabel: string | null };

function personCoordinates(p: Person) {
  return parseGeoPoint((p as GeoPerson).coordinates ?? p);
}

function personDistanceKm(p: Person, devicePoint: GeoPoint | null | undefined) {
  return distanceKmBetween(devicePoint ?? null, personCoordinates(p));
}

function personMetaLabel(p: Person, distanceLabel?: string | null) {
  const parts = p.isCoach ? [p.sport] : [p.sport, p.goal ?? ''];
  if (distanceLabel) parts.push(distanceLabel);
  return parts.filter(Boolean).join(' - ');
}

function matchesSport(p: Person, sport: string) {
  if (sport === 'All') return true;
  return p.sport.toLowerCase().includes(sport.toLowerCase());
}

export function DiscoverScreen({ loadError, onRetry }: { loadError?: string | null; onRetry?: () => void }) {
  const { c, t } = useTheme();
  const s = useStore();
  const isCoaches = s.mode === 'coaches';
  const setStoreValue = useStore((state) => state.set);
  const [devicePoint, setDevicePoint] = useState<GeoPoint | null | undefined>(undefined);
  const [ads, setAds] = useState<SponsoredAd[]>([]);
  useEffect(() => {
    let active = true;
    fetchSponsoredAds('discover').then((rows) => { if (active) setAds(rows); });
    return () => { active = false; };
  }, []);
  const query = s.discSearch;
  const setQuery = (value: string) => {
    s.set('discSearch', value);
    track('discover_searched', { has_input: value.trim().length > 0 });
  };
  const q = query.trim().toLowerCase();
  // The filter used to be a fixed list in sampleData, so a sport an admin
  // approved never appeared here and could not be filtered for.
  const { sports, failed: sportsFailed, retry: retrySports } = useSports();
  const sportNames = ['All', ...(sports ?? []).map((sport) => sport.name)];
  // The filter is held by name (it predates ids here); the shared search works
  // in ids, so the two are mapped at the edge rather than the store changed.
  const chosenSportId = (sports ?? []).find((sport) => sport.name === s.sport)?.id;
  const chooseSport = (name: string) => {
    if (name !== s.sport) track('discover_filter_changed', { filter: 'sport', selected_index: sportNames.indexOf(name) });
    s.set('sport', name);
    s.set('sportMenu', false);
  };

  const base = s.people(isCoaches ? 'coaches' : 'partners').filter((p) => matchesSport(p, s.sport) && (!q || `${p.name} ${p.sport} ${p.tags.join(' ')}`.toLowerCase().includes(q)));
  const hasCoordinatePeople = base.some((p) => personCoordinates(p));

  useEffect(() => {
    if (!hasCoordinatePeople) {
      setDevicePoint(null);
      return;
    }

    let active = true;
    getDevicePoint().then((point) => {
      if (active) setDevicePoint(point);
    });
    return () => {
      active = false;
    };
  }, [hasCoordinatePeople]);

  const entries: DiscoverEntry[] = base
    .map((person, index) => {
      const distanceKm = personDistanceKm(person, devicePoint);
      return { person, index, distanceKm, distanceLabel: formatDistanceKm(distanceKm) };
    })
    .filter((entry) => entry.distanceKm === null || entry.distanceKm <= s.searchRadius);
  const canSortByDistance = entries.some((entry) => entry.distanceKm !== null);
  const distanceCapabilityKnown = !hasCoordinatePeople || devicePoint !== undefined;

  useEffect(() => {
    if (s.sortBy === 'distance' && distanceCapabilityKnown && !canSortByDistance) setStoreValue('sortBy', 'rating');
  }, [canSortByDistance, distanceCapabilityKnown, s.sortBy, setStoreValue]);

  const sortOffered = isCoaches
    ? ['rating', 'price', ...(canSortByDistance ? ['distance'] : [])]
    : [...(canSortByDistance ? ['distance'] : [])];
  useEffect(() => {
    // Rating and Price disappear in Partners mode, but the stored key did not,
    // so the list stayed sorted by a chip that was no longer on screen.
    if (sortOffered.length > 0 && !sortOffered.includes(s.sortBy)) {
      setStoreValue('sortBy', sortOffered[0]);
    }
  }, [sortOffered.join(','), s.sortBy, setStoreValue]);

  const activeSortBy = s.sortBy === 'distance' && !canSortByDistance ? null : s.sortBy;
  // Boosting buys the carousel, not a place out of the list: a boosted coach
  // is still where the chosen sort puts them below, so sorting by price still
  // shows every coach in price order.
  const featured = isCoaches ? entries.filter((entry) => entry.person.boosted) : [];
  const rest = entries
    .slice()
    .sort((a, b) => {
      if (activeSortBy === 'price') return (a.person.price ?? 0) - (b.person.price ?? 0);
      if (activeSortBy === 'distance') {
        if (a.distanceKm !== null && b.distanceKm !== null) return a.distanceKm - b.distanceKm;
        if (a.distanceKm !== null) return -1;
        if (b.distanceKm !== null) return 1;
        return a.index - b.index;
      }
      if (activeSortBy === 'rating') return b.person.rating - a.person.rating;
      return a.index - b.index;
    });
  const sortOptions = [
    ...(isCoaches ? [{ key: 'rating', label: 'Rating' }] : []),
    ...(isCoaches ? [{ key: 'price', label: 'Price' }] : []),
    ...(canSortByDistance ? [{ key: 'distance', label: 'Distance' }] : []),
  ];
  const peopleLabel = isCoaches ? 'coaches' : 'training partners';
  const emptyMessage = !s.loaded.people
    ? `Loading ${peopleLabel}...`
    : base.length > 0 && entries.length === 0 ? `No ${peopleLabel} within ${s.searchRadius} km.`
    : q ? `No ${peopleLabel} match your search.`
      : s.sport === 'All' ? `No ${peopleLabel} listed yet.` : `No ${peopleLabel} listed for ${s.sport} yet.`;

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 24, paddingBottom: 24 }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }} gap={12}>
        <View style={{ flex: 1 }}>
          <Text style={[t.bodySm, { color: c.txt2 }]}>{s.authName ? `Hey ${firstName(s.authName)}` : 'Let’s'}</Text>
          <Text style={[t.pageTitle, { color: c.txt, marginTop: 3 }]}>Find your coach{ '\n' }or partner</Text>
          {s.authLoc.trim() ? <Text style={[t.label, { color: c.accent, marginTop: 3 }]}>{s.authLoc.trim()}</Text> : null}
        </View>
        <Row gap={8}>
          <Pressable onPress={s.openNotifs} accessibilityRole="button" accessibilityLabel="Notifications"
            style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: c.surface, borderColor: c.line, borderWidth: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="bell" size={24} color={c.txt} />
          </Pressable>
          <Pressable onPress={() => s.set('tab', 'profile')} accessibilityRole="button" accessibilityLabel="Your profile"
            style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: c.surface, borderColor: c.line, borderWidth: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="user" size={24} color={c.txt} />
          </Pressable>
        </Row>
      </Row>

      <Row style={{ marginTop: 28, marginBottom: 12, justifyContent: 'space-between' }} gap={12}>
        <Pressable onPress={() => s.set('sportMenu', !s.sportMenu)} accessibilityRole="button" accessibilityLabel={`Chosen sport: ${s.sport}. Choose a sport`} style={{ minHeight: 44, justifyContent: 'center', flex: 1 }}>
          <Text style={[t.caption, { color: c.txt2, marginBottom: 5 }]}>Chosen Sport</Text>
          <Row gap={5}>
            {s.sport === 'All' ? <>
              <MaterialCommunityIcons name="basketball" size={16} color={c.accent} />
              <MaterialCommunityIcons name="tennis" size={16} color={c.accent} />
              <MaterialCommunityIcons name="boxing-glove" size={16} color={c.accent} />
            </> : <Text style={[t.labelSm, { color: c.accent }]} numberOfLines={1}>{s.sport}</Text>}
          </Row>
        </Pressable>
        <View style={{ width: 150 }}>
          <Segmented options={[{ key: 'coaches', label: 'coaches' }, { key: 'partners', label: 'Partners' }]}
            selected={s.mode} onSelect={(key) => {
              if (key !== s.mode) track('discover_filter_changed', { filter: 'mode', mode: key });
              s.set('mode', key);
            }} fontSize={13} pad={9} />
        </View>
      </Row>

      <Pressable onPress={() => s.set('sportMenu', !s.sportMenu)} accessibilityRole="button" accessibilityLabel="Choose sport or hobby" accessibilityState={{ expanded: s.sportMenu }}
        // Gutter and height match the Field directly below, so the two stacked
        // controls start their text on the same line.
        style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48, backgroundColor: c.surface, borderColor: c.line, borderWidth: 1, borderRadius: 999, paddingHorizontal: 14 }}>
        <Text style={[t.labelSm, { color: c.soft, flex: 1 }]}>{s.sport === 'All' ? 'All sports and hobbies' : s.sport}</Text>
        <Icon name={s.sportMenu ? 'chevron-up' : 'chevron-down'} size={20} color={c.txt3} />
      </Pressable>
      {s.sportMenu && (
        <Card style={{ marginTop: 8, padding: 6 }}>
          {/* Clearing the filter is not a sport, so it sits above the search. */}
          <Pressable accessibilityRole="button" accessibilityState={{ selected: s.sport === 'All' }}
            onPress={() => chooseSport('All')}
            style={{ paddingVertical: 11, paddingHorizontal: 10, borderRadius: 10, minHeight: 44, justifyContent: 'center', marginBottom: 6, backgroundColor: s.sport === 'All' ? alpha(c.volt, 0.1) : 'transparent' }}>
            <Text style={[t.label, { color: s.sport === 'All' ? c.accent : c.txt }]}>All sports and hobbies</Text>
          </Pressable>
          {!sports && !sportsFailed && <Text accessibilityLiveRegion="polite" style={[t.bodySm, { color: c.txt3, padding: 11 }]}>Loading sports and hobbies…</Text>}
          {sportsFailed && (
            <View style={{ padding: 11, gap: 10, alignItems: 'flex-start' }}>
              <Text style={[t.bodySm, { color: c.danger }]}>Sports and hobbies could not load.</Text>
              <Button label="Try again" icon="refresh-cw" tone="danger"
                accessibilityLabel="Retry loading sports and hobbies" onPress={retrySports} />
            </View>
          )}
          {/* The same search as every other picker: layered by kind and
              category, the engine behind it when nothing matches, and asking
              for a missing sport right here rather than on a separate form. */}
          {sports && (
            <View style={{ padding: 6 }}>
              <SportSearch
                sports={sports}
                single
                selected={chosenSportId ? [chosenSportId] : []}
                onPick={(id) => {
                  const picked = sports.find((sport) => sport.id === id);
                  if (picked) chooseSport(picked.name);
                }}
              />
            </View>
          )}
        </Card>
      )}
      <View style={{ marginTop: 10 }}>
        <Field value={query} onChange={setQuery} placeholder="Search Coach, Mentor" icon="search" />
      </View>

      {/* Keyed by mode so switching coaches|Partners starts each carousel
          back at its first card. */}
      {featured.length > 0 && <View key="featured-coaches">
        <SectionHeading style={{ marginTop: 26, marginBottom: 11 }}>Featured coaches</SectionHeading>
        <SnapCarousel items={featured} keyOf={({ person }) => person.id} glow={14}
          renderItem={({ person, distanceLabel }, width) => (
            <FeaturedCoachCard p={person} width={width} distanceLabel={distanceLabel} onPress={() => s.openPerson(person.id)} />
          )} />
      </View>}
      {!isCoaches && ads.length > 0 && <View key="partner-ads" style={{ marginTop: 26 }}>
        <SnapCarousel items={ads} keyOf={(ad) => ad.id} renderItem={(ad, width) => <AdCard ad={ad} width={width} />} />
      </View>}

      <Row style={{ marginTop: 26, marginBottom: 11, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <SectionHeading>All {isCoaches ? 'coaches' : 'partners'}</SectionHeading>
        {entries.length > 1 && <Row gap={4}>
          {sortOptions.map(({ key, label }) => (
            <Chip key={key} label={label} active={s.sortBy === key} onPress={() => {
              if (key !== s.sortBy) track('discover_sort_changed', { sort: key });
              setStoreValue('sortBy', key);
            }} />
          ))}
        </Row>}
      </Row>
      {loadError ? <View accessibilityRole="alert">
        <StatusLine>{loadError}</StatusLine>
        {onRetry && <Button label="Try again" icon="refresh-cw" tone="danger" onPress={onRetry} style={{ marginTop: 12 }} />}
      </View> : entries.length === 0 && (
        <View style={{ gap: 12, alignItems: 'flex-start' }}>
          <StatusLine>{emptyMessage}</StatusLine>
          {/* Only reachable from onboarding before this, so a radius that
              excluded everybody was permanent. */}
          {s.loaded.people && base.length > 0 && s.searchRadius < 100 && (
            <Button label="Search wider" icon="maximize-2"
              accessibilityLabel={`Widen the search to ${Math.min(s.searchRadius * 2, 100)} km`}
              onPress={() => setStoreValue('searchRadius', Math.min(s.searchRadius * 2, 100))} />
          )}
        </View>
      )}
      <View style={{ gap: 12 }}>
        {rest.map(({ person, distanceLabel }) => <PersonCard key={person.id} p={person} distanceLabel={distanceLabel} onPress={() => s.openPerson(person.id)} />)}
      </View>
    </ScrollView>
  );
}

// A boosted coach, as a photo card in the Featured carousel.
//
// Drawn dark in both themes: white type sits on the photo, held up by the
// scrim. The gold edge is a shadow on the outer view and the clipping on the
// inner one, because a view that clips also clips its own outer shadow.
function FeaturedCoachCard({ p, width, distanceLabel, onPress }: {
  p: Person; width: number; distanceLabel?: string | null; onPress: () => void;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const photo = p.avatarUrl && p.avatarUrl !== failedUrl ? p.avatarUrl : null;
  const meta = personMetaLabel(p, distanceLabel);
  const hasPrice = Number(p.price) > 0;
  const rating = p.reviews > 0 ? `${p.rating.toFixed(1)} (${p.reviews})` : null;
  return (
    <Pressable onPress={onPress} accessibilityRole="button"
      accessibilityLabel={[`${p.name}, boosted coach`, meta, rating && `rated ${rating}`, hasPrice && `$${p.price} per session`].filter(Boolean).join(', ')}
      style={{
        width,
        height: 228,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: 'rgba(242,200,75,0.45)',
        backgroundColor: dark.surface2,
        boxShadow: '0 0 16px rgba(242,200,75,0.22), inset 0 0 12px rgba(242,200,75,0.12)',
      }}>
      <View style={[StyleSheet.absoluteFill, { borderRadius: 21, overflow: 'hidden' }]}>
        {photo ? (
          <Image source={{ uri: photo }} onError={() => setFailedUrl(photo)} resizeMode="cover"
            style={StyleSheet.absoluteFill} accessibilityIgnoresInvertColors />
        ) : (
          // No photo: the initials, large, where the face would be.
          <View style={[StyleSheet.absoluteFill, { backgroundColor: dark.avatarBg, alignItems: 'center', paddingTop: 44 }]}>
            <Text style={{ fontFamily: fonts.archivo800, fontSize: 56, color: 'rgba(255,255,255,0.22)' }}>{initials(p.name)}</Text>
          </View>
        )}
        <PhotoScrim from={0.35} opacity={0.92} />
      </View>

      <View style={{ position: 'absolute', top: 12, left: 12, backgroundColor: 'rgba(13,14,17,0.72)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}>
        <Text style={{ fontFamily: fonts.archivo800, fontSize: 9, letterSpacing: 0.8, color: dark.amber }}>BOOSTED</Text>
      </View>

      <View style={{ position: 'absolute', left: 16, right: 16, bottom: 14, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontFamily: fonts.archivo800, fontSize: 21, letterSpacing: -0.4, color: '#FFFFFF' }}>{p.name}</Text>
          <Text numberOfLines={1} style={{ fontFamily: fonts.hanken400, fontSize: 13, color: 'rgba(255,255,255,0.78)', marginTop: 3 }}>{meta}</Text>
          {rating && <Row gap={4} style={{ marginTop: 6 }}>
            <Text style={{ fontSize: 12, color: dark.amber }}>★</Text>
            <Text style={{ fontFamily: fonts.hanken700, fontSize: 13, color: dark.amber }}>{rating}</Text>
          </Row>}
        </View>
        {/* Same rule as the list card: no rate set is not a free coach, so
            say nothing rather than $0. */}
        {hasPrice && <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ fontFamily: fonts.archivo800, fontSize: 22, color: dark.volt, fontVariant: ['tabular-nums'] }}>${p.price}</Text>
          <Text style={{ fontFamily: fonts.hanken400, fontSize: 11, color: 'rgba(255,255,255,0.62)' }}>per session</Text>
        </View>}
      </View>
    </Pressable>
  );
}

export function PersonCard({ p, distanceLabel, onPress }: { p: Person; distanceLabel?: string | null; onPress: () => void }) {
  const { c, t } = useTheme();
  return (
    <Card onPress={onPress} background={p.boosted ? alpha(c.amber, 0.09) : undefined} borderColor={p.boosted ? alpha(c.amber, 0.3) : undefined}>
      <Row style={{ padding: 14 }} gap={14}>
        <Avatar initials={initials(p.name)} avatarUrl={p.avatarUrl} size={54} radius={16} bg={p.boosted ? alpha(c.amber, 0.13) : undefined} />
        <View style={{ flex: 1 }}>
          <Text style={[t.name, { color: c.txt }]} numberOfLines={1}>{p.name}</Text>
          <Text style={[t.bodySm, { color: c.txt2, marginTop: 3 }]} numberOfLines={1}>{personMetaLabel(p, distanceLabel)}</Text>
          {p.reviews > 0 && <Row gap={3} style={{ marginTop: 4 }}>
            <Stars value={1} size={12} />
            <Text style={[t.labelSm, { color: c.amberText }]}>{p.rating.toFixed(1)} ({p.reviews})</Text>
          </Row>}
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          {p.boosted && <MicroBadge label="BOOSTED" bg={alpha(c.amber, 0.2)} fg={c.amberText} />}
          {/* A coach who has not set a rate is not a free coach. `$0 per
              session` advertised exactly that, and it is the first thing a
              member reads on the card. Say nothing until there is something
              to say. */}
          {p.isCoach ? (
            Number(p.price) > 0 ? (
              <>
                <Text style={[t.price, { color: c.accent }]}>${p.price}</Text>
                <Text style={[t.caption, { color: c.txt3 }]}>per session</Text>
              </>
            ) : (
              <Text style={[t.caption, { color: c.txt3 }]}>Ask for a price</Text>
            )
          ) : <Text style={[t.labelSm, { color: c.txt2 }]}>{p.level}</Text>}
        </View>
      </Row>
    </Card>
  );
}
