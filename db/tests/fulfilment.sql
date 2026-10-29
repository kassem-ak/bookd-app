-- Fulfilment and free cancel. Passes when it raises 'ALL FULFILMENT CHECKS PASSED'.
-- Needs migration 2026-09-22_fulfilment_and_free_cancel. Everything rolls back.
do $$
declare
  v_me_auth uuid := gen_random_uuid(); v_coach_auth uuid := gen_random_uuid(); v_x_auth uuid := gen_random_uuid();
  v_me uuid; v_coach uuid;
  v_pkg uuid; v_pkg2 uuid; v_pkg3 uuid;
  v_b uuid; v_future uuid; v_cancelled uuid; v_pending uuid; v_restore uuid;
  v_past timestamptz := now() - interval '2 days';
  v_t timestamptz := timestamptz '2020-01-01 00:00+00';
  v_err text; v_status text; v_n int; v_c boolean; v_k boolean; v_cancel_id uuid; v_refund int;
begin
  insert into auth.users (id) values (v_me_auth), (v_coach_auth), (v_x_auth);
  set local role service_role;
  select id into v_me from users where auth_id = v_me_auth;
  select id into v_coach from users where auth_id = v_coach_auth;
  insert into coach_profiles (user_id, headline, price_cents) values (v_coach, 'ZZ fulfil coach', 5000);
  insert into packages (coach_id, sessions, price_cents, active) values (v_coach, 4, 20000, true) returning id into v_pkg;
  insert into packages (coach_id, sessions, price_cents, active) values (v_coach, 4, 20000, true) returning id into v_pkg2;
  insert into packages (coach_id, sessions, price_cents, active) values (v_coach, 4, 20000, true) returning id into v_pkg3;
  insert into bookings (client_id, coach_id, scheduled_for, slot_label, status)
    values (v_me, v_coach, v_past, 'ZZ past', 'confirmed') returning id into v_b;
  insert into bookings (client_id, coach_id, scheduled_for, slot_label, status)
    values (v_me, v_coach, now() + interval '2 days', 'ZZ future', 'confirmed') returning id into v_future;
  insert into bookings (client_id, coach_id, scheduled_for, slot_label, status)
    values (v_me, v_coach, v_past, 'ZZ cancelled', 'cancelled') returning id into v_cancelled;

  -- 1. The coach confirms, the client has not: it stays confirmed.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_coach_auth::text, 'role', 'authenticated')::text, true);
  select f.status, f.coach_confirmed, f.client_confirmed into v_status, v_c, v_k from confirm_session_fulfilled(v_b) f;
  if v_status <> 'confirmed' or not v_c or v_k then raise exception 'FAIL 1: after coach only: status %, coach %, client %', v_status, v_c, v_k; end if;
  if (select status from bookings where id = v_b) <> 'confirmed' then raise exception 'FAIL 1b: stored status moved'; end if;
  set local role service_role;
  select count(*) into v_n from notifications where user_id = v_me and title like '% confirmed your session happened';
  if v_n <> 1 then raise exception 'FAIL 1c: % notifications to the client, expected 1', v_n; end if;

  -- 2. The client then confirms: completed (the client could never write that on their own).
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_me_auth::text, 'role', 'authenticated')::text, true);
  select f.status, f.coach_confirmed, f.client_confirmed into v_status, v_c, v_k from confirm_session_fulfilled(v_b) f;
  if v_status <> 'completed' or not v_c or not v_k then raise exception 'FAIL 2: after both: status %, coach %, client %', v_status, v_c, v_k; end if;
  if (select status from bookings where id = v_b) <> 'completed' then raise exception 'FAIL 2b: stored status is not completed'; end if;
  set local role service_role;
  select count(*) into v_n from notifications where user_id = v_coach and title = 'Session confirmed by both of you';
  if v_n <> 1 then raise exception 'FAIL 2c: % settled notifications to the coach, expected 1', v_n; end if;

  -- 3. Confirming twice does not move the stamp. now() is frozen in a transaction, so
  -- pin each stamp to a past date first and see that it survives a second confirm.
  update bookings set coach_confirmed_at = v_t, client_confirmed_at = v_t where id = v_b;
  set local role authenticated;
  perform confirm_session_fulfilled(v_b);
  perform set_config('request.jwt.claims', json_build_object('sub', v_coach_auth::text, 'role', 'authenticated')::text, true);
  perform confirm_session_fulfilled(v_b);
  set local role service_role;
  if exists (select 1 from bookings where id = v_b and (coach_confirmed_at <> v_t or client_confirmed_at <> v_t)) then
    raise exception 'FAIL 3: a second confirmation moved a stamp';
  end if;
  if (select status from bookings where id = v_b) <> 'completed' then raise exception 'FAIL 3b: second confirmation changed the status'; end if;

  -- 4. A stranger is refused.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_x_auth::text, 'role', 'authenticated')::text, true);
  begin
    perform confirm_session_fulfilled(v_b);
    raise exception 'FAIL 4: a stranger confirmed a session';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'That session is not yours.' then raise exception 'FAIL 4b: %', v_err; end if;
  end;

  -- 5. Confirming before scheduled_for is refused, for both parties.
  perform set_config('request.jwt.claims', json_build_object('sub', v_me_auth::text, 'role', 'authenticated')::text, true);
  begin
    perform confirm_session_fulfilled(v_future);
    raise exception 'FAIL 5: confirmed a session that has not started';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'That session has not started yet.' then raise exception 'FAIL 5b: %', v_err; end if;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_coach_auth::text, 'role', 'authenticated')::text, true);
  begin
    perform confirm_session_fulfilled(v_future);
    raise exception 'FAIL 5c: the coach confirmed a session that has not started';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'That session has not started yet.' then raise exception 'FAIL 5d: %', v_err; end if;
  end;

  -- 6. Confirming a cancelled session is refused.
  begin
    perform confirm_session_fulfilled(v_cancelled);
    raise exception 'FAIL 6: confirmed a cancelled session';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'That session was cancelled.' then raise exception 'FAIL 6b: %', v_err; end if;
  end;

  -- 7. Cancelling a pack with nothing completed: approved at the full price, live sessions cancelled.
  set local role service_role;
  insert into bookings (client_id, coach_id, package_id, scheduled_for, slot_label, status)
  values (v_me, v_coach, v_pkg, now() + interval '5 days', 'A', 'confirmed'),
         (v_me, v_coach, v_pkg, now() + interval '6 days', 'B', 'pending');
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_me_auth::text, 'role', 'authenticated')::text, true);
  select c.id, c.refund_cents into v_cancel_id, v_refund from cancel_unused_package(v_coach, v_pkg) c;
  if v_refund <> 20000 then raise exception 'FAIL 7: refund %, expected the full 20000', v_refund; end if;
  set local role service_role;
  if not exists (select 1 from package_cancellations where id = v_cancel_id and status = 'approved'
                    and refund_cents = 20000 and decided_by = v_me and client_id = v_me and package_id = v_pkg) then
    raise exception 'FAIL 7b: no approved full-price cancellation row';
  end if;
  if exists (select 1 from bookings where package_id = v_pkg and status <> 'cancelled') then
    raise exception 'FAIL 7c: a session of the cancelled pack is still live';
  end if;

  -- 8. Cancelling a pack with one completed session is refused, pointing at the ask.
  insert into bookings (client_id, coach_id, package_id, scheduled_for, slot_label, status)
  values (v_me, v_coach, v_pkg2, now() - interval '3 days', 'A', 'completed'),
         (v_me, v_coach, v_pkg2, now() + interval '7 days', 'B', 'confirmed');
  set local role authenticated;
  begin
    perform cancel_unused_package(v_coach, v_pkg2);
    raise exception 'FAIL 8: cancelled a pack with a completed session';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err not like '%Ask to cancel instead%' then raise exception 'FAIL 8b: %', v_err; end if;
  end;
  set local role service_role;
  select count(*) into v_n from package_cancellations where package_id = v_pkg2;
  if v_n <> 0 then raise exception 'FAIL 8c: % cancellation rows written for a used pack', v_n; end if;
  if (select count(*) from bookings where package_id = v_pkg2 and status = 'confirmed') <> 1 then
    raise exception 'FAIL 8d: a refused cancel still touched the sessions';
  end if;

  -- 9. Cancelling twice is refused and leaves one open request.
  insert into bookings (client_id, coach_id, package_id, scheduled_for, slot_label, status)
  values (v_me, v_coach, v_pkg3, now() + interval '8 days', 'A', 'confirmed');
  set local role authenticated;
  perform cancel_unused_package(v_coach, v_pkg3);
  begin
    perform cancel_unused_package(v_coach, v_pkg3);
    raise exception 'FAIL 9: cancelled the same pack twice';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'There is already a cancellation open on that package.' then raise exception 'FAIL 9b: %', v_err; end if;
  end;
  set local role service_role;
  select count(*) into v_n from package_cancellations where package_id = v_pkg3 and status in ('requested', 'offered', 'approved');
  if v_n <> 1 then raise exception 'FAIL 9c: % open requests, expected 1', v_n; end if;

  -- 10. A pending session cannot be confirmed, by either side. With payments off it is
  -- waiting on the coach; with payments on it is unpaid.
  set local role service_role;
  insert into bookings (client_id, coach_id, scheduled_for, slot_label, status)
  values (v_me, v_coach, now() - interval '5 days', 'ZZ pending', 'pending') returning id into v_pending;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_coach_auth::text, 'role', 'authenticated')::text, true);
  begin
    perform confirm_session_fulfilled(v_pending);
    raise exception 'FAIL 10: the coach confirmed an unpaid session';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'This session has not been confirmed by the coach yet.' then raise exception 'FAIL 10b: %', v_err; end if;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_me_auth::text, 'role', 'authenticated')::text, true);
  begin
    perform confirm_session_fulfilled(v_pending);
    raise exception 'FAIL 10c: the client confirmed an unpaid session';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'This session has not been confirmed by the coach yet.' then raise exception 'FAIL 10d: %', v_err; end if;
  end;
  set local role service_role;
  if exists (select 1 from bookings where id = v_pending and (status <> 'pending' or coach_confirmed_at is not null or client_confirmed_at is not null)) then
    raise exception 'FAIL 10e: a refused confirmation still touched the booking';
  end if;
  update payment_settings set enabled_kinds = array['session'];
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_coach_auth::text, 'role', 'authenticated')::text, true);
  begin
    perform confirm_session_fulfilled(v_pending);
    raise exception 'FAIL 10f: the coach confirmed an unpaid session with payments on';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'This session has not been paid for yet.' then raise exception 'FAIL 10g: %', v_err; end if;
  end;
  set local role service_role;
  update payment_settings set enabled_kinds = '{}';

  -- 11. Nobody books themselves: a direct insert and the booking RPC both refuse.
  begin
    insert into bookings (client_id, coach_id, scheduled_for, slot_label, status)
    values (v_coach, v_coach, now() + interval '9 days', 'ZZ self', 'confirmed');
    raise exception 'FAIL 11: a coach booked themselves';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'You cannot book a session with yourself.' then raise exception 'FAIL 11b: %', v_err; end if;
  end;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_coach_auth::text, 'role', 'authenticated')::text, true);
  begin
    perform create_booking_for_coach(v_coach, now() + interval '10 days', 'ZZ self rpc', null, null);
    raise exception 'FAIL 11c: a coach booked themselves through the RPC';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'You cannot book a session with yourself.' then raise exception 'FAIL 11d: %', v_err; end if;
  end;

  -- 12. The completion write puts app.payments_internal back as it found it.
  set local role service_role;
  insert into bookings (client_id, coach_id, scheduled_for, slot_label, status)
  values (v_me, v_coach, now() - interval '6 days', 'ZZ restore', 'confirmed') returning id into v_restore;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_coach_auth::text, 'role', 'authenticated')::text, true);
  perform confirm_session_fulfilled(v_restore);
  perform set_config('request.jwt.claims', json_build_object('sub', v_me_auth::text, 'role', 'authenticated')::text, true);
  perform set_config('app.payments_internal', 'on', true);
  perform confirm_session_fulfilled(v_restore);
  if current_setting('app.payments_internal', true) is distinct from 'on' then
    raise exception 'FAIL 12: the flag was left at %, the caller had it on', current_setting('app.payments_internal', true);
  end if;
  perform set_config('app.payments_internal', 'off', true);
  set local role service_role;
  if (select status from bookings where id = v_restore) <> 'completed' then raise exception 'FAIL 12b: not completed'; end if;
  -- and from off it ends off
  insert into bookings (client_id, coach_id, scheduled_for, slot_label, status)
  values (v_me, v_coach, now() - interval '7 days', 'ZZ restore off', 'confirmed') returning id into v_restore;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_coach_auth::text, 'role', 'authenticated')::text, true);
  perform confirm_session_fulfilled(v_restore);
  perform set_config('request.jwt.claims', json_build_object('sub', v_me_auth::text, 'role', 'authenticated')::text, true);
  perform confirm_session_fulfilled(v_restore);
  if coalesce(current_setting('app.payments_internal', true), 'off') not in ('off', '') then
    raise exception 'FAIL 12c: the flag was left on';
  end if;

  -- 13. A pack whose only session is in the past and nobody marked it done is refused
  -- with the negotiation message, not the booking guard's 'already started'.
  set local role service_role;
  insert into packages (coach_id, sessions, price_cents, active) values (v_coach, 4, 20000, true) returning id into v_pkg;
  insert into bookings (client_id, coach_id, package_id, scheduled_for, slot_label, status)
  values (v_me, v_coach, v_pkg, now() - interval '1 day', 'ZZ past unmarked', 'confirmed');
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_me_auth::text, 'role', 'authenticated')::text, true);
  begin
    perform cancel_unused_package(v_coach, v_pkg);
    raise exception 'FAIL 13: cancelled a pack with a past unmarked session';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err not like '%Ask to cancel instead%' then raise exception 'FAIL 13b: %', v_err; end if;
  end;
  set local role service_role;
  if (select status from bookings where package_id = v_pkg) <> 'confirmed' then
    raise exception 'FAIL 13c: a refused cancel touched the session';
  end if;

  raise exception 'ALL FULFILMENT CHECKS PASSED';
end $$;
