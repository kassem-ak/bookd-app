import { Feather, FontAwesome } from '@expo/vector-icons';
import React, { ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Modal,
  Pressable,
  Image,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { alpha, avatarSize, radii, useTheme } from '../theme';

export type IconName = React.ComponentProps<typeof Feather>['name'];

export function Icon({ name, size = 20, color }: { name: IconName; size?: number; color: string }) {
  return <Feather name={name} size={size} color={color} />;
}

// Feather carries no Apple or Microsoft mark, so the sign-in providers use
// FontAwesome's brand glyphs to keep all four looking like one set.
export type BrandName = 'facebook' | 'google' | 'apple' | 'windows';

export function BrandIcon({ name, size = 18, color }: { name: BrandName; size?: number; color: string }) {
  return <FontAwesome name={name} size={size} color={color} />;
}

// The BOOK'D mark, drawn rather than loaded.
//
// The same two shapes as the app icon, from assets/brand/BOOKD_app_icon.svg:
// they have to agree, because this is what someone sees on the way in from a
// home screen where they just tapped the other one.
//
// A component and not an <Image> because the ring is the foreground colour and
// so changes with the theme -- shipping it as a PNG would mean two files, and
// two files drift. The viewBox is the mark's own bounding box, so `size` is the
// height you actually get.
export function BrandMark({ size = 44, color }: { size?: number; color?: string }) {
  const { c } = useTheme();
  return (
    <Svg width={size * (648.6 / 628)} height={size} viewBox="198 198 648.6 628"
      accessibilityRole="image" accessibilityLabel="BOOK'D">
      <Circle cx="512" cy="512" r="260" fill="none" stroke={color ?? c.txt} strokeWidth={108} />
      <Path d="M540.6,419l209-209h97l-169,285-90,48-47-124Z" fill={c.volt} />
    </Svg>
  );
}

// ---- Card ----
export function Card({
  children,
  onPress,
  accessibilityLabel,
  background,
  borderColor,
  radius = radii.card,
  style,
}: {
  children: ReactNode;
  onPress?: () => void;
  /** Only meaningful with `onPress`. Without it a screen reader reads every
   *  line inside the card and never says the card itself opens something. */
  accessibilityLabel?: string;
  background?: string;
  borderColor?: string;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  // v2: card radius 20
  const box: StyleProp<ViewStyle> = {
    backgroundColor: background ?? c.surface,
    borderColor: borderColor ?? c.line,
    borderWidth: 1,
    borderRadius: radius,
  };
  if (onPress)
    return (
      <Pressable onPress={onPress} accessibilityRole="button"
        accessibilityLabel={accessibilityLabel} style={[box, style]}>
        {children}
      </Pressable>
    );
  return <View style={[box, style]}>{children}</View>;
}

// ---- Buttons ----
//
// Every action in the app is one of these. It used to be that only the primary
// CTA looked like a button and everything else was a coloured word with a 44pt
// box around it -- "Save", "Decline", "Try again" -- which reads as prose and
// behaves as a control. People do not tap prose, and on a phone they cannot
// hover to find out. So: a border, a fill, an icon and a target, always.
//
// Three weights, because the app only makes three kinds of request:
//
//   primary    the one thing this screen is for. Volt, filled, full width.
//   secondary  a real action that is not the point of the screen.
//   danger     refusing, deleting, cancelling, or retrying something that broke.
//
// Anything quieter than `secondary` is not a button, it is a link, and the app
// does not have links.
export type ButtonTone = 'primary' | 'secondary' | 'danger';

export function Button({
  label,
  onPress,
  icon,
  tone = 'secondary',
  enabled = true,
  busy = false,
  busyLabel = 'Processing...',
  full = false,
  height,
  style,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  /** Feather name. Every button carries one: the glyph is what the eye finds
   *  first in a column of otherwise identical pills. */
  icon?: IconName;
  tone?: ButtonTone;
  enabled?: boolean;
  /** Blocks re-entry while a write is in flight (double-tap = double order). */
  busy?: boolean;
  busyLabel?: string;
  /** Primary buttons stretch by default; the others hug their label. */
  full?: boolean;
  height?: number;
  style?: StyleProp<ViewStyle>;
  /** When the visible label is not the whole story -- "Decline" on a card that
   *  does not say aloud what is being declined. */
  accessibilityLabel?: string;
}) {
  const { c, t } = useTheme();
  const live = enabled && !busy;
  const primary = tone === 'primary';
  // 52 for the CTA, 44 everywhere else -- 44 being the smallest target a thumb
  // reliably hits, so nothing here goes under it.
  const box = height ?? (primary ? 52 : 44);
  const stretch = full || primary;

  const fill = !enabled ? c.surface2 : primary ? c.volt : c.surface;
  const edge = primary ? 'transparent' : !enabled ? c.line2 : tone === 'danger' ? c.danger : c.line;
  const fg = !enabled ? c.txt3 : primary ? c.ink : tone === 'danger' ? c.danger : c.accent;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !live, busy }}
      onPress={live ? onPress : undefined}
      style={[{
        height: box,
        minHeight: box,
        borderRadius: radii.button,
        backgroundColor: fill,
        borderWidth: primary ? 0 : 1,
        borderColor: edge,
        paddingHorizontal: primary ? 12 : 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        alignSelf: stretch ? 'stretch' : 'flex-start',
        opacity: busy ? 0.7 : 1,
      }, style]}
    >
      {icon && <Icon name={icon} size={primary ? 18 : 16} color={fg} />}
      {/* Android clips shrink-to-fit Text with custom fonts; stretch instead. */}
      <Text
        numberOfLines={1}
        style={[primary ? t.overlayTitle : t.label, {
          fontSize: primary ? 16 : 14,
          color: fg,
          // flex, not alignSelf: 'stretch'. The container is a row, so stretch
          // sizes the Text vertically as well and the label rides the top edge
          // of a 52pt button. flex gives the same full width -- which is what
          // Android needs, since it clips shrink-to-fit Text in a custom font
          // -- without touching the cross axis.
          ...(stretch && !icon ? { flex: 1, textAlign: 'center' as const } : null),
        }]}
      >
        {busy ? busyLabel : label}
      </Text>
    </Pressable>
  );
}

// The primary CTA, kept under its old name because most of the app calls it
// that. One implementation underneath, so the two cannot drift apart.
export function VoltButton({
  label,
  onPress,
  enabled = true,
  height = 52,
  busy = false,
  busyLabel = 'Processing...',
  icon,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  enabled?: boolean;
  height?: number;
  busy?: boolean;
  busyLabel?: string;
  icon?: IconName;
  accessibilityLabel?: string;
}) {
  return (
    <Button label={label} onPress={onPress} enabled={enabled} height={height}
      busy={busy} busyLabel={busyLabel} icon={icon} tone="primary"
      accessibilityLabel={accessibilityLabel} />
  );
}

// A button with no room for a word: the month steppers, the map controls, a
// close. The glyph carries the meaning, so the accessible name is required
// rather than derived -- there is no label to fall back on.
export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  tone = 'secondary',
  enabled = true,
  size = 44,
  style,
}: {
  icon: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  tone?: ButtonTone;
  enabled?: boolean;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  const fg = !enabled ? c.txt3 : tone === 'danger' ? c.danger : c.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !enabled }}
      onPress={enabled ? onPress : undefined}
      style={[{
        width: size,
        height: size,
        borderRadius: radii.button,
        backgroundColor: c.surface,
        borderWidth: 1,
        borderColor: !enabled ? c.line2 : tone === 'danger' ? c.danger : c.line,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: enabled ? 1 : 0.5,
      }, style]}
    >
      <Icon name={icon} size={18} color={fg} />
    </Pressable>
  );
}

// ---- What a screen says when it has nothing, or nothing worked ----
//
// Seven copies of Note and four of ErrorNote existed before this, one per
// screen, which is why a failure looked different depending on where it
// happened. They are the same two sentences everywhere, so they are one
// component now.
export function Note({ children }: { children: ReactNode }) {
  const { c, t } = useTheme();
  return (
    <Card style={{ padding: 16 }}>
      <Text style={[t.bodySm, { color: c.txt2 }]}>{children}</Text>
    </Card>
  );
}

// A failure is only worth showing if it comes with the way out of it. Every
// caller passes the thing to run again -- there is no variant without one.
export function ErrorNote({ message, onRetry, retryLabel = 'Retry' }: {
  message: string;
  onRetry: () => void;
  /** What is being retried, for a screen reader. The visible word stays "Try
   *  again" so the button reads the same everywhere. */
  retryLabel?: string;
}) {
  const { c, t } = useTheme();
  return (
    <Card style={{ padding: 16 }} background={alpha(c.danger, 0.05)} borderColor={alpha(c.danger, 0.28)}>
      <Text accessibilityRole="alert" style={[t.bodySm, { color: c.danger }]}>{message}</Text>
      <Row style={{ marginTop: 12 }}>
        <Button label="Try again" icon="refresh-cw" tone="danger"
          accessibilityLabel={retryLabel} onPress={onRetry} />
      </Row>
    </Card>
  );
}

// One muted line where a list is going to be: "Loading events…" and then
// "No events scheduled yet." Three screens each had their own copy and none of
// them announced the change, so the transition from loading to empty was
// silent for anyone not looking at it.
export function StatusLine({ children, marginTop = 4 }: { children: ReactNode; marginTop?: number }) {
  const { c, t } = useTheme();
  return (
    <Text accessibilityRole="text" accessibilityLiveRegion="polite"
      style={[t.bodySm, { color: c.txt3, marginTop }]}>
      {children}
    </Text>
  );
}

// ---- Confirming something that cannot be taken back ----
//
// Deleting a certificate, dropping a week of working hours, accepting a refund
// figure. The rule is that the sentence names the specific thing -- "Remove
// 9:00 AM - 5:00 PM from Monday to Friday?" and not "Are you sure?" -- because
// the second one is what people tap through without reading.
export function ConfirmSheet({
  visible,
  title,
  body,
  confirmLabel,
  confirmIcon = 'trash-2',
  cancelLabel = 'Keep it',
  busy = false,
  busyLabel = 'Working…',
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  confirmIcon?: IconName;
  cancelLabel?: string;
  busy?: boolean;
  busyLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { c, t } = useTheme();
  return (
    <FormSheet visible={visible} title={title} onClose={onCancel}
      footer={(
        <Row gap={10}>
          {/* Keeping is the safe option, so it is the one under the thumb
              first and the one that is not tinted red. */}
          <Button label={cancelLabel} icon="x" style={{ flex: 1 }} onPress={onCancel} />
          <Button label={confirmLabel} icon={confirmIcon} tone="danger" style={{ flex: 1 }}
            busy={busy} busyLabel={busyLabel} enabled={!busy}
            onPress={onConfirm} />
        </Row>
      )}>
      <Text style={[t.bodySm, { color: c.txt2 }]}>{body}</Text>
    </FormSheet>
  );
}

// ---- Micro badge ----
export function MicroBadge({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  const { t } = useTheme();
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 }}>
      <Text style={[t.microBadge, { color: fg, textTransform: 'uppercase' }]}>{label}</Text>
    </View>
  );
}

// ---- Section heading ----
export function SectionHeading({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const { c, t } = useTheme();
  return (
    <Text style={[t.sectionHeading, { color: c.txt3, textTransform: 'uppercase' }, style]}>{children}</Text>
  );
}

// ---- Avatar tile ----
// Default is the v2 list tile (58). Store hero = 64, venue = 66 — see
// `avatarSize` in ../theme.
export function Avatar({
  initials,
  avatarUrl,
  size = avatarSize.list,
  radius = radii.avatar,
  fontSize = 18,
  fg,
  bg,
}: {
  initials: string;
  avatarUrl?: string | null;
  size?: number;
  radius?: number;
  fontSize?: number;
  bg?: string;
  /** Override only when the tile's background is not one of the theme's. */
  fg?: string;
}) {
  const { c, t } = useTheme();
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  // Not a literal: this used to be the dark palette's text colour frozen in
  // place, so initials on a light tile were invisible.
  const ink = fg ?? c.txt;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: bg ?? c.avatarBg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {avatarUrl && avatarUrl !== failedUrl
        ? <Image source={{ uri: avatarUrl }} onError={() => setFailedUrl(avatarUrl)}
            accessible={false} style={{ width: size, height: size, borderRadius: radius }} resizeMode="cover" />
        : <Text style={[t.initials, { fontSize, color: ink }]}>{initials}</Text>}
    </View>
  );
}

// ---- Toggle (46x26 track, 20 knob) ----
export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      style={{
        width: 46,
        height: 26,
        borderRadius: 999,
        // was hardcoded dark-theme values; broke in light theme
        backgroundColor: value ? c.volt : c.mono,
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: c.nav,
          marginLeft: value ? 23 : 3,
        }}
      />
    </Pressable>
  );
}

// ---- Segmented control ----
export interface SegOption {
  key: string;
  label: string;
}
export function Segmented({
  options,
  selected,
  onSelect,
  fontSize = 14,
  pad = 12,
  radius = radii.input,
}: {
  options: SegOption[];
  selected: string;
  onSelect: (k: string) => void;
  fontSize?: number;
  pad?: number;
  /** Container radius. Pass `radii.pill` for the Discover coaches|Partners form. */
  radius?: number;
}) {
  const { c, t } = useTheme();
  const inner = radius >= radii.pill ? radii.pill : Math.max(radius - 4, 0);
  return (
    <View style={{ flexDirection: 'row', backgroundColor: c.surface, borderColor: c.line, borderWidth: 1, borderRadius: radius, padding: 4 }}>
      {options.map((o) => {
        const active = o.key === selected;
        return (
          <Pressable
            key={o.key}
            onPress={() => onSelect(o.key)}
            // A segment is one of a set, so it reports which one is taken
            // rather than leaving the fill to say it.
            accessibilityRole="tab"
            accessibilityLabel={o.label}
            accessibilityState={{ selected: active }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingVertical: pad, borderRadius: inner, backgroundColor: active ? c.volt : 'transparent' }}
          >
            <Text numberOfLines={1} style={[t.label, { fontSize, color: active ? c.ink : c.txt2, alignSelf: 'stretch', textAlign: 'center' }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}


// ---- Form sheet ----
//
// A short form on its own layer, rising from the bottom the way a sheet on a
// phone does. For work that is a detour from the screen behind it: filling in a
// certificate, confirming something that cannot be undone.
//
// It hugs its content up to 88% of the screen and scrolls past that, so a
// three-field form is a small sheet and a long one is still reachable.
//
// The backdrop dismisses. That is what every sheet does, and a form whose only
// exit is a button people cannot find is worse than one they leave by accident
// -- nothing here is written until the action in `footer` is pressed.
export function FormSheet({
  visible,
  title,
  subtitle,
  onClose,
  footer,
  children,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { c, t } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Close ${title}`}
        onPress={onClose} style={{ flex: 1, backgroundColor: c.scrim }} />
      <View
        accessibilityViewIsModal
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '88%',
          backgroundColor: c.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24,
          borderTopWidth: 1, borderColor: c.line, overflow: 'hidden',
        }}
      >
        <View style={{ padding: 18, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: c.line2 }}>
          <Row style={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={[t.overlayTitle, { fontSize: 20, color: c.txt, flex: 1 }]}>{title}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close"
              onPress={onClose}
              style={{ minHeight: 44, minWidth: 44, alignItems: 'flex-end', justifyContent: 'center' }}>
              <Icon name="x" size={20} color={c.txt3} />
            </Pressable>
          </Row>
          {subtitle ? (
            <Text style={[t.bodySm, { color: c.txt2, marginTop: 6 }]}>{subtitle}</Text>
          ) : null}
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 18, gap: 14 }}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>

        {footer ? (
          <View style={{ padding: 16, paddingBottom: insets.bottom + 16,
            backgroundColor: c.bg, borderTopWidth: 1, borderTopColor: c.line }}>
            {footer}
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

// ---- Choice chip (pill) ----
export function Chip({ label, active, onPress, fill, accessibilityLabel }: {
  label: string;
  active: boolean;
  onPress: () => void;
  fill?: boolean;
  /** When the visible word is not the whole question. A filter row reading
   *  "All 7" says nothing about what seven of. */
  accessibilityLabel?: string;
}) {
  const { c, t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      // A chip is a choice, not a command, so it reports selection rather than
      // leaving a screen reader to infer it from the fill.
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: active }}
      style={{
        flex: fill ? 1 : undefined,
        alignItems: fill ? 'center' : undefined,
        justifyContent: 'center',
        borderRadius: 999,
        backgroundColor: active ? c.volt : c.surface,
        borderColor: active ? c.volt : c.line,
        borderWidth: 1,
        paddingHorizontal: 14,
        // The floor every other control in the app clears. Chips are used as
        // time slots and sort options, which are the two places a mis-tap costs
        // the most.
        minHeight: 44,
        paddingVertical: 9,
      }}
    >
      <Text numberOfLines={1} style={[t.labelSm, { color: active ? c.ink : c.txt2, textAlign: fill ? 'center' : 'auto', alignSelf: fill ? 'stretch' : 'auto' }]}>{label}</Text>
    </Pressable>
  );
}

// ---- Text field ----
export function Field({
  value,
  onChange,
  placeholder,
  keyboardType = 'default',
  width,
  textColor,
  align = 'left',
  secure = false,
  icon,
  radius = radii.input,
  label,
}: {
  value: string;
  onChange: (t: string) => void;
  placeholder: string;
  keyboardType?: 'default' | 'decimal-pad' | 'email-address' | 'phone-pad';
  width?: number;
  textColor?: string;
  align?: 'left' | 'center';
  secure?: boolean;
  icon?: IconName;
  radius?: number;
  label?: string; // accessible name; falls back to the placeholder
}) {
  const { c, t } = useTheme();
  const [focused, setFocused] = React.useState(false);
  // Board annotation: the leading icon switches to volt (#C6F24E) while typing.
  const iconColor = focused || value.length > 0 ? c.accent : c.txt3;
  return (
    <View style={{ width, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.surface, borderColor: c.line, borderWidth: 1, borderRadius: radius, paddingHorizontal: 14, paddingVertical: 12 }}>
      {icon ? <Icon name={icon} size={17} color={iconColor} /> : null}
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.txt3}
        keyboardType={keyboardType}
        secureTextEntry={secure}
        accessibilityLabel={label ?? placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoCapitalize={secure || keyboardType === 'email-address' ? 'none' : 'sentences'}
        style={[t.body, { flex: 1, color: textColor ?? c.txt, textAlign: align, padding: 0 }]}
      />
    </View>
  );
}

// ---- Striped placeholder (image stand-in) ----
export function StripedPlaceholder({ caption, height, radius = 14 }: { caption: string; height?: number; radius?: number }) {
  const { c } = useTheme();
  return (
    <View
      style={{
        height,
        aspectRatio: height ? undefined : 16 / 10,
        borderRadius: radius,
        // `--ph` token — was surface2 + a hardcoded alpha caption
        backgroundColor: c.ph,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <View style={{ borderRadius: 6, borderWidth: 1, borderColor: c.line, paddingHorizontal: 8, paddingVertical: 3 }}>
        <Text style={{ fontFamily: 'monospace', fontSize: 10, color: c.txt3 }}>{caption}</Text>
      </View>
    </View>
  );
}

// ---- Star row ----
export function Stars({ value, size = 14 }: { value: number; size?: number }) {
  const { c } = useTheme();
  return <Text style={{ fontSize: size, color: c.amber }}>{'★'.repeat(Math.round(value))}</Text>;
}

export function Row({ children, style, gap }: { children: ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center' }, gap ? { gap } : null, style]}>{children}</View>;
}

// ---- Photo scrim ----
// A dark fade over a photo, so white text at the bottom of a card reads on any
// picture. Transparent down to `from` (0-1 of the height), then `opacity` at
// the bottom. Always the dark ink, in both themes: the text on it is white.
export function PhotoScrim({ from, opacity }: { from: number; opacity: number }) {
  // Gradient ids are document-wide on the web, so each scrim needs its own.
  const id = `scrim${React.useId().replace(/[^A-Za-z0-9]/g, '')}`;
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <Stop offset={from} stopColor="#0D0E11" stopOpacity={0} />
          <Stop offset={1} stopColor="#0D0E11" stopOpacity={opacity} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}

// ---- Reduce motion ----
// Starts true: until the setting is known, nothing moves.
export function useReduceMotion() {
  const [reduce, setReduce] = React.useState(true);
  React.useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => { if (active) setReduce(on); })
      .catch(() => { if (active) setReduce(false); });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => { active = false; sub.remove(); };
  }, []);
  return reduce;
}

// ---- Page dots ----
// The current card is a volt pill, the others small grey dots. Decorative: the
// cards themselves are what a screen reader walks through.
const DOT_EASE = Easing.bezier(0.23, 1, 0.32, 1);

function PageDot({ active, reduceMotion }: { active: boolean; reduceMotion: boolean }) {
  const { c } = useTheme();
  const on = React.useRef(new Animated.Value(active ? 1 : 0)).current;
  React.useEffect(() => {
    Animated.timing(on, {
      toValue: active ? 1 : 0,
      duration: reduceMotion ? 0 : 200,
      easing: DOT_EASE,
      // Width is a layout property, which the native driver cannot animate.
      useNativeDriver: false,
    }).start();
  }, [active, on, reduceMotion]);
  return (
    <Animated.View style={{
      height: 6,
      borderRadius: 3,
      width: on.interpolate({ inputRange: [0, 1], outputRange: [6, 18] }),
      backgroundColor: on.interpolate({ inputRange: [0, 1], outputRange: ['rgba(155,161,172,0.4)', c.volt] }),
    }} />
  );
}

export function PageDots({ count, index }: { count: number; index: number }) {
  const reduceMotion = useReduceMotion();
  if (count < 2) return null;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 10 }}>
      {Array.from({ length: count }, (_, k) => <PageDot key={k} active={k === index} reduceMotion={reduceMotion} />)}
    </View>
  );
}

// ---- Snap carousel ----
// A row of cards that bleeds to the screen edges and snaps each card to the
// start. With more than one card, each is narrower than the row by `peek` so
// the next one shows and says there is more. Page dots follow when there is
// more than one.
//
// `bleed` is the screen gutter the row escapes; `glow` is extra room above and
// below for a card shadow the scroll view would otherwise clip.
export function SnapCarousel<T>({
  items,
  keyOf,
  renderItem,
  gap = 10,
  peek = 28,
  bleed = 18,
  glow = 0,
}: {
  items: T[];
  keyOf: (item: T) => string;
  renderItem: (item: T, width: number) => ReactNode;
  gap?: number;
  peek?: number;
  bleed?: number;
  glow?: number;
}) {
  const [rowWidth, setRowWidth] = React.useState(0);
  const [index, setIndex] = React.useState(0);
  const cardWidth = items.length > 1 ? rowWidth - peek : rowWidth;
  const step = cardWidth + gap;
  // A filter that shrinks the list must not leave the dots on a card that is
  // no longer there.
  const shown = Math.min(index, Math.max(items.length - 1, 0));
  return (
    <View onLayout={(e) => setRowWidth(e.nativeEvent.layout.width)}>
      {rowWidth > 0 && <>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={step}
          snapToAlignment="start"
          decelerationRate="fast"
          disableIntervalMomentum
          scrollEventThrottle={16}
          onScroll={(e) => {
            const next = Math.round(e.nativeEvent.contentOffset.x / step);
            if (next !== index) setIndex(next);
          }}
          style={{ marginHorizontal: -bleed, marginVertical: -glow }}
          contentContainerStyle={{ paddingHorizontal: bleed, paddingVertical: glow, gap }}
        >
          {items.map((item) => <View key={keyOf(item)} style={{ width: cardWidth }}>{renderItem(item, cardWidth)}</View>)}
        </ScrollView>
        <PageDots count={items.length} index={shown} />
      </>}
    </View>
  );
}

export { ScrollView };
