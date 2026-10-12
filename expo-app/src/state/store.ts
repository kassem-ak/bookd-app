import { create } from 'zustand';
import { analyticsErrorCode, track } from '../lib/analytics';
import {
  approveSuggestion as approveSuggestionRemote,
  fetchAccountStanding,
  checkoutShopOrder as checkoutShopOrderRemote,
  createBooking as createBookingRemote,
  createCommunity as createCommunityRemote,
  createEvent as createEventRemote,
  EventKind,
  leaveCommunity as leaveCommunityRemote,
  setEventAttendance,
  submitShopRegistration as submitShopRegistrationRemote,
  suggestEvent as suggestEventRemote,
} from '../lib/queries';
import { requestMembership as requestMembershipRemote } from '../lib/communities';
import { CommunityDraft, EMPTY_COMMUNITY_DRAFT } from '../components/CommunityFields';
import { requestSport as requestSportRemote } from '../lib/gwin';
import {
  Cert,
  CoachPkg,
  Community,
  CommunityRole,
  EventItem,
  EventSuggestion,
  Person,
  Role,
  Shop,
  CalProvider,
  coachPackageOptions,
} from './models';
import {
  MyCourtReservation,
  Venue,
  enterVenueEvent,
  equipmentRateCents,
  fetchMyCourtReservations,
  fetchVenues,
  reserveCourt,
} from '../lib/courts';
import { blockUser, fetchBlockedUsers, unblockUser } from '../lib/moderation';
import { fetchFollowedIds, followPerson, unfollowPerson } from '../lib/social';
import { RsvpRef, rsvpSubject } from './courtsData';
import * as D from './sampleData';

const EXPLICIT = ['sex', 'sexual', 'sexy', 'nude', 'naked', 'nsfw', 'xxx', 'porn', 'escort', 'erotic', 'onlyfans', 'hookup', 'fetish'];
export const isExplicit = (t: string) => {
  const l = t.toLowerCase();
  return EXPLICIT.some((w) => l.includes(w));
};

// weekly schedule time options (5:00 AM .. 10:30 PM)
export const SCHED_TIMES: string[] = (() => {
  const out: string[] = [];
  for (let h = 5; h <= 22; h++)
    for (const m of ['00', '30']) {
      const h12 = h % 12 === 0 ? 12 : h % 12;
      out.push(`${h12}:${m} ${h < 12 ? 'AM' : 'PM'}`);
    }
  return out;
})();
const byTime = (slots: string[]) => [...slots].sort((a, b) => SCHED_TIMES.indexOf(a) - SCHED_TIMES.indexOf(b));

const randCode = () =>
  Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 30)]).join('');

// The day picker offers the next six real days. It used to be six frozen dates
// copied off the design board, so every event a user created was stamped with a
// day that had nothing to do with when it actually happened.
export type EventDayOption = { label: string; date: Date };
export const eventDayOptions = (from: Date = new Date()): EventDayOption[] =>
  Array.from({ length: 6 }, (_, i) => {
    const date = new Date(from);
    date.setDate(from.getDate() + i + 1);
    date.setHours(0, 0, 0, 0);
    const dow = date.toLocaleDateString(undefined, { weekday: 'short' });
    const mon = date.toLocaleDateString(undefined, { month: 'short' });
    return { label: `${dow} ${date.getDate()} ${mon}`, date };
  });

const canModerateRole = (role: CommunityRole) => role === 'ADMIN' || role === 'MODERATOR';
const eventWhenLabel = (day: number, timeIdx: number) => {
  const options = eventDayOptions();
  const option = options[day] ?? options[0];
  const time = D.slotDefs[timeIdx] ?? D.slotDefs[0];
  return `${option.label.toUpperCase()} · ${time}`;
};
const communitySlug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || `community-${Date.now()}`;
const communityCode = (name: string) => {
  const letters = name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .join('')
    .toUpperCase();
  return (letters || name.slice(0, 2).toUpperCase()).slice(0, 2);
};


// PostgREST rejects with a plain `{ message, details, hint, code }` object
// rather than an Error, so `String(error)` rendered "[object Object]" in the
// banner. Pull the message out of whatever shape actually arrives.
export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    // Postgres constraint violations are accurate but unreadable — the raw
    // "duplicate key value violates unique constraint" text reached the banner.
    // Not "that slot is already booked". 23505 is ANY unique violation, and
    // this mapper is global -- creating a community with a duplicate row
    // reported a booking clash, which sends the reader looking for a calendar
    // that has nothing to do with it. A generic duplicate needs generic words;
    // the booking flow, which is where the specific wording belongs, says it
    // for itself.
    if (e.code === '23505') return 'That already exists.';
    if (e.code === '23503') return 'That item is no longer available.';
    if (e.code === '42501') return 'You do not have permission to do that.';
    const text = [e.message, e.error_description, e.details, e.hint].find(
      (part): part is string => typeof part === 'string' && part.trim().length > 0,
    );
    if (text) return text;
    if (typeof e.code === 'string') return `Request failed (${e.code}).`;
  }
  return 'Something went wrong. Please try again.';
};

const errorState = (error: unknown) => {
  track('write_failed', { error_code: analyticsErrorCode(error) });
  return { writeBusy: null, writeError: errorMessage(error) };
};

const roleFromDb = (role: string | null | undefined): CommunityRole =>
  role === 'owner' || role === 'admin' ? 'ADMIN' : role === 'moderator' ? 'MODERATOR' : 'MEMBER';

const memberLabel = (count?: number | null) => {
  const n = count ?? 0;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
};

const communityFromRemote = (row: any): Community => ({
  id: row.slug ?? row.id,
  sport: row.name,
  code: row.code ?? String(row.name ?? 'CM').slice(0, 2).toUpperCase(),
  tint: row.tint ?? '#2F3A2A',
  members: memberLabel(row.members_count),
  about: row.about ?? '',
  official: Boolean(row.official),
});

const eventFromRemote = (row: any, fallbackCommunity?: string): EventItem => ({
  id: row.id,
  communityId: row.community_slug ?? row.community_id ?? fallbackCommunity ?? '',
  subId: row.subgroup_id ?? null,
  type: row.type === 'event' ? 'Event' : 'Meetup',
  title: row.title,
  whenLabel: row.when_label ?? 'Upcoming',
  loc: row.location ?? 'TBD',
  attendees: row.attendees_count ?? 0,
  // Unknown stays blank: stamping the reader's own name on someone else's event
  // is how the prototype invented hosts.
  host: row.host_name ?? '',
});

const suggestionFromRemote = (row: any, fallbackCommunity?: string): EventSuggestion => ({
  id: row.id,
  communityId: row.community_slug ?? row.community_id ?? fallbackCommunity ?? '',
  type: row.type === 'event' ? 'Event' : 'Meetup',
  title: row.title,
  whenLabel: row.when_label ?? 'Upcoming',
  loc: row.location ?? 'TBD',
  requestedBy: row.requested_by ?? '',
  status: row.status === 'approved' ? 'APPROVED' : 'PENDING',
});

// `date` is a local calendar day as yyyy-mm-dd, `slot` a label out of
// coach_availability ("8:00 AM"). Both are what the picker actually offered,
// so the instant sent to the server is the one the user saw.
/** A local yyyy-mm-dd plus a slot label becomes the instant the person picked.
 *
 *  Exported because three screens book a session and each had, or was about to
 *  have, its own copy of this conversion. Three copies of a date calculation is
 *  three chances to disagree about what "6:30 PM on the 4th" means. */
export const scheduledFor = (date: string, slot: string) => {
  const match = slot.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  let hour = match ? Number(match[1]) : 12;
  const minute = match ? Number(match[2]) : 0;
  const meridiem = match?.[3]?.toUpperCase();
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
};

/** "12 October" for a yyyy-mm-dd day, for booking labels and confirmations. */
export const bookingDayLabel = (date: string) => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
};

export interface SpotterState {
  // top level
  tab: string;
  /**
   * Module keys the server has released to this account. Empty until the
   * lookup returns, and empty is "show nothing" -- never "show everything".
   */
  modules: string[];
  role: Role;
  /** Whether this account has a coach profile.
   *
   *  Separate from `role` on purpose: an admin who also coaches is 'ADMIN',
   *  and coaching UI must not disappear because somebody was made a moderator.
   */
  isCoach: boolean;
  /** What the user said they were at signup. Intent only, never a grant. */
  signupIntent: 'coach' | 'trainee' | null;
  signupSports: string[];
  isDark: boolean;
  overlay: string | null;
  // handoff v2 adds a second presentation layer: bottom sheets, distinct from
  // full-screen overlays. Ids: story | hours | pkg | myComm | admin | rsvp
  sheet: string | null;
  writeBusy: string | null;
  writeError: string | null;
  authEmail: string | null; // signed-in real account email (null = guest)
  authName: string | null;
  authUid: string | null;
  authAvatarUrl: string | null;
  profileRevision: number;
  /** public.users.id of the signed-in account, resolved by refreshRole(). Null
   *  until the server answers; never substitute a placeholder, because this is
   *  compared against row ownership. */
  authUserId: string | null;

  // --- onboarding (handoff v2) ---
  authLoc: string;
  authSeek: string;
  discSearch: string;
  searchRadius: number;

  // --- venues, courts and tournaments (server-backed) ---
  venues: Venue[];
  venuesLoading: boolean;
  venuesError: string | null;

  // --- court RSVP (handoff v2 section C) ---
  rsvpTarget: string | null;      // display title, for copy only
  rsvpRef: RsvpRef | null;
  rsvpPriceCents: number;         // per-hour for courts, flat entry fee for tournaments
  rsvpPerHour: boolean;
  /** Chosen start, ISO. Null until the user picks one — never defaulted, because
   *  reserve_court charges for exactly this instant. */
  rsvpStartsAt: string | null;
  /** The signed-in user's reservations, as stored by the server. */
  courtReservations: MyCourtReservation[];
  rsvpType: string;
  rsvpHours: number;
  rsvpGear: boolean;
  rsvpCoach: boolean;

  // --- shared registration form: community | venue | shop ---
  regKind: string;
  regChannel: string | null;
  regTime: string;
  // Registrations awaiting admin review. Shop rows persist through
  // submitShopRegistration; community/venue have no server table yet, so they
  // are held here and surfaced in the admin queue.
  pendingRegistrations: { id: string; kind: string; name: string; meta: string; decision?: string }[];

  // discover / shop
  mode: string;
  sport: string;
  sortBy: string;
  discoverView: string;
  shopView: string;
  sportMenu: boolean;
  remotePeople: Person[];
  remoteShops: Shop[];
  /** Whether a fetch has completed for each remote collection. Empty results no
   *  longer fall back to sample rows, so screens need this to tell "not fetched
   *  yet" from "the server genuinely has none". Set by the setRemote* setters,
   *  which every fetch already calls on both success and failure. */
  loaded: {
    people: boolean;
    shops: boolean;
    communities: boolean;
    events: boolean;
    suggestions: boolean;
  };

  // selected ids
  openId: string;
  shopId: string;
  chatId: string;
  communityId: string;
  eventId: string;
  returnTo: string | null;

  // cart
  cart: Record<string, number>;

  // booking
  /** The chosen day as local yyyy-mm-dd, and the chosen slot exactly as
   *  coach_availability stores it. Null until the picker offers one: there is
   *  no sensible default, because what is bookable depends on the coach. */
  bookDate: string | null;
  bookSlot: string | null;
  bookPkg: number;
  booked: boolean;

  // prefs
  notifSeen: boolean;
  pushOn: boolean;
  dailyPlanOn: boolean;
  calSyncOn: boolean;
  calProvider: CalProvider;

  // ads

  // shop registration
  shopRegName: string;
  shopRegCat: string | null;
  shopRegCatOther: string;
  shopRegCatMenu: boolean;
  shopRegPhone: string;
  shopRegEmail: string;
  shopRegMeans: string | null;
  shopRegTime: string;
  shopRegDone: boolean;
  shopRegDoneName: string;
  shopRegDoneCat: string | null;
  shopRegDoneMeta: string;
  shopOrderDone: boolean;

  // communities
  joinedCommunities: string[];
  /** Closed communities I have asked to join and not been answered about.
   *  Separate from joinedCommunities because asking is not being in. */
  pendingCommunities: string[];
  joinedSubs: string[];
  goingEvents: string[];
  customCommunities: Community[];
  remoteCommunities: Community[];
  communityRoles: Record<string, CommunityRole>;
  communityMemberRoles: Record<string, Record<string, CommunityRole>>;
  communityAboutEdits: Record<string, string>;
  eventSuggestions: EventSuggestion[];
  setRemoteEventSuggestions(suggestions: EventSuggestion[]): void;

  // community + event creation
  customEvents: EventItem[];
  remoteEvents: EventItem[];
  newType: string;
  newSport: string;
  newSub: string | null;
  newDay: number;
  newTime: number;
  newTitle: string;
  newLoc: string;
  evtCreated: boolean;
  eventSuggested: boolean;
  commName: string;
  /** Everything else the create form now collects. Held here beside
   *  `commName` so the overlay stays stateless like its neighbours. */
  commDraft: CommunityDraft;
  commCreated: boolean;
  editCommunityAbout: string;
  reqName: string;
  reqType: string;
  /** Where it was filed, as the server placed it -- shown on the receipt. */
  reqPlaced: string | null;
  reqSent: boolean;

  // coach
  myCerts: Cert[];
  apptDecisions: Record<string, string>;
  coachRate: number;
  schedDay: string;
  addTimeIdx: number;
  schedule: Record<string, string[]>;
  myPackages: CoachPkg[];
  newPkgSessions: number;
  newPkgPrice: number;
  cPromoPct: number;
  cPromoCode: string | null;

  // admin
  hobbyDecisions: Record<string, string>;
  caseId: string;
  safetyCaseId: string;
  promoPct: number;
  promoAud: string;
  promoCode: string | null;
  loyaltyPts: Record<string, number>;

  // ---- generic setter ----
  set<K extends keyof SpotterState>(key: K, value: SpotterState[K]): void;

  // ---- actions ----
  toggleCommunity(id: string): Promise<void>;
  toggleSub(id: string): void;
  toggleGoing(id: string): Promise<void>;
  people(mode?: string): Person[];
  setRemotePeople(people: Person[]): void;
  personById(id: string): Person | undefined;
  shops(): Shop[];
  setRemoteShops(shops: Shop[]): void;
  shopById(id: string): Shop | undefined;
  submitShopRegistration(): Promise<void>;
  checkoutCart(): Promise<void>;
  communities(): Community[];
  setRemoteCommunities(communities: Community[]): void;
  setRemoteCommunityMemberships(memberships: { communityId: string; role: string }[]): void;
  /** Drop a community the server no longer has. */
  forgetCommunity(id: string): void;
  /** Drop an event the server no longer has. */
  forgetEvent(id: string): void;
  setRemoteEvents(events: EventItem[]): void;
  communityById(id: string): Community | undefined;
  communityAbout(id: string): string;
  currentCommunityRole(id?: string): CommunityRole;
  canAdminCommunity(id?: string): boolean;
  canModerateCommunity(id?: string): boolean;
  setCommunityMemberRole(communityId: string, memberId: string, role: CommunityRole): void;
  openEditCommunity(): void;
  openStartCommunity(): void;
  openRequest(): void;
  openCreateEvent(): void;
  openSuggestEvent(): void;
  submitEvent(): Promise<void>;
  submitEventSuggestion(): Promise<void>;
  approveEventSuggestion(id: string): Promise<void>;
  submitCommunity(): Promise<void>;
  submitRequest(): Promise<void>;
  allEvents(): EventItem[];

  toggleCartItem(key: string, price: number): void;
  cartCount(): number;
  cartTotal(): number;

  openPerson(id: string): void;
  openBooking(): void;
  /** Book the rest of a package straight from My bookings. */
  openPackBooking(coachId: string): void;
  backToPerson(): void;
  confirmBooking(): Promise<void>;
  goToBookings(): void;
  openBookings(): void;
  openShop(id: string): void;
  openChat(id: string): void;
  openCommunity(id: string): void;
  openEvent(id: string, from: string | null): void;
  openNotifs(): void;
  closeOverlay(): void;
  openSheet(id: string): void;
  closeSheet(): void;
  openRsvp(ref: RsvpRef): boolean;
  refreshRole(): Promise<void>;
  /** Members this account has blocked. The server enforces the block; this
   *  copy is only what stops the lists from showing them. */
  blockedIds: string[];
  refreshBlocked(): Promise<void>;
  toggleBlock(userId: string): Promise<void>;
  /** People this account follows. Drives the Follow button and the feed. */
  followedIds: string[];
  refreshCircle(): Promise<void>;
  toggleFollow(userId: string): Promise<void>;
  loadVenues(): Promise<void>;
  refreshCourtReservations(): Promise<void>;
  rsvpTotal(): number;
  /** Resolves true when the reservation was written. The sheet keeps
   *  itself open on true to show what was booked. */
  confirmRsvp(): Promise<boolean>;
  openRegistration(kind: 'community' | 'venue' | 'shop'): void;
  recordRegistration(kind: string, name: string, meta: string): void;
  decideRegistration(id: string, decision: string): void;

  // coach
  addCert(name: string): void;
  removeCert(id: string): void;
  openCase(id: string): void;
  openSafetyCase(id: string): void;
  backToReports(): void;
  genPromo(): void;
  loyaltyAdjust(key: string, delta: number): void;
  daySlots(): string[];
  addTimeLabel(): string;
  canAddSlot(): boolean;
  addSlot(): void;
  removeSlot(t: string): void;
  setDayOff(): void;
  updPkg(id: string, dSessions?: number, dPrice?: number): void;
  removePkg(id: string): void;
  addPackage(): void;
  genCoachPromo(): void;
}

export const useStore = create<SpotterState>((set, get) => ({
  tab: 'discover',
  modules: [],
  role: 'USER',
  isCoach: false,
  blockedIds: [],
  followedIds: [],
  signupIntent: null,
  signupSports: [],
  isDark: true,
  overlay: null,
  sheet: null,
  writeBusy: null,
  writeError: null,
  authEmail: null,
  authName: null,
  authUid: null,
  authAvatarUrl: null,
  profileRevision: 0,
  authUserId: null,
  loaded: { people: false, shops: false, communities: false, events: false, suggestions: false },

  authSeek: '',
  authLoc: '',
  searchRadius: 12,

  venues: [],
  venuesLoading: false,
  venuesError: null,
  rsvpTarget: null,
  rsvpRef: null,
  rsvpPriceCents: 0,
  rsvpPerHour: true,
  rsvpStartsAt: null,
  courtReservations: [],
  rsvpType: 'Single',
  rsvpHours: 1,
  rsvpGear: false,
  rsvpCoach: false,

  regKind: 'community',
  pendingRegistrations: [],
  regChannel: null,
  regTime: '',

  discSearch: '',

  mode: 'coaches',
  sport: 'All',
  sortBy: 'rating',
  discoverView: 'cards',
  shopView: 'list',
  sportMenu: false,
  remotePeople: [],
  remoteShops: [],

  openId: '',
  shopId: '',
  chatId: '',
  communityId: '',
  eventId: '',
  returnTo: null,

  cart: {},

  bookDate: null,
  bookSlot: null,
  bookPkg: 0,
  booked: false,
  bookingChange: false,

  notifSeen: false,
  pushOn: true,
  dailyPlanOn: true,
  calSyncOn: false,
  calProvider: 'GOOGLE',


  shopRegName: '',
  shopRegCat: null,
  shopRegCatOther: '',
  shopRegCatMenu: false,
  shopRegPhone: '',
  shopRegEmail: '',
  shopRegMeans: null,
  shopRegTime: '',
  shopRegDone: false,
  shopRegDoneName: '',
  shopRegDoneCat: null,
  shopRegDoneMeta: '',
  shopOrderDone: false,
  shopDecisions: {},

  joinedCommunities: [],
  pendingCommunities: [],
  joinedSubs: [],
  goingEvents: [],
  customCommunities: [],
  remoteCommunities: [],
  communityRoles: {},
  communityMemberRoles: {},
  communityAboutEdits: {},
  eventSuggestions: [],

  setRemoteEventSuggestions: (suggestions) =>
    set((state) => ({ eventSuggestions: suggestions, loaded: { ...state.loaded, suggestions: true } })),

  customEvents: [],
  remoteEvents: [],
  newType: 'Meetup',
  newSport: '',
  newSub: null,
  newDay: 0,
  newTime: 1,
  newTitle: '',
  newLoc: '',
  evtCreated: false,
  eventSuggested: false,
  commName: '',
  commDraft: EMPTY_COMMUNITY_DRAFT,
  commCreated: false,
  editCommunityAbout: '',
  reqName: '',
  reqType: 'Hobby',
  reqPlaced: null,
  reqSent: false,

  myCerts: [],
  apptDecisions: {},
  coachRate: 0,
  schedDay: 'THU',
  addTimeIdx: 4,
  schedule: {},
  myPackages: [],
  newPkgSessions: 10,
  newPkgPrice: 0,
  cPromoPct: 15,
  cPromoCode: null,

  hobbyDecisions: {},
  caseId: '',
  safetyCaseId: '',
  promoPct: 15,
  promoAud: 'All users',
  promoCode: null,
  loyaltyPts: {},

  set: (key, value) => set({ [key]: value } as Partial<SpotterState>),

  toggleCommunity: async (id) => {
    const s = get();
    const joined = s.joinedCommunities.includes(id);
    set({ writeBusy: `community:${id}`, writeError: null });
    try {
      if (joined) {
        const role = await leaveCommunityRemote(id);
        track('community_left');
        set((state) => {
          const communityRoles = { ...state.communityRoles };
          delete communityRoles[id];
          return {
            joinedCommunities: state.joinedCommunities.filter((x) => x !== id),
            communityRoles,
            pendingCommunities: state.pendingCommunities.filter((x) => x !== id),
            writeBusy: null,
          };
        });
        return;
      }
      // Open or closed is the server's call, not this client's: one RPC either
      // joins or queues a request, and a second copy of the rule here would be
      // the one that goes stale.
      const outcome = await requestMembershipRemote(id);
      track('community_joined');
      set((state) => {
        if (outcome.status === 'pending') {
          return {
            pendingCommunities: state.pendingCommunities.includes(id)
              ? state.pendingCommunities
              : [...state.pendingCommunities, id],
            writeBusy: null,
          };
        }
        return {
          joinedCommunities: [...state.joinedCommunities, id],
          communityRoles: { ...state.communityRoles, [id]: roleFromDb(outcome.role) },
          pendingCommunities: state.pendingCommunities.filter((x) => x !== id),
          writeBusy: null,
        };
      });
    } catch (error) {
      set(errorState(error));
    }
  },
  toggleSub: (id) =>
    set((s) => ({
      joinedSubs: s.joinedSubs.includes(id) ? s.joinedSubs.filter((x) => x !== id) : [...s.joinedSubs, id],
    })),
  toggleGoing: async (id) => {
    const s = get();
    const going = s.goingEvents.includes(id);
    set({ writeBusy: `event:${id}`, writeError: null });
    try {
      const attendees = await setEventAttendance(id, !going);
      set((state) => ({
        goingEvents: going ? state.goingEvents.filter((x) => x !== id) : [...state.goingEvents, id],
        customEvents: state.customEvents.map((event) => (event.id === id ? { ...event, attendees } : event)),
        remoteEvents: state.remoteEvents.map((event) => (event.id === id ? { ...event, attendees } : event)),
        writeBusy: null,
      }));
    } catch (error) {
      set(errorState(error));
    }
  },

  // Whatever the server returned, nothing else. An empty list is a real answer;
  // inventing rows here put bookable strangers in front of paying users.
  // Blocked members drop out of discovery. `personById` deliberately still
  // resolves them from remotePeople, so their profile stays reachable and the
  // block can be lifted.
  people: (mode = get().mode) =>
    get().remotePeople.filter(
      (person) => person.isCoach === (mode === 'coaches') && !get().blockedIds.includes(person.id),
    ),
  setRemotePeople: (people) => set((state) => ({ remotePeople: people, loaded: { ...state.loaded, people: true } })),
  personById: (id) => get().people().find((person) => person.id === id) ?? get().remotePeople.find((person) => person.id === id),
  shops: () => get().remoteShops,
  setRemoteShops: (shops) => set((state) => ({ remoteShops: shops, loaded: { ...state.loaded, shops: true } })),
  shopById: (id) => get().remoteShops.find((shop) => shop.id === id),
  submitShopRegistration: async () => {
    const s = get();
    const shopName = s.shopRegName.trim();
    if (shopName.length === 0 || (s.shopRegPhone.trim().length === 0 && s.shopRegEmail.trim().length === 0)) return;
    set({ writeBusy: 'shop-registration', writeError: null });
    try {
      await submitShopRegistrationRemote({
        shopName,
        category: s.shopRegCat,
        categoryOther: s.shopRegCatOther.trim(),
        phone: s.shopRegPhone.trim(),
        email: s.shopRegEmail.trim(),
        contactPref: s.shopRegMeans,
        bestTime: s.shopRegTime.trim(),
      });
      const meta = [s.shopRegPhone && `Phone ${s.shopRegPhone}`, s.shopRegEmail && `Email ${s.shopRegEmail}`, s.shopRegMeans && `prefers ${s.shopRegMeans}`].filter(Boolean).join(' - ');
      set({ shopRegDoneName: shopName, shopRegDoneMeta: meta, shopRegDone: true, writeBusy: null });
    } catch (error) {
      set(errorState(error));
    }
  },
  checkoutCart: async () => {
    const s = get();
    const shop = s.shopById(s.shopId);
    if (!shop) return;
    const items = shop.products
      .filter((product) => product.id && `${shop.id}:${product.id}` in s.cart)
      .map((product) => ({ product_id: product.id!, qty: 1 }));
    if (items.length === 0) {
      set({ writeError: 'Add an item before checking out.' });
      return;
    }
    set({ writeBusy: 'checkout', writeError: null });
    try {
      await checkoutShopOrderRemote(shop.id, items);
      set({ cart: {}, shopOrderDone: true, writeBusy: null });
    } catch (error) {
      set(errorState(error));
    }
  },
  communities: () => [...get().customCommunities, ...get().remoteCommunities],
  setRemoteCommunities: (communities) =>
    set((state) => ({ remoteCommunities: communities, loaded: { ...state.loaded, communities: true } })),
  // Called after a delete succeeds. Without it the deleted community stayed
  // in every list until the next full refresh -- the row was gone from the
  // database and still on screen, which reads as "delete does not work".
  forgetCommunity: (id) => set((state) => {
    const communityRoles = { ...state.communityRoles };
    delete communityRoles[id];
    return {
      customCommunities: state.customCommunities.filter((cm) => cm.id !== id),
      remoteCommunities: state.remoteCommunities.filter((cm) => cm.id !== id),
      joinedCommunities: state.joinedCommunities.filter((x) => x !== id),
      pendingCommunities: state.pendingCommunities.filter((x) => x !== id),
      communityRoles,
      // Its events go with it; the server has already cascaded them away.
      remoteEvents: state.remoteEvents.filter((e) => e.communityId !== id),
    };
  }),
  // Same reason as forgetCommunity: the server has removed it, and leaving it
  // in the store means a successful delete looks like nothing happening.
  forgetEvent: (id) => set((state) => ({
    remoteEvents: state.remoteEvents.filter((e) => e.id !== id),
    customEvents: state.customEvents.filter((e) => e.id !== id),
    goingEvents: state.goingEvents.filter((x) => x !== id),
  })),
  setRemoteCommunityMemberships: (memberships) => set({
    joinedCommunities: memberships.map((row) => row.communityId),
    communityRoles: Object.fromEntries(memberships.map((row) => [row.communityId, roleFromDb(row.role)])),
  }),
  setRemoteEvents: (events) => set((state) => ({ remoteEvents: events, loaded: { ...state.loaded, events: true } })),
  communityById: (id) =>
    get().customCommunities.find((cm) => cm.id === id) ?? get().remoteCommunities.find((cm) => cm.id === id),
  communityAbout: (id) => get().communityAboutEdits[id] ?? get().communityById(id)?.about ?? '',
  currentCommunityRole: (id) => get().communityRoles[id ?? get().communityId] ?? 'MEMBER',
  canAdminCommunity: (id) => get().currentCommunityRole(id) === 'ADMIN',
  canModerateCommunity: (id) => canModerateRole(get().currentCommunityRole(id)),
  setCommunityMemberRole: (communityId, memberId, role) => {
    const s = get();
    if (!s.canAdminCommunity(communityId) || memberId === s.authUserId) return;
    set({
      communityMemberRoles: {
        ...s.communityMemberRoles,
        [communityId]: { ...(s.communityMemberRoles[communityId] ?? {}), [memberId]: role },
      },
    });
  },
  openEditCommunity: () => {
    const s = get();
    if (!s.canModerateCommunity(s.communityId)) return;
    set({ overlay: 'editCommunity' });
  },

  openStartCommunity: () => set({
    overlay: 'startCommunity', commCreated: false,
    commName: '', commDraft: EMPTY_COMMUNITY_DRAFT, writeError: null,
  }),
  openRequest: () => set({
    overlay: 'request', reqSent: false, reqName: '', reqType: 'Hobby',
    reqPlaced: null, writeError: null,
  }),
  openCreateEvent: () => {
    const s = get();
    if (!s.canModerateCommunity(s.communityId)) {
      set({
        overlay: 'suggestEvent',
        eventSuggested: false,
        newTitle: '',
        newLoc: '',
        newType: 'Meetup',
        newSport: s.communityId,
        newSub: null,
        newDay: 0,
        newTime: 1,
        writeError: null,
      });
      return;
    }
    set({
      overlay: 'createEvent',
      evtCreated: false,
      newTitle: '',
      newLoc: '',
      newType: 'Meetup',
      newSport: s.communityId,
      newSub: null,
      newDay: 0,
      newTime: 1,
      writeError: null,
    });
  },
  openSuggestEvent: () => {
    const s = get();
    set({
      overlay: 'suggestEvent',
      eventSuggested: false,
      newTitle: '',
      newType: 'Meetup',
      newSport: s.communityId,
      newSub: null,
      newDay: 0,
      newTime: 1,
      writeError: null,
    });
  },

  submitEvent: async () => {
    const s = get();
    if (!s.canModerateCommunity(s.newSport) || s.newTitle.trim() === '' || s.newLoc.trim() === '' || isExplicit(s.newTitle)) return;
    set({ writeBusy: 'event-create', writeError: null });
    try {
      const row = await createEventRemote(s.newSport, s.newType as EventKind, s.newTitle.trim(), eventWhenLabel(s.newDay, s.newTime), s.newLoc.trim());
      track('event_created', { kind: s.newType });
      const ev = eventFromRemote(row, s.newSport);
      set({ customEvents: [ev, ...s.customEvents], goingEvents: [...s.goingEvents, ev.id], evtCreated: true, overlay: 'community', writeBusy: null });
    } catch (error) {
      set(errorState(error));
    }
  },
  submitEventSuggestion: async () => {
    const s = get();
    if (s.newTitle.trim() === '' || s.newLoc.trim() === '' || isExplicit(s.newTitle)) return;
    set({ writeBusy: 'event-suggestion', writeError: null });
    try {
      const row = await suggestEventRemote(s.newSport, s.newType as EventKind, s.newTitle.trim(), eventWhenLabel(s.newDay, s.newTime), s.newLoc.trim());
      track('event_suggested', { kind: s.newType });
      const suggestion = suggestionFromRemote(row, s.newSport);
      set({
        eventSuggestions: [suggestion, ...s.eventSuggestions.filter((item) => item.id !== suggestion.id && item.id !== 'sg1')],
        eventSuggested: true,
        writeBusy: null,
      });
    } catch (error) {
      set(errorState(error));
    }
  },
  approveEventSuggestion: async (id) => {
    const s = get();
    const suggestion = s.eventSuggestions.find((item) => item.id === id);
    if (!suggestion || suggestion.status !== 'PENDING' || !s.canModerateCommunity(suggestion.communityId)) return;
    set({ writeBusy: `suggestion:${id}`, writeError: null });
    try {
      const eventId = await approveSuggestionRemote(id);
      track('event_created', { kind: suggestion.type });
      const ev: EventItem = {
        id: eventId,
        communityId: suggestion.communityId,
        subId: null,
        type: suggestion.type,
        title: suggestion.title,
        whenLabel: suggestion.whenLabel,
        loc: suggestion.loc,
        attendees: 1,
        // Real account name; never a placeholder person.
        host: s.authName ?? 'Member',
      };
      set({
        customEvents: [ev, ...s.customEvents],
        eventSuggestions: s.eventSuggestions.map((item) => (item.id === id ? { ...item, status: 'APPROVED' } : item)),
        writeBusy: null,
      });
    } catch (error) {
      set(errorState(error));
    }
  },
  submitCommunity: async () => {
    const s = get();
    const draft = s.commDraft;
    const name = draft.name.trim();
    // The description goes through the same word filter the name does. It used
    // not to exist at creation, so this is the first time there is one to check.
    if (name === '' || isExplicit(name) || isExplicit(draft.about)) return;
    set({ writeBusy: 'community-create', writeError: null });
    try {
      const row = await createCommunityRemote({ ...draft, name });
      track('community_created');
      const community = communityFromRemote(row);
      set({
        customCommunities: [community, ...s.customCommunities],
        joinedCommunities: [...s.joinedCommunities, community.id],
        communityRoles: { ...s.communityRoles, [community.id]: 'ADMIN' },
        communityMemberRoles: { ...s.communityMemberRoles, [community.id]: {} },
        communityId: community.id,
        commCreated: true,
        writeBusy: null,
      });
    } catch (error) {
      set(errorState(error));
    }
  },
  submitRequest: async () => {
    const s = get();
    if (s.reqName.trim() === '' || isExplicit(s.reqName)) return;
    set({ writeBusy: 'sport-request', writeError: null });
    try {
      // Through the same path the search uses: the engine places it, and the
      // member is never asked where it belongs.
      const filed = await requestSportRemote(s.reqName.trim());
      track('sport_requested', { kind: filed.kind });
      set({
        reqSent: true,
        reqPlaced: filed.placedByEngine && filed.category
          ? `${filed.kind === 'hobby' ? 'Hobbies' : 'Sports'} › ${filed.category}`
          : null,
        writeBusy: null,
      });
    } catch (error) {
      set(errorState(error));
    }
  },
  allEvents: () => [...get().customEvents, ...get().remoteEvents],

  toggleCartItem: (key, price) =>
    set((s) => {
      const cart = { ...s.cart };
      if (key in cart) delete cart[key];
      else cart[key] = price;
      return { cart, shopOrderDone: false };
    }),
  cartCount: () => Object.keys(get().cart).length,
  cartTotal: () => Object.values(get().cart).reduce((a, b) => a + b, 0),

  openPerson: (id) => {
    set({ openId: id, overlay: 'person', bookPkg: 0 });
    const person = get().personById(id);
    if (person) track('profile_opened', { role: person.isCoach ? 'coach' : 'partner' });
  },
  // Role follows the account, so it is read from the server rather than
  // chosen in the UI. Failures leave the current value alone.
  refreshRole: async () => {
    const uid = get().authUid;
    try {
      const { role, isCoach } = await fetchAccountStanding();
      if (get().authUid === uid) set({ role, isCoach });
    } catch {
      /* offline or unauthenticated - keep whatever we already had */
    }
  },
  refreshBlocked: async () => {
    const uid = get().authUid;
    try {
      const blockedIds = (await fetchBlockedUsers()).map((row) => row.id);
      if (get().authUid === uid) set({ blockedIds });
    } catch {
      /* offline or unauthenticated - keep whatever we already had */
    }
  },
  refreshCircle: async () => {
    const uid = get().authUid;
    try {
      const followedIds = await fetchFollowedIds();
      // The account can change while this is in flight; writing the previous
      // account's circle over the new one would show the wrong Follow states.
      if (get().authUid === uid) set({ followedIds });
    } catch {
      /* offline or unauthenticated - keep whatever we already had */
    }
  },
  toggleFollow: async (userId) => {
    const following = get().followedIds.includes(userId);
    set({ writeBusy: `follow:${userId}`, writeError: null });
    try {
      if (following) await unfollowPerson(userId);
      else await followPerson(userId);
      track(following ? 'unfollowed' : 'followed');
      await get().refreshCircle();
      set({ writeBusy: null });
    } catch (error) {
      set(errorState(error));
    }
  },
  toggleBlock: async (userId) => {
    const blocked = get().blockedIds.includes(userId);
    set({ writeBusy: 'block', writeError: null });
    try {
      if (blocked) await unblockUser(userId);
      else await blockUser(userId);
      track(blocked ? 'unblocked' : 'blocked');
      // A block drops the follow in both directions (trg_drop_follows_on_block),
      // so the local copy has to be re-read or the button keeps saying
      // "Following" for someone who is no longer followed.
      await Promise.all([get().refreshBlocked(), get().refreshCircle()]);
      set({ writeBusy: null });
    } catch (error) {
      set(errorState(error));
    }
  },
  // Tapping a pack in My bookings goes straight to booking the rest of it.
  //
  // `bookPkg` is left at 0 rather than resolved here: the booking screen reads
  // what this account owns and lands on an active pack by itself, so choosing
  // the index in two places would be two answers that can disagree.
  openPackBooking: (coachId) => {
    set({
      openId: coachId, overlay: 'booking', booked: false,
      bookPkg: 0, bookDate: null, bookSlot: null, writeError: null,
    });
    track('package_booking_opened');
  },
  openBooking: () => {
    set({ overlay: 'booking', booked: false, bookPkg: 0, bookDate: null, bookSlot: null, writeError: null });
    if (get().personById(get().openId)) track('booking_opened');
  },
  backToPerson: () => set({ overlay: 'person', booked: false }),
  confirmBooking: async () => {
    const s = get();
    const person = s.personById(s.openId);
    if (!person) {
      track('booking_failed', { error_code: 'COACH_UNAVAILABLE' });
      set({ writeError: 'That coach is no longer available.' });
      return;
    }
    const { bookDate, bookSlot } = s;
    if (!bookDate || !bookSlot) {
      set({ writeError: 'Pick a day and a time first.' });
      return;
    }
    const pkg = coachPackageOptions(person)[s.bookPkg] ?? coachPackageOptions(person)[0];
    set({ writeBusy: 'booking', writeError: null });
    try {
      await createBookingRemote(
        { id: person.id, name: person.name },
        scheduledFor(bookDate, bookSlot),
        `${pkg.name} - ${bookingDayLabel(bookDate)} - ${bookSlot}`,
        pkg.packageId,
        bookSlot,
      );
      set({ booked: true, writeBusy: null });
    } catch (error) {
      track('booking_failed', { error_code: analyticsErrorCode(error) });
      set(errorState(error));
    }
  },
  goToBookings: () => set({ overlay: 'bookings', booked: false }),
  openBookings: () => set({ overlay: 'bookings' }),
  openShop: (id) => set({ shopId: id, overlay: 'shop', shopOrderDone: false, writeError: null }),
  openChat: (id) => {
    set({ chatId: id, overlay: 'conversation' });
    track('conversation_opened');
  },
  openCommunity: (id) => set({ communityId: id, sportMenu: false, overlay: 'community' }),
  openEvent: (id, from) => set({ eventId: id, returnTo: from, overlay: 'event' }),
  openNotifs: () => set({ overlay: 'notifications', notifSeen: true }),
  closeOverlay: () => set({ overlay: null }),

  // ---- handoff v2: bottom-sheet layer ----
  openSheet: (id) => set({ sheet: id }),
  closeSheet: () => set({ sheet: null }),

  loadVenues: async () => {
    set({ venuesLoading: true, venuesError: null });
    try {
      set({ venues: await fetchVenues(), venuesLoading: false });
    } catch (error) {
      set({ venues: [], venuesLoading: false, venuesError: errorMessage(error) });
    }
  },

  // Reservations are read back rather than assembled locally: the server owns
  // the totals, so its rows are the only honest source for "what I booked".
  refreshCourtReservations: async () => {
    try {
      set({ courtReservations: await fetchMyCourtReservations() });
    } catch {
      /* browsing must not break because the reservation list failed to load */
    }
  },

  // Opening resolves the subject from the loaded venues by id. Returns false
  // when it cannot be resolved, so the caller refuses rather than guesses.
  openRsvp: (ref) => {
    const subject = rsvpSubject(get().venues, ref);
    if (!subject) {
      set({ writeError: 'That slot is unavailable right now.' });
      return false;
    }
    // A closed venue is a guaranteed 'this venue is closed' from the RPC; say so
    // here instead of charging the user a round-trip to find out.
    if (subject.venue.status !== 'open') {
      set({ writeError: `${subject.venue.name} is closed right now.` });
      return false;
    }
    set({
      sheet: 'rsvp',
      rsvpRef: ref,
      rsvpTarget: subject.title,
      rsvpPriceCents: subject.priceCents,
      rsvpPerHour: subject.perHour,
      rsvpStartsAt: null,
      rsvpType: 'Single',
      rsvpHours: 1,
      rsvpGear: false,
      rsvpCoach: false,
      writeError: null,
    });
    return true;
  },

  /**
   * DISPLAY ESTIMATE ONLY, in cents. The server is authoritative: reserve_court
   * re-reads the court rate and the venue's gear rate and writes its own
   * total_cents, so this number exists to show a figure before the tap and is
   * never sent, recorded, or trusted afterwards.
   */
  rsvpTotal: () => {
    const st = get();
    if (!st.rsvpPerHour) return st.rsvpPriceCents;
    const subject = rsvpSubject(st.venues, st.rsvpRef);
    const gearRate = subject ? (equipmentRateCents(subject.venue, subject.court) ?? 0) : 0;
    return st.rsvpPriceCents * st.rsvpHours + (st.rsvpGear ? gearRate * st.rsvpHours : 0);
  },

  confirmRsvp: async () => {
    const st = get();
    const subject = rsvpSubject(st.venues, st.rsvpRef);
    if (!subject) {
      set({ sheet: null, writeError: 'That slot is unavailable right now.' });
      return false;
    }
    // reserve_court requires an instant; there is no safe default for "when",
    // so refuse rather than invent one.
    if (subject.perHour && !st.rsvpStartsAt) {
      set({ writeError: 'Pick a day and a start time first.' });
      return false;
    }

    set({ writeBusy: 'rsvp', writeError: null });
    try {
      if (subject.perHour && subject.court) {
        await reserveCourt({
          courtId: subject.court.id,
          startsAt: st.rsvpStartsAt as string,
          hours: st.rsvpHours,
          kind: st.rsvpType as 'Single' | 'Teams' | 'Member of team',
          equipment: st.rsvpGear,
        });
      } else if (subject.event) {
        await enterVenueEvent(subject.event.id);
      } else {
        throw new Error('That slot is unavailable right now.');
      }
    } catch (error) {
      // The sheet stays open on failure so the user can change the time or the
      // court rather than losing what they picked.
      set(errorState(error));
      return false;
    }

    // The sheet is left open on purpose: it swaps to a receipt naming what was
    // booked. Closing here is what made a successful reservation indis-
    // tinguishable from a dismissed one.
    set({ writeBusy: null });
    await get().refreshCourtReservations();
    // "Add a coach" routes into the coach calendar; go through openBooking so a
    // previous confirmation screen is cleared first.
    if (st.rsvpCoach) {
      set({ sheet: null });
      get().openBooking();
      return true;
    }
    return true;
  },

  recordRegistration: (kind, name, meta) =>
    set((state) => ({
      pendingRegistrations: [
        ...state.pendingRegistrations,
        { id: `reg-${state.pendingRegistrations.length}-${Date.now()}`, kind, name, meta },
      ],
    })),
  decideRegistration: (id, decision) =>
    set((state) => ({
      pendingRegistrations: state.pendingRegistrations.map((r) =>
        r.id === id ? { ...r, decision } : r
      ),
    })),

  openRegistration: (kind) =>
    set({
      overlay: 'registration',
      regKind: kind,
      regChannel: null,
      regTime: '',
      shopRegName: '',
      shopRegCat: null,
      shopRegPhone: '',
      shopRegEmail: '',
      shopRegDone: false,
    }),
  addCert: (name) =>
    set((s) => ({ myCerts: [...s.myCerts, { id: `ct${Date.now()}`, name, issuer: 'Awaiting verification', year: '2026', verified: false }] })),
  removeCert: (id) => set((s) => ({ myCerts: s.myCerts.filter((x) => x.id !== id) })),
  openCase: (id) => set({ caseId: id, overlay: 'adminCase' }),
  openSafetyCase: (id) => set({ safetyCaseId: id, overlay: 'safetyCase' }),
  backToReports: () => set({ overlay: 'adminReports' }),
  genPromo: () => set((s) => ({ promoCode: `SPOT${s.promoPct}-${randCode()}` })),
  loyaltyAdjust: (key, delta) =>
    set((s) => ({ loyaltyPts: { ...s.loyaltyPts, [key]: Math.max(100, (s.loyaltyPts[key] ?? 100) + delta) } })),

  daySlots: () => byTime(get().schedule[get().schedDay] ?? []),
  addTimeLabel: () => SCHED_TIMES[get().addTimeIdx] ?? SCHED_TIMES[0],
  canAddSlot: () => !(get().schedule[get().schedDay] ?? []).includes(get().addTimeLabel()),
  addSlot: () => {
    const s = get();
    if (!s.canAddSlot()) return;
    set({ schedule: { ...s.schedule, [s.schedDay]: byTime([...(s.schedule[s.schedDay] ?? []), s.addTimeLabel()]) } });
  },
  removeSlot: (t) => set((s) => ({ schedule: { ...s.schedule, [s.schedDay]: (s.schedule[s.schedDay] ?? []).filter((x) => x !== t) } })),
  setDayOff: () => set((s) => ({ schedule: { ...s.schedule, [s.schedDay]: [] } })),
  updPkg: (id, dSessions = 0, dPrice = 0) =>
    set((s) => ({
      myPackages: s.myPackages.map((p) =>
        p.id === id ? { ...p, sessions: Math.max(1, p.sessions + dSessions), price: Math.max(5, p.price + dPrice) } : p
      ),
    })),
  removePkg: (id) => set((s) => ({ myPackages: s.myPackages.filter((x) => x.id !== id) })),
  addPackage: () =>
    set((s) => ({ myPackages: [...s.myPackages, { id: `pk${Date.now()}`, sessions: s.newPkgSessions, price: s.newPkgPrice }] })),
  genCoachPromo: () => set((s) => ({ cPromoCode: `ALEX-${randCode()}-${s.cPromoPct}` })),
}));
