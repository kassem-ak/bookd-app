-- Payments on real subjects. Passes when it raises 'ALL PAYMENTS SUBJECT CHECKS PASSED'.
do $$
declare
  v_auth uuid := gen_random_uuid(); v_coach_auth uuid := gen_random_uuid();
  v_me uuid; v_coach uuid; v_pkg uuid; v_booking uuid; v_pay uuid; v_venue uuid; v_court uuid;
  v_slot timestamptz := date_trunc('day', now()) + interval '3 days' + interval '10 hours';
  v_err text; v_status text; v_n int;
  v_owner_auth uuid := gen_random_uuid(); v_owner uuid; v_venue2 uuid; v_court2 uuid;
  v_pkg2 uuid; v_pkg3 uuid; v_pkg4 uuid; v_p1 uuid; v_b2 uuid; v_res uuid;
  v_ev uuid; v_ev2 uuid; v_entry uuid; v_entry2 uuid; v_comm uuid; v_event uuid;
  v_fee0 bigint; v_fee1 bigint; v_pkg5 uuid; v_pkg6 uuid; v_cancel uuid;
begin
  insert into auth.users (id) values (v_auth), (v_coach_auth), (v_owner_auth);
  set local role service_role;
  select id into v_me from users where auth_id = v_auth;
  select id into v_coach from users where auth_id = v_coach_auth;
  select id into v_owner from users where auth_id = v_owner_auth;
  -- A venue with an owner for the checks that take money: tournaments (13) and courts (14).
  insert into venues (slug, name, city, sport, status, equipment_cents_per_hour, timezone, opens_at, closes_at, owner_id)
  values ('zz-pay-venue-owned', 'ZZ Pay Venue Owned', 'Beirut', 'Paddle', 'open', 0, 'UTC', '00:00', '23:59', v_owner) returning id into v_venue2;
  insert into courts (venue_id, name, price_cents_per_hour, active) values (v_venue2, 'ZZ OWNED COURT', 3000, true) returning id into v_court2;
  insert into coach_profiles (user_id, headline, price_cents) values (v_coach, 'ZZ pay coach', 5000);
  insert into packages (coach_id, sessions, price_cents, active) values (v_coach, 4, 20000, true) returning id into v_pkg;
  insert into packages (coach_id, sessions, price_cents, active) values (v_coach, 4, 20000, true) returning id into v_pkg2;
  insert into packages (coach_id, sessions, price_cents, active) values (v_coach, 4, 20000, true) returning id into v_pkg3;
  insert into packages (coach_id, sessions, price_cents, active) values (v_coach, 4, 20000, true) returning id into v_pkg4;
  insert into packages (coach_id, sessions, price_cents, active) values (v_coach, 4, 20000, true) returning id into v_pkg5;
  insert into packages (coach_id, sessions, price_cents, active) values (v_coach, 4, 20000, true) returning id into v_pkg6;
  insert into venues (slug, name, city, sport, status, equipment_cents_per_hour, timezone, opens_at, closes_at)
  values ('zz-pay-venue', 'ZZ Pay Venue', 'Beirut', 'Paddle', 'open', 0, 'UTC', '00:00', '23:59') returning id into v_venue;
  insert into courts (venue_id, name, price_cents_per_hour, active) values (v_venue, 'ZZ PAY COURT', 3000, true) returning id into v_court;
  update payment_settings set enabled_kinds = array['session','package','court'], fee_bps = 0, fee_flat_cents = 0;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_auth::text, 'role', 'authenticated')::text, true);

  -- 1. A paid single session is pending until paid, with a payment open.
  v_booking := create_booking_for_coach(v_coach, v_slot, 'ZZ single', null, null);
  select status into v_status from bookings where id = v_booking;
  if v_status <> 'pending' then raise exception 'FAIL 1: booking is %', v_status; end if;
  select id into v_pay from payments where kind = 'session' and subject_id = v_booking;
  if v_pay is null then raise exception 'FAIL 1b: no payment opened'; end if;

  -- 2. Paying confirms it.
  set local role service_role;
  perform payments_begin_charge(v_pay);
  perform payments_mark_held(v_pay, 'zz_sub_1', 0, null);
  if (select status from bookings where id = v_booking) <> 'confirmed' then raise exception 'FAIL 2: not confirmed after payment'; end if;

  -- 3. The member cancels a paid session: the price is refunded.
  set local role authenticated;
  update bookings set status = 'cancelled' where id = v_booking;
  set local role service_role;
  if (select coalesce(sum(amount_cents),0) from refunds where payment_id = v_pay) <> 5000 then
    raise exception 'FAIL 3: cancelled paid session not refunded';
  end if;

  -- 4. Cancelling an unpaid booking cancels the payment, no money moves.
  set local role authenticated;
  v_booking := create_booking_for_coach(v_coach, v_slot + interval '1 day', 'ZZ unpaid', null, null);
  update bookings set status = 'cancelled' where id = v_booking;
  set local role service_role;
  select status into v_status from payments where kind = 'session' and subject_id = v_booking;
  if v_status <> 'cancelled' then raise exception 'FAIL 4: payment is % after cancelling unpaid booking', v_status; end if;

  -- 5. Expiry cancels the booking.
  set local role authenticated;
  v_booking := create_booking_for_coach(v_coach, v_slot + interval '2 days', 'ZZ expire', null, null);
  set local role service_role;
  select id into v_pay from payments where kind = 'session' and subject_id = v_booking;
  update payments set expires_at = now() - interval '1 second' where id = v_pay;
  perform private.fail_payment(v_pay, 'expired');
  if (select status from bookings where id = v_booking) <> 'cancelled' then raise exception 'FAIL 5: expired booking still live'; end if;

  -- 6. Completion by both sides adds a release.
  set local role authenticated;
  v_booking := create_booking_for_coach(v_coach, v_slot + interval '3 days', 'ZZ complete', null, null);
  set local role service_role;
  select id into v_pay from payments where kind = 'session' and subject_id = v_booking;
  perform payments_begin_charge(v_pay);
  perform payments_mark_held(v_pay, 'zz_sub_6', 0, null);
  update bookings set status = 'completed' where id = v_booking;
  if not exists (select 1 from payment_releases where payment_id = v_pay) then raise exception 'FAIL 6: no release on completion'; end if;

  -- 7. Package: one payment for the pack; per-session releases; refund capped at what is held.
  set local role authenticated;
  perform book_package_sessions(v_coach, v_pkg, jsonb_build_array(
    jsonb_build_object('at', v_slot + interval '10 days', 'label', 'A'),
    jsonb_build_object('at', v_slot + interval '11 days', 'label', 'B')));
  set local role service_role;
  select p.id into v_pay from payments p where p.kind = 'package' and p.payer_id = v_me;
  select count(*) into v_n from bookings where client_id = v_me and package_id = v_pkg and status = 'pending';
  if v_n <> 2 then raise exception 'FAIL 7: % pack bookings pending, expected 2', v_n; end if;
  perform payments_begin_charge(v_pay);
  perform payments_mark_held(v_pay, 'zz_sub_7', 0, null);
  select count(*) into v_n from bookings where client_id = v_me and package_id = v_pkg and status = 'confirmed';
  if v_n <> 2 then raise exception 'FAIL 7b: paying did not confirm both pack bookings'; end if;
  update bookings set status = 'completed' where client_id = v_me and package_id = v_pkg and slot_label = 'A';
  if (select amount_cents from payment_releases where payment_id = v_pay) <> 5000 then raise exception 'FAIL 7c: per-session release'; end if;
  insert into package_cancellations (client_id, coach_id, package_id, status, refund_cents)
  values (v_me, v_coach, v_pkg, 'approved', 999999);
  if (select sum(amount_cents) from refunds where payment_id = v_pay) <> 15000 then
    raise exception 'FAIL 7d: pack refund % not capped at the 15000 still held', (select sum(amount_cents) from refunds where payment_id = v_pay);
  end if;

  -- 8. A court at a venue with no owner cannot be paid for.
  set local role authenticated;
  begin
    perform reserve_court(v_court, v_slot + interval '20 days', 1, 'Single', false);
    raise exception 'FAIL 8: ownerless venue took a reservation with payments on';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'This venue cannot take payments yet.' then raise exception 'FAIL 8b: %', v_err; end if;
  end;

  -- 9. With payments off, bookings behave exactly as before.
  set local role service_role;
  update payment_settings set enabled_kinds = '{}';
  set local role authenticated;
  v_booking := create_booking_for_coach(v_coach, v_slot + interval '30 days', 'ZZ off', null, null);
  if (select status from bookings where id = v_booking) <> 'confirmed' then raise exception 'FAIL 9: payments off changed booking'; end if;

  -- Payments back on for the checks below.
  set local role service_role;
  update payment_settings set enabled_kinds = array['session','package','court','tournament','event'], fee_bps = 0, fee_flat_cents = 0;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_auth::text, 'role', 'authenticated')::text, true);

  -- 10. A pack's only session is cancelled and booked again: no second charge, same payment.
  perform book_package_sessions(v_coach, v_pkg2, jsonb_build_array(
    jsonb_build_object('at', v_slot + interval '40 days', 'label', 'A')));
  set local role service_role;
  select payment_id into v_p1 from bookings where client_id = v_me and package_id = v_pkg2;
  if v_p1 is null then raise exception 'FAIL 10: pack booking is not bound to its payment'; end if;
  perform payments_begin_charge(v_p1);
  perform payments_mark_held(v_p1, 'zz_sub_10', 0, null);
  set local role authenticated;
  update bookings set status = 'cancelled' where client_id = v_me and package_id = v_pkg2;
  perform book_package_sessions(v_coach, v_pkg2, jsonb_build_array(
    jsonb_build_object('at', v_slot + interval '41 days', 'label', 'B')));
  set local role service_role;
  select count(*) into v_n from payments p join bookings f on f.id = p.subject_id
   where p.kind = 'package' and p.payer_id = v_me and f.package_id = v_pkg2;
  if v_n <> 1 then raise exception 'FAIL 10b: % package payments for the re-booked pack, expected 1', v_n; end if;
  select id into v_b2 from bookings where client_id = v_me and package_id = v_pkg2 and status <> 'cancelled';
  if not exists (select 1 from bookings where id = v_b2 and status = 'confirmed' and payment_id = v_p1) then
    raise exception 'FAIL 10c: re-booked session is not confirmed on the original payment';
  end if;
  update bookings set status = 'completed' where id = v_b2;
  if not exists (select 1 from payment_releases where payment_id = v_p1 and subject_id = v_b2) then
    raise exception 'FAIL 10d: completing the re-booked session did not release from the original payment';
  end if;

  -- 11. Cancelling a free sibling of an unpaid pack keeps the purchase; cancelling the subject ends it.
  set local role authenticated;
  perform book_package_sessions(v_coach, v_pkg3, jsonb_build_array(
    jsonb_build_object('at', v_slot + interval '50 days', 'label', 'A'),
    jsonb_build_object('at', v_slot + interval '51 days', 'label', 'B')));
  set local role service_role;
  select p.id, p.subject_id into v_pay, v_booking from payments p
   where p.kind = 'package' and p.payer_id = v_me and p.subject_id in (select id from bookings where package_id = v_pkg3);
  select id into v_b2 from bookings where client_id = v_me and package_id = v_pkg3 and id <> v_booking;
  if (select count(*) from bookings where package_id = v_pkg3 and payment_id = v_pay) <> 2 then
    raise exception 'FAIL 11: both pack bookings should point at the pack payment';
  end if;
  set local role authenticated;
  update bookings set status = 'cancelled' where id = v_b2;
  set local role service_role;
  select status into v_status from payments where id = v_pay;
  if v_status <> 'awaiting_payment' then raise exception 'FAIL 11b: cancelling a free sibling left the payment %', v_status; end if;
  set local role authenticated;
  update bookings set status = 'cancelled' where id = v_booking;
  set local role service_role;
  select status into v_status from payments where id = v_pay;
  if v_status <> 'cancelled' then raise exception 'FAIL 11c: cancelling the subject booking left the payment %', v_status; end if;

  -- 12. A refund on cancellation gives back the price and keeps the fee.
  update payment_settings set fee_bps = 300;
  set local role authenticated;
  v_booking := create_booking_for_coach(v_coach, v_slot + interval '42 days', 'ZZ fee', null, null);
  set local role service_role;
  select id into v_pay from payments where kind = 'session' and subject_id = v_booking;
  if (select fee_cents from payments where id = v_pay) <> 150 then raise exception 'FAIL 12: fee is not 3 percent of 5000'; end if;
  perform payments_begin_charge(v_pay);
  perform payments_mark_held(v_pay, 'zz_sub_12', 0, null);
  select balance_cents into v_fee0 from ledger_balances where code = 'fee_income';
  set local role authenticated;
  update bookings set status = 'cancelled' where id = v_booking;
  set local role service_role;
  if (select coalesce(sum(amount_cents), 0) from refunds where payment_id = v_pay) <> 5000 then
    raise exception 'FAIL 12b: refund is not the price';
  end if;
  select balance_cents into v_fee1 from ledger_balances where code = 'fee_income';
  if v_fee1 is distinct from v_fee0 then raise exception 'FAIL 12c: fee income moved from % to % on refund', v_fee0, v_fee1; end if;
  update payment_settings set fee_bps = 0;

  -- 13. Tournament entry: pending, paid, confirmed; completed releases; cancelled refunds.
  insert into venue_events (venue_id, name, starts_on, ends_on, price_cents)
  values (v_venue2, 'ZZ cup', current_date + 5, current_date + 6, 4000) returning id into v_ev;
  insert into venue_events (venue_id, name, starts_on, ends_on, price_cents)
  values (v_venue2, 'ZZ cup two', current_date + 5, current_date + 6, 4000) returning id into v_ev2;
  set local role authenticated;
  v_entry := enter_venue_event(v_ev);
  set local role service_role;
  if (select status from venue_event_entries where id = v_entry) <> 'pending' then raise exception 'FAIL 13: entry not held pending'; end if;
  select id into v_pay from payments where kind = 'tournament' and subject_id = v_entry;
  if v_pay is null or (select payee_id from payments where id = v_pay) <> v_owner then
    raise exception 'FAIL 13b: no tournament payment to the venue owner';
  end if;
  perform payments_begin_charge(v_pay);
  perform payments_mark_held(v_pay, 'zz_sub_13', 0, null);
  if (select status from venue_event_entries where id = v_entry) <> 'confirmed' then raise exception 'FAIL 13c: entry not confirmed after payment'; end if;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_auth::text, 'role', 'authenticated')::text, true);
  update venue_event_entries set status = 'completed' where id = v_entry;
  set local role service_role;
  if not exists (select 1 from payment_releases where payment_id = v_pay) then raise exception 'FAIL 13d: no release on a completed entry'; end if;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_auth::text, 'role', 'authenticated')::text, true);
  v_entry2 := enter_venue_event(v_ev2);
  set local role service_role;
  select id into v_pay from payments where kind = 'tournament' and subject_id = v_entry2;
  perform payments_begin_charge(v_pay);
  perform payments_mark_held(v_pay, 'zz_sub_13b', 0, null);
  set local role authenticated;
  update venue_event_entries set status = 'cancelled' where id = v_entry2;
  set local role service_role;
  if (select coalesce(sum(amount_cents), 0) from refunds where payment_id = v_pay) <> 4000 then
    raise exception 'FAIL 13e: cancelled paid entry not refunded in full';
  end if;

  -- 14. Court on an owned venue: pending, paid, confirmed; owner completes; release.
  set local role authenticated;
  perform reserve_court(v_court2, v_slot + interval '25 days', 1, 'Single', false);
  set local role service_role;
  select id into v_res from court_reservations where client_id = v_me and court_id = v_court2;
  if (select status from court_reservations where id = v_res) <> 'pending' then raise exception 'FAIL 14: reservation not held pending'; end if;
  select id into v_pay from payments where kind = 'court' and subject_id = v_res;
  if v_pay is null or (select payee_id from payments where id = v_pay) <> v_owner then
    raise exception 'FAIL 14b: no court payment to the venue owner';
  end if;
  perform payments_begin_charge(v_pay);
  perform payments_mark_held(v_pay, 'zz_sub_14', 0, null);
  if (select status from court_reservations where id = v_res) <> 'confirmed' then raise exception 'FAIL 14c: reservation not confirmed after payment'; end if;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_auth::text, 'role', 'authenticated')::text, true);
  update court_reservations set status = 'completed' where id = v_res;
  set local role service_role;
  if not exists (select 1 from payment_releases where payment_id = v_pay) then raise exception 'FAIL 14d: no release on a completed reservation'; end if;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_auth::text, 'role', 'authenticated')::text, true);

  -- 15. Paid event: RSVP opens a payment to the community owner; leaving unpaid cancels it; leaving paid refunds the fee.
  set local role service_role;
  insert into communities (slug, name, code) values ('zz-pay-comm', 'ZZ Pay Comm', 'ZZPAY1') returning id into v_comm;
  insert into community_members (community_id, user_id, role) values (v_comm, v_coach, 'owner')
    on conflict (community_id, user_id) do update set role = 'owner';
  insert into community_members (community_id, user_id, role) values (v_comm, v_me, 'member')
    on conflict (community_id, user_id) do nothing;
  insert into events (community_id, title, fee_cents, created_by) values (v_comm, 'ZZ paid event', 2500, v_coach) returning id into v_event;
  set local role authenticated;
  perform rsvp_to_event(v_event, true);
  set local role service_role;
  select id into v_pay from payments where kind = 'event' and subject_id = v_event and payer_id = v_me;
  if v_pay is null then raise exception 'FAIL 15: no event payment opened'; end if;
  if (select payee_id from payments where id = v_pay) <> v_coach then raise exception 'FAIL 15b: event payee is not the community owner'; end if;
  set local role authenticated;
  perform rsvp_to_event(v_event, false);
  set local role service_role;
  if (select status from payments where id = v_pay) <> 'cancelled' then raise exception 'FAIL 15c: leaving unpaid did not cancel the payment'; end if;
  set local role authenticated;
  perform rsvp_to_event(v_event, true);
  set local role service_role;
  select id into v_pay from payments where kind = 'event' and subject_id = v_event and payer_id = v_me and status = 'awaiting_payment';
  perform payments_begin_charge(v_pay);
  perform payments_mark_held(v_pay, 'zz_sub_15', 0, null);
  if (select payment from event_attendees where event_id = v_event and user_id = v_me) <> 'paid' then raise exception 'FAIL 15d: attendee not marked paid'; end if;
  set local role authenticated;
  perform rsvp_to_event(v_event, false);
  set local role service_role;
  if (select coalesce(sum(amount_cents), 0) from refunds where payment_id = v_pay) <> 2500 then
    raise exception 'FAIL 15e: leaving a paid event did not refund the fee';
  end if;

  -- 16. Cancelling a paid pack with no completed session refunds its full price and cancels its sessions.
  set local role authenticated;
  perform book_package_sessions(v_coach, v_pkg4, jsonb_build_array(
    jsonb_build_object('at', v_slot + interval '60 days', 'label', 'A'),
    jsonb_build_object('at', v_slot + interval '61 days', 'label', 'B')));
  set local role service_role;
  select payment_id into v_pay from bookings where client_id = v_me and package_id = v_pkg4 and payment_id is not null limit 1;
  perform payments_begin_charge(v_pay);
  perform payments_mark_held(v_pay, 'zz_sub_16', 0, null);
  set local role authenticated;
  perform cancel_unused_package(v_coach, v_pkg4);
  set local role service_role;
  if (select coalesce(sum(amount_cents), 0) from refunds where payment_id = v_pay) <> 20000 then
    raise exception 'FAIL 16: unused pack not refunded in full';
  end if;
  if exists (select 1 from bookings where client_id = v_me and package_id = v_pkg4 and status <> 'cancelled') then
    raise exception 'FAIL 16b: a session of the cancelled pack is still live';
  end if;

  -- 17. A paid single session: the coach and then the client confirm it happened; it completes and releases once.
  set local role authenticated;
  v_booking := create_booking_for_coach(v_coach, v_slot + interval '70 days', 'ZZ confirm', null, null);
  set local role service_role;
  select id into v_pay from payments where kind = 'session' and subject_id = v_booking;
  perform payments_begin_charge(v_pay);
  perform payments_mark_held(v_pay, 'zz_sub_17', 0, null);
  update bookings set scheduled_for = now() - interval '4 days' where id = v_booking;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_coach_auth::text, 'role', 'authenticated')::text, true);
  perform confirm_session_fulfilled(v_booking);
  set local role service_role;
  if (select status from bookings where id = v_booking) <> 'confirmed' or exists (select 1 from payment_releases where payment_id = v_pay) then
    raise exception 'FAIL 17: one confirmation completed or released the session';
  end if;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_auth::text, 'role', 'authenticated')::text, true);
  perform confirm_session_fulfilled(v_booking);
  set local role service_role;
  if (select status from bookings where id = v_booking) <> 'completed' then raise exception 'FAIL 17b: both confirmations did not complete the session'; end if;
  select count(*) into v_n from payment_releases where payment_id = v_pay and subject_id = v_booking;
  if v_n <> 1 then raise exception 'FAIL 17c: % releases after both confirmed, expected 1', v_n; end if;

  -- 18. A negotiated cancellation that refunds less than what is held releases the remainder to the coach.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_auth::text, 'role', 'authenticated')::text, true);
  perform book_package_sessions(v_coach, v_pkg5, jsonb_build_array(
    jsonb_build_object('at', v_slot + interval '80 days', 'label', 'A'),
    jsonb_build_object('at', v_slot + interval '81 days', 'label', 'B')));
  set local role service_role;
  select payment_id into v_pay from bookings where client_id = v_me and package_id = v_pkg5 and payment_id is not null limit 1;
  perform payments_begin_charge(v_pay);
  perform payments_mark_held(v_pay, 'zz_sub_18', 0, null);
  update bookings set status = 'completed' where client_id = v_me and package_id = v_pkg5 and slot_label = 'A';
  if (select amount_cents from payment_releases where payment_id = v_pay) <> 5000 then raise exception 'FAIL 18: per-session release'; end if;
  insert into package_cancellations (client_id, coach_id, package_id, status, refund_cents)
  values (v_me, v_coach, v_pkg5, 'approved', 9000) returning id into v_cancel;
  if (select coalesce(sum(amount_cents), 0) from refunds where payment_id = v_pay) <> 9000 then
    raise exception 'FAIL 18b: refund is not the 9000 approved';
  end if;
  if not exists (select 1 from payment_releases where payment_id = v_pay and subject_id = v_cancel and amount_cents = 6000) then
    raise exception 'FAIL 18c: the unrefunded 6000 was not released to the coach (releases: %)',
      (select string_agg(amount_cents::text, ',') from payment_releases where payment_id = v_pay);
  end if;
  if private.payment_unallocated(v_pay) <> 0 then raise exception 'FAIL 18d: money still unallocated'; end if;
  if not exists (select 1 from payment_releases r join payments p on p.id = r.payment_id
                  where r.payment_id = v_pay and r.subject_id = v_cancel
                    and r.commission_cents = round(6000 * p.rate_bps / 10000.0)::int) then
    raise exception 'FAIL 18e: commission on the remainder is not 6000 at the payment rate';
  end if;

  -- 19. A free cancel refunds what was paid, not today's listing price, and releases nothing to the coach.
  set local role authenticated;
  perform book_package_sessions(v_coach, v_pkg6, jsonb_build_array(
    jsonb_build_object('at', v_slot + interval '90 days', 'label', 'A')));
  set local role service_role;
  select payment_id into v_pay from bookings where client_id = v_me and package_id = v_pkg6 and payment_id is not null limit 1;
  if (select price_cents from payments where id = v_pay) <> 20000 then raise exception 'FAIL 19: pack payment is not 20000'; end if;
  perform payments_begin_charge(v_pay);
  perform payments_mark_held(v_pay, 'zz_sub_19', 0, null);
  update packages set price_cents = 15000 where id = v_pkg6;
  set local role authenticated;
  select c.id into v_cancel from cancel_unused_package(v_coach, v_pkg6) c;
  set local role service_role;
  if (select refund_cents from package_cancellations where id = v_cancel) <> 20000 then
    raise exception 'FAIL 19b: cancellation recorded %, expected the 20000 paid', (select refund_cents from package_cancellations where id = v_cancel);
  end if;
  if (select coalesce(sum(amount_cents), 0) from refunds where payment_id = v_pay) <> 20000 then
    raise exception 'FAIL 19c: refund is not the 20000 paid';
  end if;
  if exists (select 1 from payment_releases where payment_id = v_pay) then
    raise exception 'FAIL 19d: a cancelled unused pack released money to the coach';
  end if;

  -- 20. Members cannot write attendance or fees directly; leaving refunds the price paid, not the row's fee.
  declare v_ev20 uuid; v_p20 uuid;
  begin
    set local role service_role;
    insert into events (community_id, title, fee_cents, created_by, starts_at)
    values (v_comm, 'ZZ tamper event', 2500, v_coach, now() + interval '5 days') returning id into v_ev20;
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', v_auth::text, 'role', 'authenticated')::text, true);
    perform rsvp_to_event(v_ev20, true);
    begin
      update event_attendees set payment = 'refunded' where event_id = v_ev20 and user_id = v_me;
      raise exception 'FAIL 20: member updated their own attendance payment';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into event_attendees (event_id, user_id, payment, fee_cents) values (v_event, v_me, 'paid', 0);
      raise exception 'FAIL 20b: member inserted a paid attendance';
    exception when insufficient_privilege then null;
    end;
    set local role service_role;
    select id into v_p20 from payments where kind = 'event' and subject_id = v_ev20 and payer_id = v_me and status = 'awaiting_payment';
    perform payments_begin_charge(v_p20);
    perform payments_mark_held(v_p20, 'zz_sub_20', 0, null);
    update event_attendees set fee_cents = 1 where event_id = v_ev20 and user_id = v_me;
    set local role authenticated;
    perform rsvp_to_event(v_ev20, false);
    set local role service_role;
    if (select coalesce(sum(amount_cents), 0) from refunds where payment_id = v_p20) <> 2500 then
      raise exception 'FAIL 20c: leaving refunded % instead of the 2500 paid', (select coalesce(sum(amount_cents), 0) from refunds where payment_id = v_p20);
    end if;
  end;

  -- 21. No refund once the service has started: a session that began, an event that began.
  declare v_b21 uuid; v_p21 uuid; v_ev21 uuid; v_ev21b uuid;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', v_auth::text, 'role', 'authenticated')::text, true);
    v_b21 := create_booking_for_coach(v_coach, v_slot + interval '100 days', 'ZZ started', null, null);
    set local role service_role;
    select id into v_p21 from payments where kind = 'session' and subject_id = v_b21;
    perform payments_begin_charge(v_p21);
    perform payments_mark_held(v_p21, 'zz_sub_21', 0, null);
    update bookings set scheduled_for = now() - interval '1 hour' where id = v_b21;
    set local role authenticated;
    begin
      update bookings set status = 'cancelled' where id = v_b21;
      raise exception 'FAIL 21: client cancelled a session that had started';
    exception when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'FAIL%' then raise; end if;
      if v_err <> 'This session has already started.' then raise exception 'FAIL 21b: %', v_err; end if;
    end;
    set local role service_role;
    if exists (select 1 from refunds where payment_id = v_p21) then raise exception 'FAIL 21c: started session refunded'; end if;

    insert into events (community_id, title, fee_cents, created_by, starts_at)
    values (v_comm, 'ZZ started event', 2500, v_coach, now() - interval '1 minute') returning id into v_ev21;
    insert into events (community_id, title, fee_cents, created_by, starts_at)
    values (v_comm, 'ZZ future event', 2500, v_coach, now() + interval '1 day') returning id into v_ev21b;
    set local role authenticated;
    perform rsvp_to_event(v_ev21, true);
    perform rsvp_to_event(v_ev21b, true);
    set local role service_role;
    select id into v_p21 from payments where kind = 'event' and subject_id = v_ev21 and payer_id = v_me;
    perform payments_begin_charge(v_p21);
    perform payments_mark_held(v_p21, 'zz_sub_21b', 0, null);
    set local role authenticated;
    begin
      perform rsvp_to_event(v_ev21, false);
      raise exception 'FAIL 21d: left a paid event after it started';
    exception when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'FAIL%' then raise; end if;
      if v_err <> 'This event has already started.' then raise exception 'FAIL 21e: %', v_err; end if;
    end;
    set local role service_role;
    if exists (select 1 from refunds where payment_id = v_p21) then raise exception 'FAIL 21f: started event refunded'; end if;
    select id into v_p21 from payments where kind = 'event' and subject_id = v_ev21b and payer_id = v_me;
    perform payments_begin_charge(v_p21);
    perform payments_mark_held(v_p21, 'zz_sub_21c', 0, null);
    set local role authenticated;
    perform rsvp_to_event(v_ev21b, false);
    set local role service_role;
    if (select coalesce(sum(amount_cents), 0) from refunds where payment_id = v_p21) <> 2500 then
      raise exception 'FAIL 21g: leaving a future paid event did not refund';
    end if;
  end;

  -- 22. A paid event's start cannot move into the past; removing the event refunds paid attendees.
  declare v_ev22 uuid; v_p22 uuid;
  begin
    set local role service_role;
    insert into events (community_id, title, fee_cents, created_by, starts_at)
    values (v_comm, 'ZZ removed event', 2500, v_coach, now() + interval '3 days') returning id into v_ev22;
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', v_auth::text, 'role', 'authenticated')::text, true);
    perform rsvp_to_event(v_ev22, true);
    set local role service_role;
    select id into v_p22 from payments where kind = 'event' and subject_id = v_ev22 and payer_id = v_me;
    perform payments_begin_charge(v_p22);
    perform payments_mark_held(v_p22, 'zz_sub_22', 0, null);
    begin
      update events set starts_at = now() - interval '2 days' where id = v_ev22;
      raise exception 'FAIL 22: paid event moved into the past';
    exception when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'FAIL%' then raise; end if;
      if v_err <> 'This event has paid attendees; its start cannot be moved into the past.' then raise exception 'FAIL 22b: %', v_err; end if;
    end;
    update events set starts_at = now() + interval '4 days' where id = v_ev22;
    delete from events where id = v_ev22;
    if (select coalesce(sum(amount_cents), 0) from refunds where payment_id = v_p22) <> 2500 then
      raise exception 'FAIL 22c: removing a paid event did not refund the attendee';
    end if;
  end;

  -- 23. A coach cannot confirm a booking that is not paid, or complete a session before it starts.
  declare v_b23 uuid; v_p23 uuid;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', v_auth::text, 'role', 'authenticated')::text, true);
    v_b23 := create_booking_for_coach(v_coach, v_slot + interval '110 days', 'ZZ early', null, null);
    perform set_config('request.jwt.claims', json_build_object('sub', v_coach_auth::text, 'role', 'authenticated')::text, true);
    begin
      update bookings set status = 'confirmed' where id = v_b23;
      raise exception 'FAIL 23: coach confirmed an unpaid booking';
    exception when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'FAIL%' then raise; end if;
      if v_err <> 'This booking has not been paid for yet.' then raise exception 'FAIL 23b: %', v_err; end if;
    end;
    set local role service_role;
    select id into v_p23 from payments where kind = 'session' and subject_id = v_b23;
    perform payments_begin_charge(v_p23);
    perform payments_mark_held(v_p23, 'zz_sub_23', 0, null);
    set local role authenticated;
    begin
      update bookings set status = 'completed' where id = v_b23;
      raise exception 'FAIL 23c: coach completed a session before it started';
    exception when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'FAIL%' then raise; end if;
      if v_err <> 'That session has not started yet.' then raise exception 'FAIL 23d: %', v_err; end if;
    end;
    perform set_config('request.jwt.claims', json_build_object('sub', v_auth::text, 'role', 'authenticated')::text, true);
  end;

  -- 24. Paying yourself opens nothing: the owner's own court is confirmed, the community owner joins free.
  declare v_res24 uuid; v_ev24 uuid;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner_auth::text, 'role', 'authenticated')::text, true);
    v_res24 := reserve_court(v_court2, v_slot + interval '120 days', 1, 'Single', false);
    set local role service_role;
    if (select status from court_reservations where id = v_res24) <> 'confirmed' then
      raise exception 'FAIL 24: owner''s own reservation is %', (select status from court_reservations where id = v_res24);
    end if;
    if exists (select 1 from payments where subject_id = v_res24) then raise exception 'FAIL 24b: a payment opened for the owner''s own court'; end if;
    insert into events (community_id, title, fee_cents, created_by, starts_at)
    values (v_comm, 'ZZ own event', 2500, v_coach, now() + interval '3 days') returning id into v_ev24;
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', v_coach_auth::text, 'role', 'authenticated')::text, true);
    perform rsvp_to_event(v_ev24, true);
    set local role service_role;
    if (select payment from event_attendees where event_id = v_ev24 and user_id = v_coach) <> 'not_required' then
      raise exception 'FAIL 24c: owner of the community is pending on their own event';
    end if;
    if exists (select 1 from payments where subject_id = v_ev24) then raise exception 'FAIL 24d: a payment opened for the owner''s own event'; end if;
  end;

  raise exception 'ALL PAYMENTS SUBJECT CHECKS PASSED';
end $$;
