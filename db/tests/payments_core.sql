-- Payment tables and member rules. Passes when it raises 'ALL PAYMENTS CORE CHECKS PASSED'.
do $$
declare
  v_auth uuid := gen_random_uuid(); v_auth2 uuid := gen_random_uuid();
  v_me uuid; v_other uuid; v_m1 uuid; v_m2 uuid; v_m3 uuid; v_err text; v_n int;
begin
  insert into auth.users (id) values (v_auth), (v_auth2);
  set local role service_role;
  select id into v_me from users where auth_id = v_auth;
  select id into v_other from users where auth_id = v_auth2;

  insert into payment_methods (user_id, kind, provider, token, display, can_pay, can_receive, default_pay, default_receive)
  values (v_me, 'card', 'test', 'tok_a', 'Visa ·· 4242', true, false, true, false) returning id into v_m1;
  insert into payment_methods (user_id, kind, provider, token, display, can_pay, can_receive)
  values (v_me, 'whish', 'test', 'tok_b', 'Whish ·· 1234', true, true) returning id into v_m2;
  insert into payment_methods (user_id, kind, provider, token, display, can_pay, can_receive)
  values (v_other, 'card', 'test', 'tok_c', 'Visa ·· 4242', true, false) returning id into v_m3;

  -- section 1: tables and RLS
  -- 1. Settings exist with everything off.
  if (select cardinality(enabled_kinds) from payment_settings) <> 0 then
    raise exception 'FAIL 1: payments must start switched off';
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_auth::text, 'role', 'authenticated')::text, true);

  -- 2. I see my two methods and not the other person's.
  select count(*) into v_n from payment_methods;
  if v_n <> 2 then raise exception 'FAIL 2: saw % methods, expected 2', v_n; end if;

  -- 3. The token column is not readable.
  begin
    perform token from payment_methods limit 1;
    raise exception 'FAIL 3: token readable';
  exception when insufficient_privilege then null;
  end;

  -- 4. Members cannot write payments directly.
  begin
    insert into payments (kind, subject_id, payer_id, payee_id, price_cents, fee_cents, rate_bps, provider, expires_at)
    values ('session', gen_random_uuid(), v_me, v_other, 100, 0, 1200, 'test', now());
    raise exception 'FAIL 4: member inserted a payment';
  exception when insufficient_privilege then null;
  end;

  -- section 2: member RPCs
  -- 5. Setting a default receive method needs a method that can receive.
  begin
    perform set_default_payment_method(v_m1, 'receive');
    raise exception 'FAIL 5: card set as receive default';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
  end;
  perform set_default_payment_method(v_m2, 'pay');
  set local role service_role;
  if (select default_pay from payment_methods where id = v_m1) then raise exception 'FAIL 6: old default kept'; end if;
  if not (select default_pay from payment_methods where id = v_m2) then raise exception 'FAIL 6b: new default not set'; end if;
  set local role authenticated;

  -- 7. I cannot remove someone else's method; I can remove mine.
  begin
    perform remove_payment_method(v_m3);
    raise exception 'FAIL 7: removed another person''s method';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
  end;
  perform remove_payment_method(v_m1);
  select count(*) into v_n from payment_methods;
  if v_n <> 1 then raise exception 'FAIL 7b: removed method still listed'; end if;

  -- section 3: payment state (no subject triggers yet: kinds stay disabled; subjects are plain pending bookings)
  set local role service_role;
  declare
    v_pay uuid; v_rel uuid; v_disp uuid; v_cash bigint; v_held bigint; v_payee bigint; v_sid uuid := gen_random_uuid(); v_b uuid;
  begin
    update payment_settings set fee_bps = 300, fee_flat_cents = 0, dispute_window_hours = 48;
    -- Subjects are real pending bookings: a payment whose subject is gone is refunded on capture (check 18).
    insert into bookings (id, client_id, coach_id, scheduled_for) values (v_sid, v_me, v_other, now() + interval '1 day');

    -- 8. Opening: fee and rate snapshot.
    v_pay := private.open_payment('session', v_sid, v_me, v_other, 10000);
    if (select fee_cents from payments where id = v_pay) <> 300 then raise exception 'FAIL 8: fee'; end if;

    -- 9. A payment being charged is never expired.
    perform payments_begin_charge(v_pay);
    update payments set expires_at = now() - interval '1 minute' where id = v_pay;
    perform private.fail_payment(v_pay, 'expired');
    if (select status from payments where id = v_pay) <> 'charging' then raise exception 'FAIL 9: charging payment expired'; end if;

    -- 10. Held: cash in = price + fee, held = price.
    perform payments_mark_held(v_pay, 'zz_ref_1', 0, null);
    select balance_cents into v_cash from ledger_balances where code = 'company_cash';
    if not exists (select 1 from ledger_entries where idempotency_key = 'checkout:' || v_pay) then
      raise exception 'FAIL 10: no checkout entry';
    end if;

    -- 11. Release after the window: payee gets price − commission, commission recorded.
    perform private.add_release(v_pay, v_sid);
    select id into v_rel from payment_releases where payment_id = v_pay;
    if private.release_due() <> 0 then raise exception 'FAIL 11: released inside the complaint period'; end if;
    update payment_releases set release_at = now() - interval '1 second' where id = v_rel;
    perform private.release_due();
    select balance_cents into v_payee from ledger_balances where code = 'payee:' || v_other;
    -- rate is the 'session' margin; payee share = 10000 − commission
    if v_payee <> 10000 - (select commission_cents from payment_releases where id = v_rel) then
      raise exception 'FAIL 11b: payee balance %', v_payee;
    end if;
    if (select status from payments where id = v_pay) <> 'closed' then raise exception 'FAIL 11c: not closed'; end if;
    if not exists (select 1 from payee_payouts where release_id = v_rel and status = 'waiting_method') then
      raise exception 'FAIL 11d: payout should wait for a receiving method';
    end if;

    -- 12. Dispute: refused after the window, accepted inside it, partial refund resolves.
    v_b := gen_random_uuid();
    insert into bookings (id, client_id, coach_id, scheduled_for) values (v_b, v_me, v_other, now() + interval '2 days');
    v_pay := private.open_payment('session', v_b, v_me, v_other, 5000);
    perform payments_begin_charge(v_pay);
    perform payments_mark_held(v_pay, 'zz_ref_2', 0, null);
    perform private.add_release(v_pay, (select subject_id from payments where id = v_pay));
    select id into v_rel from payment_releases where payment_id = v_pay;
    set local role authenticated;
    v_disp := raise_dispute(v_rel, 'Coach did not show up');
    set local role service_role;
    perform resolve_dispute(v_disp, 2000, v_other);
    if (select amount_cents from payment_releases where id = v_rel) <> 3000 then raise exception 'FAIL 12: release not reduced'; end if;
    if (select amount_cents from refunds where release_id = v_rel) <> 2000 then raise exception 'FAIL 12b: refund missing'; end if;
    if private.payment_unallocated(v_pay) <> 0 then raise exception 'FAIL 12c: unallocated %', private.payment_unallocated(v_pay); end if;

    v_b := gen_random_uuid();
    insert into bookings (id, client_id, coach_id, scheduled_for) values (v_b, v_me, v_other, now() + interval '3 days');
    v_pay := private.open_payment('session', v_b, v_me, v_other, 5000);
    perform payments_begin_charge(v_pay);
    perform payments_mark_held(v_pay, 'zz_ref_3', 0, null);
    perform private.add_release(v_pay, (select subject_id from payments where id = v_pay));
    select id into v_rel from payment_releases where payment_id = v_pay;
    update payment_releases set release_at = now() - interval '1 second' where id = v_rel;
    set local role authenticated;
    begin
      perform raise_dispute(v_rel, 'Too late now');
      raise exception 'FAIL 13: dispute after the window accepted';
    exception when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'FAIL%' then raise; end if;
      if v_err <> 'The complaint period for this payment has ended.' then raise exception 'FAIL 13b: %', v_err; end if;
    end;
    set local role service_role;

    -- 14. Refund can never exceed what is still held.
    v_b := gen_random_uuid();
    insert into bookings (id, client_id, coach_id, scheduled_for) values (v_b, v_me, v_other, now() + interval '4 days');
    v_pay := private.open_payment('session', v_b, v_me, v_other, 4000);
    perform payments_begin_charge(v_pay);
    perform payments_mark_held(v_pay, 'zz_ref_4', 0, null);
    perform private.refund_payment(v_pay, 999999, 'test');
    if (select sum(amount_cents) from refunds where payment_id = v_pay) <> 4000 then raise exception 'FAIL 14: refund not capped'; end if;

    -- 15. Soft split: cash = held + payees + member refunds + income − expense (nothing else posted yet).
    select balance_cents into v_cash from ledger_balances where code = 'company_cash';
    if v_cash <> (select sum(balance_cents) from ledger_balances where kind in ('liability','equity','income'))
               - (select coalesce(sum(balance_cents),0) from ledger_balances where kind = 'expense') then
      raise exception 'FAIL 15: company_cash does not equal what it is split into';
    end if;
  end;

  -- section 3b: review fixes
  declare
    v_pay uuid; v_pay2 uuid; v_rel uuid; v_rel2 uuid; v_disp uuid; v_b uuid; v_b2 uuid;
    v_o1 uuid; v_o2 uuid; v_mw uuid; v_ml uuid; v_ids uuid[]; v_sum bigint;
  begin
    v_b := gen_random_uuid(); v_b2 := gen_random_uuid();
    insert into bookings (id, client_id, coach_id, scheduled_for) values (v_b, v_me, v_other, now() + interval '20 days');
    insert into bookings (id, client_id, coach_id, scheduled_for) values (v_b2, v_me, v_other, now() + interval '21 days');
    v_pay := private.open_payment('session', v_b, v_me, v_other, 4000);
    perform payments_begin_charge(v_pay);
    perform payments_mark_held(v_pay, 'zz_ref_5', 0, null);
    v_pay2 := private.open_payment('session', v_b2, v_me, v_other, 3000);
    perform payments_begin_charge(v_pay2);
    perform payments_mark_held(v_pay2, 'zz_ref_6', 0, null);
    perform private.add_release(v_pay, v_b);
    perform private.add_release(v_pay2, v_b2);
    select id into v_rel from payment_releases where payment_id = v_pay;
    select id into v_rel2 from payment_releases where payment_id = v_pay2;

    -- 16. A refund cannot ride on a release that is not disputed, or that belongs to another payment.
    perform private.refund_payment(v_pay2, 1000, 'test', v_rel);   -- another payment's release
    perform private.refund_payment(v_pay2, 1000, 'test', v_rel2);  -- own release, but not disputed
    perform private.refund_payment(v_pay2, 1000, 'test', gen_random_uuid()); -- no such release
    if exists (select 1 from refunds where payment_id in (v_pay, v_pay2)) then raise exception 'FAIL 16: refund slipped through a bad release'; end if;
    if (select status from payments where id = v_pay2) <> 'held' then raise exception 'FAIL 16b: payment left held'; end if;
    begin
      perform private.refund_payment(v_pay2, null, 'test');
      raise exception 'FAIL 16c: null refund accepted';
    exception when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'FAIL%' then raise; end if;
      if v_err <> 'Refund amount must be positive.' then raise exception 'FAIL 16d: %', v_err; end if;
    end;
    begin
      perform private.refund_payment(gen_random_uuid(), 100, 'test');
      raise exception 'FAIL 16e: refund of a missing payment accepted';
    exception when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'FAIL%' then raise; end if;
      if v_err not like 'Payment % not found.' then raise exception 'FAIL 16f: %', v_err; end if;
    end;

    -- 17. Nothing to pay: a zero price is refused up front.
    begin
      perform private.open_payment('session', gen_random_uuid(), v_me, v_other, 0);
      raise exception 'FAIL 17: zero price accepted';
    exception when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'FAIL%' then raise; end if;
      if v_err <> 'Nothing to pay.' then raise exception 'FAIL 17b: %', v_err; end if;
    end;

    -- 18. Captured money for a subject that is gone is recorded, then refunded in full.
    v_pay := private.open_payment('session', gen_random_uuid(), v_me, v_other, 6000);
    perform payments_begin_charge(v_pay);
    perform payments_mark_held(v_pay, 'zz_ref_7', 0, null);
    if not exists (select 1 from ledger_entries where idempotency_key = 'checkout:' || v_pay) then
      raise exception 'FAIL 18: captured money not recorded';
    end if;
    if (select status from payments where id = v_pay) not in ('held','closed') then raise exception 'FAIL 18b: payment not held'; end if;
    if (select coalesce(sum(amount_cents), 0) from refunds where payment_id = v_pay) <> 6000 then raise exception 'FAIL 18c: not refunded in full'; end if;
    select coalesce(sum(l.amount_cents), 0) into v_sum
      from ledger_lines l join ledger_entries e on e.id = l.entry_id
     where l.account = 'held'
       and ((e.subject_type = 'payment' and e.subject_id = v_pay)
         or (e.subject_type = 'refund' and e.subject_id in (select id from refunds where payment_id = v_pay)));
    if v_sum <> 0 then raise exception 'FAIL 18d: held net % for this payment', v_sum; end if;

    -- 19. A payout whose receiving account was removed is parked, not sent; a live one is sent exactly once.
    insert into payment_methods (user_id, kind, provider, token, display, can_pay, can_receive)
    values (v_other, 'whish', 'test', 'zz_tok_live', 'Whish live', true, true) returning id into v_ml;
    insert into payment_methods (user_id, kind, provider, token, display, can_pay, can_receive, removed_at)
    values (v_other, 'whish', 'test', 'zz_tok_gone', 'Whish gone', true, true, now()) returning id into v_mw;
    insert into payee_payouts (payee_id, method_id, amount_cents, status) values (v_other, v_mw, 100, 'queued') returning id into v_o1;
    insert into payee_payouts (payee_id, method_id, amount_cents, status) values (v_other, v_ml, 100, 'queued') returning id into v_o2;
    select coalesce(array_agg(item_id), '{}') into v_ids from payments_claim_queue(1000);
    if v_o1 = any(v_ids) then raise exception 'FAIL 19: payout to a removed account was sent'; end if;
    if not v_o2 = any(v_ids) then raise exception 'FAIL 19b: live payout not claimed'; end if;
    if (select status from payee_payouts where id = v_o1) <> 'waiting_method' then raise exception 'FAIL 19c: removed-account payout not parked'; end if;
    if (select status from payee_payouts where id = v_o2) <> 'sending' then raise exception 'FAIL 19d: live payout not sending'; end if;
    select coalesce(array_agg(item_id), '{}') into v_ids from payments_claim_queue(1000);
    if v_o1 = any(v_ids) or v_o2 = any(v_ids) then raise exception 'FAIL 19e: payout claimed twice'; end if;

    -- 20. Deciding a complaint needs a real complaint and a real amount.
    begin
      perform resolve_dispute(gen_random_uuid(), 0, v_other);
      raise exception 'FAIL 20: unknown complaint accepted';
    exception when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'FAIL%' then raise; end if;
      if v_err not like 'Complaint % not found.' then raise exception 'FAIL 20b: %', v_err; end if;
    end;
    set local role authenticated;
    v_disp := raise_dispute(v_rel, 'Coach did not show up');
    set local role service_role;
    begin
      perform resolve_dispute(v_disp, null, v_other);
      raise exception 'FAIL 20c: null refund accepted';
    exception when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'FAIL%' then raise; end if;
      if v_err not like 'Refund must be between%' then raise exception 'FAIL 20d: %', v_err; end if;
    end;
  end;

  -- 21. The tick expires unpaid checkouts and releases what is due.
  declare v_t uuid;
  begin
    set local role service_role;
    v_t := private.open_payment('session', gen_random_uuid(), v_me, v_other, 1000);
    update payments set expires_at = now() - interval '1 second' where id = v_t;
    perform private.payments_tick();
    if (select status from payments where id = v_t) <> 'expired' then raise exception 'FAIL 21: tick did not expire'; end if;
  end;

  -- 22. One payment that throws on expiry is skipped; the others still expire.
  declare v_bad uuid; v_good uuid;
  begin
    set local role service_role;
    v_bad := private.open_payment('session', gen_random_uuid(), v_me, v_other, 1000);
    v_good := private.open_payment('session', gen_random_uuid(), v_me, v_other, 1000);
    update payments set expires_at = now() - interval '1 second' where id in (v_bad, v_good);
    reset role;
    create function pg_temp.zz_boom() returns trigger language plpgsql as $f$
    begin
      if new.status = 'expired' and new.id::text = current_setting('zz.boom_id') then raise exception 'boom'; end if;
      return new;
    end $f$;
    create trigger zz_boom before update on payments for each row execute function pg_temp.zz_boom();
    perform set_config('zz.boom_id', v_bad::text, true);
    set local role service_role;
    perform private.payments_tick();
    reset role;
    drop trigger zz_boom on payments;
    set local role service_role;
    if (select status from payments where id = v_bad) <> 'awaiting_payment' then raise exception 'FAIL 22: throwing payment not left alone'; end if;
    if (select status from payments where id = v_good) <> 'expired' then raise exception 'FAIL 22b: one bad row stalled the tick'; end if;
  end;

  -- 23. begin_charge returns the locked totals; a free capture of a paying payment is refused.
  declare v_t uuid; v_r record;
  begin
    set local role service_role;
    v_t := private.open_payment('session', gen_random_uuid(), v_me, v_other, 1000);
    select * into v_r from payments_begin_charge(v_t);
    if v_r.begun is not true or v_r.price_cents <> 1000 or v_r.fee_cents is distinct from (select fee_cents from payments where id = v_t) then
      raise exception 'FAIL 23: begin_charge returned %', row_to_json(v_r);
    end if;
    begin
      perform payments_mark_held(v_t, 'free:' || v_t, 0, null);
      raise exception 'FAIL 23b: a free capture of a paying payment was accepted';
    exception when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'FAIL%' then raise; end if;
      if v_err <> 'This payment is not free.' then raise exception 'FAIL 23b: %', v_err; end if;
    end;
    select * into v_r from payments_begin_charge(v_t);
    if v_r.begun is not false or v_r.price_cents is not null or v_r.fee_cents is not null then
      raise exception 'FAIL 23c: second begin_charge returned %', row_to_json(v_r);
    end if;
  end;

  raise exception 'ALL PAYMENTS CORE CHECKS PASSED';
end $$;
