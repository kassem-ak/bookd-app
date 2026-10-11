import React from 'react';
import { useStore } from '../state/store';
import { CircleOverlay } from '../overlays/CircleOverlay';
import { CoachingOverlay } from '../overlays/CoachingOverlay';
import { PartnerSessionOverlay } from '../overlays/PartnerSessionOverlay';
import { EditProfileOverlay } from '../overlays/EditProfileOverlay';
import { MyCommunitiesOverlay } from '../overlays/MyCommunitiesOverlay';
import { CommunityProfileOverlay } from '../overlays/CommunityProfileOverlay';
import { RegistrationOverlay } from '../overlays/RegistrationOverlay';
import { CoachDayViewOverlay } from '../overlays/CoachDayViewOverlay';
import { PersonOverlay } from '../overlays/PersonOverlay';
import { BookingOverlay } from '../overlays/BookingOverlay';
import { BookingsOverlay } from '../overlays/BookingsOverlay';
import {
  CommunityDetailOverlay,
  EventDetailOverlay,
  CreateEventOverlay,
  StartCommunityOverlay,
  RequestOverlay,
  EventSuggestionOverlay,
} from '../overlays/CommunityOverlays';
import { CommunityChatOverlay } from '../overlays/CommunityChatOverlay';
import { CommunityMembersOverlay } from '../overlays/CommunityMembersOverlay';
import { CommunityManageOverlay } from '../overlays/CommunityManageOverlay';
import { EventManageOverlay } from '../overlays/EventManageOverlay';
import {
  ConversationOverlay,
  NotificationsOverlay,
  ReportOverlay,
} from '../overlays/UtilityOverlays';
import {
  CoachRequestsOverlay,
  CoachPackagesOverlay,
} from '../overlays/CoachOverlays';
import { CoachHoursOverlay, CoachSubjectsOverlay } from '../overlays/CoachSubjectsOverlay';
import { PaymentMethodsOverlay } from '../overlays/PaymentMethodsOverlay';

export function OverlayRouter({ id }: { id: string }) {
  switch (id) {
    case 'editProfile':
      return <EditProfileOverlay />;
    case 'communityProfile':
      return <CommunityProfileOverlay />;
    case 'partnerSession':
      return <PartnerSessionOverlay />;
    case 'coaching':
      return <CoachingOverlay />;
    case 'circle':
      return <CircleOverlay />;
    case 'myCommunities':
      return <MyCommunitiesOverlay />;
    case 'registration':
    case 'communityRegister':
      // handoff v2 section 9: one shared form for community / venue / shop
      return <RegistrationOverlay />;
    case 'coachDayView':
      return <CoachDayViewOverlay />;
    case 'person':
      return <PersonOverlay />;
    case 'booking':
      return <BookingOverlay />;
    case 'bookings':
      return <BookingsOverlay />;
    case 'community':
      return <CommunityDetailOverlay />;
    case 'event':
      return <EventDetailOverlay />;
    case 'manageEvent':
      return <EventManageOverlay />;
    case 'createEvent':
      return <CreateEventOverlay />;
    case 'suggestEvent':
      return <EventSuggestionOverlay />;
    // The old editor only held the description. Everything a community has --
    // its name, privacy, sport, picture, gallery, the queue at its door and who
    // runs it -- now lives on one screen, so there is one place to look.
    case 'editCommunity':
      return <CommunityManageOverlay />;
    case 'communityMembers':
      return <CommunityMembersOverlay />;
    case 'communityChat':
      return <CommunityChatOverlay />;
    case 'startCommunity':
      return <StartCommunityOverlay />;
    case 'request':
      return <RequestOverlay />;
    case 'conversation':
      return <ConversationOverlay />;
    case 'notifications':
      return <NotificationsOverlay />;
    case 'report':
      return <ReportOverlay />;
    case 'coachRequests':
      return <CoachRequestsOverlay />;
    // The old slot-by-slot schedule editor is gone; `coachSchedule` now opens
    // the hours screen, so any link still pointing at it lands somewhere real.
    case 'coachSchedule':
    case 'coachHours':
      return <CoachHoursOverlay />;
    case 'coachSubjects':
      return <CoachSubjectsOverlay />;
    case 'coachPackages':
      return <CoachPackagesOverlay />;
    case 'paymentMethods':
      return <PaymentMethodsOverlay />;
    default:
      return null;
  }
}
