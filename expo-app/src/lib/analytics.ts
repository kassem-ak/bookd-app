import Constants from 'expo-constants';
import { uuid } from 'expo-modules-core';

export type AnalyticsEvent =
  | 'app_open'
  | 'onboarding_step_viewed'
  | 'onboarding_role_chosen'
  | 'sso_attempted'
  | 'sso_unavailable'
  | 'email_sign_in'
  | 'email_sign_up'
  | 'discover_searched'
  | 'discover_filter_changed'
  | 'discover_sort_changed'
  | 'ad_opened'
  | 'ad_viewed'
  | 'ad_why_opened'
  | 'profile_opened'
  | 'maps_filter_used'
  | 'community_joined'
  | 'community_left'
  | 'community_created'
  | 'event_created'
  | 'event_suggested'
  | 'sport_requested'
  | 'conversation_opened'
  | 'message_sent'
  | 'conversation_started_from_profile'
  | 'booking_opened'
  | 'package_selected'
  | 'booking_confirmed'
  | 'booking_failed'
  | 'reported'
  | 'blocked'
  | 'unblocked'
  | 'followed'
  | 'unfollowed'
  | 'became_coach'
  | 'stopped_coaching'
  | 'registration_completed'
  | 'package_booking_opened'
  | 'package_cancellation_requested'
  | 'package_cancelled_unused'
  | 'session_rated'
  | 'package_cancellation_decided'
  | 'package_refund_offered'
  | 'coach_basics_saved'
  | 'coach_day_off_added'
  | 'coach_hours_saved'
  | 'coach_rate_set'
  | 'coach_package_added'
  | 'coach_promo_added'
  | 'partner_session_proposed'
  | 'partner_session_answered'
  | 'certificate_added'
  | 'account_deleted'
  | 'render_crash'
  | 'write_failed';

type Props = Record<string, string | number | boolean | null>;

export interface AnalyticsRecord {
  event: AnalyticsEvent;
  props: Props;
  sequence: number;
  timestamp: string;
  sessionId: string;
  userId: string | null;
  appVersion?: string;
}

export interface AnalyticsSink {
  send(batch: AnalyticsRecord[]): Promise<void>;
}

export const ANALYTICS_BUFFER_CAP = 300;
// A fresh anonymous UUID for this launch of this installation. Never persisted,
// derived from an account/device ID, or replaced when identify() is called.
const sessionId = uuid.v4();
const appVersion = Constants.expoConfig?.version;
let userId: string | null = null;
let sequence = 0;
let buffer: AnalyticsRecord[] = [];
let sink: AnalyticsSink | null = null;
let revision = 0;
let sending = false;
let paused = false;
let scheduled: ReturnType<typeof setTimeout> | null = null;

// Key blocking alone is insufficient: free text could hide under "value" or
// "status". Deny unknown keys AND restrict strings to closed vocabularies so
// contact details, user content and precise locations cannot enter the queue.
const PII_KEY = /email|phone|name|message|body|text|query|lat|lng|lon|address|title|content|bio|search|location|coordinate|recipient|password|token/i;
const ENUMS: Record<string, readonly string[]> = {
  step: ['start', 'role', 'where', 'account'],
  role: ['coach', 'trainee', 'partner', 'USER', 'COACH', 'ADMIN'],
  provider: ['google', 'facebook', 'azure', 'apple'],
  filter: ['sport', 'mode'],
  mode: ['coaches', 'partners'],
  sort: ['rating', 'price', 'distance'],
  placement: ['discover', 'community'],
  kind: ['Meetup', 'Event', 'Sport', 'Hobby'],
  booking_type: ['purchase', 'redemption'],
  error_type: ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError'],
};
const BOOLEANS = new Set(['has_input', 'active', 'confirmation_required']);
const NUMBERS = new Set(['selected_index', 'package_index', 'sessions', 'amount_cents']);
// Row ids of things the platform itself publishes (a sponsored card), never of
// a person: a uuid says which advert, and nothing about who looked at it.
const IDS = new Set(['ad_id']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_CODES = new Set([
  'UNKNOWN_ERROR', 'COACH_UNAVAILABLE', 'invalid_credentials', 'email_not_confirmed',
  'user_already_exists', 'signup_disabled', 'over_request_rate_limit',
  'over_email_send_rate_limit', 'weak_password', 'session_not_found',
]);
const isErrorCode = (value: unknown): value is string => typeof value === 'string'
  && (ERROR_CODES.has(value) || /^(?:[0-9]{2}|P0|XX|HV|F0)[A-Z0-9]{3}$/.test(value) || /^PGRST\d{3}$/.test(value));

// Never inspect message/details/stack: server errors may echo user input.
export function analyticsErrorCode(error: unknown): string {
  try {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
    return isErrorCode(code) ? code : 'UNKNOWN_ERROR';
  } catch {
    return 'UNKNOWN_ERROR';
  }
}

function sanitize(props: Props): Props {
  const safe: Props = {};
  // Iterate our small allowlist, not an arbitrarily large caller object.
  for (const key of [...Object.keys(ENUMS), ...BOOLEANS, ...NUMBERS, ...IDS, 'error_code']) {
    if (PII_KEY.test(key) || !Object.prototype.hasOwnProperty.call(props, key)) continue;
    const value = props[key];
    if (value === null
      || (ENUMS[key]?.includes(value as string))
      || (BOOLEANS.has(key) && typeof value === 'boolean')
      || (NUMBERS.has(key) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      || (IDS.has(key) && typeof value === 'string' && UUID.test(value))
      || (key === 'error_code' && isErrorCode(value))) safe[key] = value;
  }
  return safe;
}

function scheduleFlush() {
  if (!sink || paused || sending || scheduled !== null || !buffer.length) return;
  // Keep provider code off the caller's stack, even for a synchronous throw.
  scheduled = setTimeout(() => { scheduled = null; void flush(); }, 0);
}

async function flush() {
  if (!sink || paused || sending || !buffer.length) return;
  const target = sink;
  const version = revision;
  const batch = buffer.slice();
  const last = batch[batch.length - 1].sequence;
  sending = true;
  try {
    await target.send(batch);
    buffer = buffer.filter((record) => record.sequence > last);
  } catch {
    // Keep pending events (subject to the cap). Explicit setSink() is required
    // to retry this provider; new events cannot create a failure/retry loop.
    if (revision === version) paused = true;
  } finally {
    sending = false;
    scheduleFlush();
  }
}

export function track(event: AnalyticsEvent, props: Props = {}): void {
  try {
    buffer.push(Object.freeze({
      event, props: Object.freeze(sanitize(props)), sequence: ++sequence,
      timestamp: new Date().toISOString(), sessionId, userId,
      ...(appVersion ? { appVersion } : {}),
    }));
    if (buffer.length > ANALYTICS_BUFFER_CAP) buffer.shift();
    // At most 300 pending records plus one in-flight batch of at most 300.
    scheduleFlush();
  } catch {
    // Analytics must never interrupt a user action, even for malformed props.
  }
}

export function identify(id: string | null): void {
  // public.users uses UUIDs. Reject accidental emails or other identifiers.
  userId = typeof id === 'string' && UUID.test(id) ? id : null;
}

// There is deliberately no default sink, storage, transport or SDK. Detaching
// stops future sends; a provider call already in flight cannot be recalled.
export function setSink(next: AnalyticsSink | null): void {
  sink = next;
  revision++;
  paused = false;
  scheduleFlush();
}
