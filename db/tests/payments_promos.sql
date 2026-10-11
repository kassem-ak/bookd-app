-- Promo codes at checkout. Passes when it raises 'ALL PAYMENTS PROMO CHECKS PASSED'.
do $$
declare
  v_auth uuid := gen_random_uuid(); v_c1_auth uuid := gen_random_uuid(); v_c2_auth uuid := gen_random_uuid();
  v_me uuid; v_c1 uuid; v_c2 uuid; v_booking uuid; v_pay uuid; v_pay1 uuid; v_pay3 uuid; v_rel uuid;
  v_slot timestamptz := date_trunc('day', now()) + interval '3 days' + interval '10 hours';
  v_q record; v_p payments; v_err text; v_rate int;
  v_pay_a uuid; v_pay_b uuid; v_disp uuid; v_venue uuid; v_court uuid; v_res uuid; v_pkg uuid;
begin
  insert into auth.users (id) values (v_auth), (v_c1_auth), (v_c2_auth);
  set local role service_role;
  select id into v_me from users where auth_id = v_auth;
  select id into v_c1 from users where auth_id = v_c1_auth;
  select id into v_c2 from users where auth_id = v_c2_auth;
  insert into coach_profiles (user_id, headline, price_cents) values (v_c1, 'ZZ promo coach 1', 10000), (v_c2, 'ZZ promo coach 2', 10000);
  insert into coach_promos (coach_id, code, pct) values (v_c1, 'COACH20', 20), (v_c2, 'ZZFREE', 100);
  insert into platform_promos (code, pct, audience) values ('WELCOME50', 50, 'all'), ('NEWBIE', 10, 'new'), ('FREE100', 100, 'all'),
    ('TWICE10', 10, 'all'), ('FREE100B', 100, 'all'), ('PACKFREE', 100, 'all'), ('PACKHALF', 50, 'all');
  insert into packages (coach_id, sessions, price_cents, active) values (v_c1, 4, 20000, true) returning id into v_pkg;
  insert into venues (slug, name, city, sport, status, equipment_cents_per_hour, timezone, opens_at, closes_at, owner_id)
  values ('zz-promo-venue', 'ZZ Promo Venue', 'Beirut', 'Paddle', 'open', 0, 'UTC', '00:00', '23:59', v_c2) returning id into v_venue;
  insert into courts (venue_id, name, price_cents_per_hour, active) values (v_venue, 'ZZ PROMO COURT', 3000, true) returning id into v_court;
  insert into platform_promos (code, pct, audience, active) values ('ENDED10', 10, 'all', false);
  update payment_settings set enabled_kinds = array['session','package','court'], fee_bps = 300, fee_flat_cents = 0;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_auth::text, 'role', 'authenticated')::text, true);

  -- 1. A coach code on that coach's session: price 8000, discount 2000, fee 240.
  v_booking := create_booking_for_coach(v_c1, v_slot, 'ZZ promo 1', null, null);
  select id into v_pay1 from payments where kind = 'session' and subject_id = v_booking;
  select * into v_q from apply_promo_code(v_pay1, 'COACH20');
  if (v_q.price_cents, v_q.discount_cents, v_q.fee_cents, v_q.total_cents, v_q.promo_kind) is distinct from (8000, 2000, 240, 8240, 'coach') then
    raise exception 'FAIL 1: quote %', row_to_json(v_q);
  end if;
  select * into v_p from payments where id = v_pay1;
  if (v_p.price_cents, v_p.list_price_cents, v_p.discount_cents, v_p.fee_cents) is distinct from (8000, 8000, 2000, 240) then
    raise exception 'FAIL 1b: payment row % / % / % / %', v_p.price_cents, v_p.list_price_cents, v_p.discount_cents, v_p.fee_cents;
  end if;

  -- 2. The same coach code on another coach's session.
  v_booking := create_booking_for_coach(v_c2, v_slot, 'ZZ promo 2', null, null);
  select id into v_pay from payments where kind = 'session' and subject_id = v_booking;
  begin
    perform apply_promo_code(v_pay, 'COACH20');
    raise exception 'FAIL 2: coach code accepted for another coach';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'That code is for a different coach.' then raise exception 'FAIL 2b: %', v_err; end if;
  end;

  -- 7. Removing the code restores the original price and fee.
  perform remove_promo_code(v_pay1);
  select * into v_p from payments where id = v_pay1;
  if (v_p.price_cents, v_p.list_price_cents, v_p.discount_cents, v_p.fee_cents, v_p.promo_code) is distinct from (10000, 10000, 0, 300, null::text) then
    raise exception 'FAIL 7: after remove % / % / % / % / %', v_p.price_cents, v_p.list_price_cents, v_p.discount_cents, v_p.fee_cents, v_p.promo_code;
  end if;

  -- 3. A platform code: the member pays 5000, the coach is paid on 10000, the company bears 5000.
  v_booking := create_booking_for_coach(v_c1, v_slot + interval '1 day', 'ZZ promo 3', null, null);
  select id into v_pay3 from payments where kind = 'session' and subject_id = v_booking;
  select * into v_q from apply_promo_code(v_pay3, 'welcome50');
  select * into v_p from payments where id = v_pay3;
  if (v_p.price_cents, v_p.list_price_cents, v_p.discount_cents, v_p.fee_cents, v_p.promo_kind) is distinct from (5000, 10000, 5000, 150, 'platform') then
    raise exception 'FAIL 3: payment row % / % / % / % / %', v_p.price_cents, v_p.list_price_cents, v_p.discount_cents, v_p.fee_cents, v_p.promo_kind;
  end if;
  set local role service_role;
  perform payments_begin_charge(v_pay3);
  perform payments_mark_held(v_pay3, 'zz_promo_3', 0, null);
  if not exists (select 1 from promo_redemptions where payment_id = v_pay3 and user_id = v_me and promo_kind = 'platform') then
    raise exception 'FAIL 3b: no redemption recorded';
  end if;
  update bookings set status = 'completed' where id = v_booking;
  select id into v_rel from payment_releases where payment_id = v_pay3;
  update payment_releases set release_at = now() - interval '1 second' where id = v_rel;
  perform private.release_due();
  select rate_bps into v_rate from payments where id = v_pay3;
  if v_rate <> 1200 then raise exception 'FAIL 3c: rate % (expected 1200)', v_rate; end if;
  if (select balance_cents from ledger_balances where code = 'payee:' || v_c1) <> 10000 - 1200 then
    raise exception 'FAIL 3d: payee balance %', (select balance_cents from ledger_balances where code = 'payee:' || v_c1);
  end if;
  if (select l.amount_cents from ledger_lines l join ledger_entries e on e.id = l.entry_id
       where e.idempotency_key = 'release:' || v_rel and l.account = 'commission_revenue') <> -1200 then
    raise exception 'FAIL 3e: commission is not 1200';
  end if;
  if (select l.amount_cents from ledger_lines l join ledger_entries e on e.id = l.entry_id
       where e.idempotency_key = 'release:' || v_rel and l.account = 'promo_expense') <> 5000 then
    raise exception 'FAIL 3f: promo_expense is not 5000';
  end if;
  if (select balance_cents from ledger_balances where code = 'company_cash')
     <> (select sum(balance_cents) from ledger_balances where kind in ('liability','equity','income'))
      - (select coalesce(sum(balance_cents),0) from ledger_balances where kind = 'expense') then
    raise exception 'FAIL 3g: soft split broken';
  end if;
  if (select amount_cents from payee_payouts where release_id = v_rel) <> 8800 then
    raise exception 'FAIL 3h: payout is not 8800';
  end if;

  -- 8. A held payment cannot change its code.
  set local role authenticated;
  begin
    perform apply_promo_code(v_pay3, 'COACH20');
    raise exception 'FAIL 8: code applied to a held payment';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'This payment can no longer be changed.' then raise exception 'FAIL 8b: %', v_err; end if;
  end;

  -- 4. The same member cannot use the platform code twice.
  begin
    perform apply_promo_code(v_pay1, 'WELCOME50');
    raise exception 'FAIL 4: code used twice';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'You have already used that code.' then raise exception 'FAIL 4b: %', v_err; end if;
  end;

  -- 5. A code for new members: fine while new, refused once the account is 40 days old.
  select * into v_q from apply_promo_code(v_pay1, 'NEWBIE');
  if v_q.price_cents <> 9000 then raise exception 'FAIL 5: NEWBIE price %', v_q.price_cents; end if;
  set local role service_role;
  update users set created_at = now() - interval '40 days' where id = v_me;
  set local role authenticated;
  begin
    perform apply_promo_code(v_pay1, 'NEWBIE');
    raise exception 'FAIL 5b: NEWBIE accepted for an old account';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'That code is not available to your account.' then raise exception 'FAIL 5c: %', v_err; end if;
  end;

  -- 9. An inactive code.
  begin
    perform apply_promo_code(v_pay1, 'ENDED10');
    raise exception 'FAIL 9: inactive code accepted';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'That code does not exist or has ended.' then raise exception 'FAIL 9b: %', v_err; end if;
  end;

  -- 6. A 100% platform code: nothing to pay, captured without a gateway, the coach is still paid.
  v_booking := create_booking_for_coach(v_c1, v_slot + interval '2 days', 'ZZ promo 6', null, null);
  select id into v_pay from payments where kind = 'session' and subject_id = v_booking;
  select * into v_q from apply_promo_code(v_pay, 'FREE100');
  if (v_q.price_cents, v_q.fee_cents, v_q.total_cents) is distinct from (0, 0, 0) then raise exception 'FAIL 6: quote %', row_to_json(v_q); end if;
  set local role service_role;
  if not (select begun from payments_begin_charge(v_pay)) then raise exception 'FAIL 6b: free payment would not start'; end if;
  -- 6b2. A real capture of a free payment is refused.
  begin
    perform payments_mark_held(v_pay, 'zz_not_free', 0, null);
    raise exception 'FAIL 6b2: a real capture of a free payment was accepted';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'This payment is free.' then raise exception 'FAIL 6b2: %', v_err; end if;
  end;
  perform payments_mark_held(v_pay, 'free:' || v_pay, 0, null);
  if (select status from bookings where id = v_booking) <> 'confirmed' then raise exception 'FAIL 6c: free booking not confirmed'; end if;
  update bookings set status = 'completed' where id = v_booking;
  select id into v_rel from payment_releases where payment_id = v_pay;
  if v_rel is null then raise exception 'FAIL 6d: no release for a free session'; end if;
  update payment_releases set release_at = now() - interval '1 second' where id = v_rel;
  perform private.release_due();
  if (select balance_cents from ledger_balances where code = 'payee:' || v_c1) <> 2 * (10000 - 1200) then
    raise exception 'FAIL 6e: payee balance % after the free session', (select balance_cents from ledger_balances where code = 'payee:' || v_c1);
  end if;
  if (select status from payments where id = v_pay) <> 'closed' then raise exception 'FAIL 6f: free payment not closed'; end if;

  -- 6g. A free (100% coach code) session cancelled after capture: no refund, payment closes.
  set local role authenticated;
  v_booking := create_booking_for_coach(v_c2, v_slot + interval '3 days', 'ZZ promo 6g', null, null);
  select id into v_pay from payments where kind = 'session' and subject_id = v_booking;
  perform apply_promo_code(v_pay, 'ZZFREE');
  set local role service_role;
  perform payments_begin_charge(v_pay);
  perform payments_mark_held(v_pay, 'free:' || v_pay, 0, null);
  set local role authenticated;
  update bookings set status = 'cancelled' where id = v_booking;
  set local role service_role;
  if (select status from payments where id = v_pay) <> 'closed' then raise exception 'FAIL 6g: cancelled free payment is %', (select status from payments where id = v_pay); end if;

  -- 10. One code on two open checkouts: the second is refused while the first holds it.
  set local role authenticated;
  v_booking := create_booking_for_coach(v_c1, v_slot + interval '4 days', 'ZZ promo 10a', null, null);
  select id into v_pay_a from payments where kind = 'session' and subject_id = v_booking;
  v_booking := create_booking_for_coach(v_c1, v_slot + interval '5 days', 'ZZ promo 10b', null, null);
  select id into v_pay_b from payments where kind = 'session' and subject_id = v_booking;
  perform apply_promo_code(v_pay_a, 'TWICE10');
  begin
    perform apply_promo_code(v_pay_b, 'TWICE10');
    raise exception 'FAIL 10: one code applied to two open checkouts';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'You have already used that code.' then raise exception 'FAIL 10a: %', v_err; end if;
  end;
  -- 10b. Taking it off the first frees it for the second.
  perform remove_promo_code(v_pay_a);
  select * into v_q from apply_promo_code(v_pay_b, 'TWICE10');
  if v_q.price_cents <> 9000 then raise exception 'FAIL 10b: second checkout price %', v_q.price_cents; end if;

  -- 11. A complaint on a free session decided with no refund still pays the coach the list price.
  v_booking := create_booking_for_coach(v_c1, v_slot + interval '6 days', 'ZZ promo 11', null, null);
  select id into v_pay from payments where kind = 'session' and subject_id = v_booking;
  perform apply_promo_code(v_pay, 'FREE100B');
  set local role service_role;
  perform payments_begin_charge(v_pay);
  perform payments_mark_held(v_pay, 'free:' || v_pay, 0, null);
  update bookings set status = 'completed' where id = v_booking;
  select id into v_rel from payment_releases where payment_id = v_pay;
  set local role authenticated;
  v_disp := raise_dispute(v_rel, 'ZZ complaint on a free session');
  set local role service_role;
  perform resolve_dispute(v_disp, 0, v_c1);
  if (select status from payment_releases where id = v_rel) <> 'released' then
    raise exception 'FAIL 11: zero release after a 0 refund is %', (select status from payment_releases where id = v_rel);
  end if;
  if (select balance_cents from ledger_balances where code = 'payee:' || v_c1) <> 3 * (10000 - 1200) then
    raise exception 'FAIL 11b: payee balance % after the disputed free session', (select balance_cents from ledger_balances where code = 'payee:' || v_c1);
  end if;

  -- 12. Members see their own redemptions.
  set local role authenticated;
  if (select count(*) from promo_redemptions) <> 4 then raise exception 'FAIL 12: member sees % redemptions', (select count(*) from promo_redemptions); end if;

  -- 13. A coach code on a court checkout.
  perform reserve_court(v_court, v_slot + interval '7 days', 1, 'Single', false);
  select id into v_res from court_reservations where court_id = v_court;
  select id into v_pay from payments where kind = 'court' and subject_id = v_res;
  begin
    perform apply_promo_code(v_pay, 'COACH20');
    raise exception 'FAIL 13: coach code accepted on a court';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'That code only works for coach sessions.' then raise exception 'FAIL 13b: %', v_err; end if;
  end;

  -- 14. Codes are unique regardless of case.
  set local role service_role;
  begin
    insert into platform_promos (code, pct) values ('welcome50', 5);
    raise exception 'FAIL 14: platform code duplicated by case';
  exception when unique_violation then null;
  end;
  begin
    insert into coach_promos (coach_id, code, pct) values (v_c1, 'coach20', 5);
    raise exception 'FAIL 14b: coach code duplicated by case';
  exception when unique_violation then null;
  end;

  -- 15. A 100% code cannot make a session pack free; a 50% code still applies.
  set local role authenticated;
  perform book_package_sessions(v_c1, v_pkg, jsonb_build_array(
    jsonb_build_object('at', v_slot + interval '8 days', 'label', 'A')));
  select payment_id into v_pay from bookings where client_id = v_me and package_id = v_pkg and payment_id is not null limit 1;
  begin
    perform apply_promo_code(v_pay, 'PACKFREE');
    raise exception 'FAIL 15: a 100%% code made a pack free';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err <> 'A 100% code cannot be used on a session pack.' then raise exception 'FAIL 15b: %', v_err; end if;
  end;
  select * into v_q from apply_promo_code(v_pay, 'PACKHALF');
  if (v_q.price_cents, v_q.discount_cents) is distinct from (10000, 10000) then raise exception 'FAIL 15c: pack quote %', row_to_json(v_q); end if;

  -- 16. Every ledger entry posted above balances (the check is deferred to commit; fire it now).
  set constraints all immediate;

  raise exception 'ALL PAYMENTS PROMO CHECKS PASSED';
end $$;
