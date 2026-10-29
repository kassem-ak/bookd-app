-- Final fix wave for payments (applied as `payments_final_fixes`).
--
-- C1. Members could write `event_attendees.payment` and `fee_cents` directly:
--     the `attend_self` policy covers every command and `authenticated` held
--     INSERT/UPDATE/DELETE. Every write already goes through security-definer
--     RPCs (`rsvp_to_event`, `set_event_attendance`, `mark_event_payment_settled`,
--     the event creators), so the write grants are revoked. Leaving a paid event
--     refunds the price held on the payment, never the row's `fee_cents`.
--
-- C2. A client could cancel a held booking after it happened and get the money
--     back. A client cancel is now refused once the session or court slot has
--     started, or on or after a tournament's first day; leaving an event is
--     refused once it has started.
--
-- C3. Practice money must never reach the profit split. Every ledger entry is
--     stamped with the payment mode it was posted in (`ledger_entries.mode`).
--
--     !!! OWNER ACTION: `public.close_day` / `public.day_figures` belong to
--     !!! another session and were NOT changed here. close_day MUST filter
--     !!! `ledger_entries.mode = 'live'` and subtract `promo_expense` before the
--     !!! profit split, or practice money and promo spend will be shared out.
--
-- I1. Removing a paid attendee (event deleted) refunds the held payment in
--     full. An event with paid attendees cannot have its start moved into the
--     past (or cleared), which would release the money early or strand it.
--
-- I2. The tick completes confirmed court reservations an hour after they end
--     and confirmed tournament entries after the tournament's last day, so
--     their money is released.
--
-- I3. A coach can complete or no-show a session only once it has started, and
--     cannot confirm a booking whose payment is still open.
--
-- I5. `payment_releases.payee_cents` records what the payee is actually owed.
--
-- I7. `cancel_unused_package` also returns `moved`: true when held money was
--     sent back to the card.
--
-- M1. `release_due` handles each release in its own savepoint: one failing row
--     no longer rolls back every other release.
--
-- M2. Paying yourself: a venue owner reserving their own court or entering
--     their own tournament, or a community owner joining their own paid event,
--     opens no payment and is confirmed as it was before payments.
--
-- Minor. Platform promo codes are readable by signed-in members only.

-- ---------------------------------------------------------------------------
-- C3. Ledger mode
-- ---------------------------------------------------------------------------
alter table public.ledger_entries
  add column if not exists mode text not null default 'live' check (mode in ('test', 'live'));

-- Every non-daily-close entry so far was posted in practice mode (there were 0
-- such rows when this was written). The ledger is append-only, so the guard
-- trigger is lifted only for this back-fill.
alter table public.ledger_entries disable trigger ledger_entries_append_only;
update public.ledger_entries set mode = 'test' where idempotency_key not like 'daily_close:%';
alter table public.ledger_entries enable trigger ledger_entries_append_only;

CREATE OR REPLACE FUNCTION private.post_entry(p_kind text, p_key text, p_subject_type text, p_subject_id uuid, p_lines jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_line jsonb;
begin
  select id into v_id from ledger_entries where idempotency_key = p_key;
  if v_id is not null then return v_id; end if;

  insert into ledger_entries (kind, idempotency_key, subject_type, subject_id, mode)
  values (p_kind, p_key, p_subject_type, p_subject_id,
          coalesce((select mode from payment_settings), 'live'))
  returning id into v_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    if (v_line->>'amount')::bigint <> 0 then
      insert into ledger_lines (entry_id, account, amount_cents)
      values (v_id, v_line->>'account', (v_line->>'amount')::bigint);
    end if;
  end loop;
  return v_id;
end $function$;

-- ---------------------------------------------------------------------------
-- C1. Attendee rows are written only through the RPCs
-- ---------------------------------------------------------------------------
revoke insert, update, delete on public.event_attendees from authenticated, anon;

-- C1 refund from the payment's price; I1a refund a held payment when the row goes.
CREATE OR REPLACE FUNCTION private.event_attendance_money()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v_pay uuid; v_price int;
begin
  if tg_op = 'DELETE' then
    select id into v_pay from payments where kind = 'event' and subject_id = old.event_id
       and payer_id = old.user_id and status = 'awaiting_payment';
    if v_pay is not null then perform private.fail_payment(v_pay, 'cancelled'); end if;
    select id, price_cents into v_pay, v_price from payments where kind = 'event' and subject_id = old.event_id
       and payer_id = old.user_id and status = 'held';
    if v_pay is not null then perform private.refund_payment(v_pay, v_price, 'event removed'); end if;
    return null;
  end if;

  if new.payment = 'pending' and coalesce(new.fee_cents, 0) > 0 and private.payments_enabled('event')
     and (tg_op = 'INSERT' or old.payment is distinct from 'pending') then
    perform private.open_payment('event', new.event_id, new.user_id,
      (select cm.user_id from events e join community_members cm
          on cm.community_id = e.community_id and cm.role = 'owner'
        where e.id = new.event_id limit 1),
      new.fee_cents);
  elsif tg_op = 'UPDATE' and new.payment = 'refunded' and old.payment = 'paid' then
    select id, price_cents into v_pay, v_price from payments where kind = 'event' and subject_id = new.event_id
       and payer_id = new.user_id and status = 'held';
    if v_pay is not null then
      perform private.refund_payment(v_pay, v_price, 'left the event');
    end if;
  end if;
  return null;
end $function$;

-- C2b leaving a started event is refused; M2 the community owner joins their own paid event free.
CREATE OR REPLACE FUNCTION public.rsvp_to_event(p_event uuid, p_going boolean)
 RETURNS TABLE(attendees integer, payment attendance_payment, owed_cents integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := require_app_user();
  v_event events;
  v_existing event_attendees;
  v_payment attendance_payment;
  v_rows int;
begin
  select * into v_event from events where id = p_event;
  if v_event.id is null then
    raise exception 'That event no longer exists.' using errcode = 'no_data_found';
  end if;
  if not can_see_event(v_user, v_event) then
    raise exception 'That event is not open to you.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_existing from event_attendees
   where event_id = p_event and user_id = v_user;

  if not p_going then
    if v_existing.user_id is not null and v_event.starts_at <= now() then
      raise exception 'This event has already started.';
    end if;
    if v_existing.user_id is not null and v_existing.payment = 'paid' then
      update event_attendees set payment = 'refunded'
       where event_id = p_event and user_id = v_user;
      update events set attendees_count = greatest(0, attendees_count - 1) where id = p_event;
    else
      delete from event_attendees where event_id = p_event and user_id = v_user;
      get diagnostics v_rows = row_count;
      if v_rows > 0 and attendance_is_confirmed(coalesce(v_existing.payment, 'not_required')) then
        update events set attendees_count = greatest(0, attendees_count - 1) where id = p_event;
      end if;
    end if;
    return query
      select e.attendees_count, 'not_required'::attendance_payment, 0 from events e where e.id = p_event;
    return;
  end if;

  if v_existing.user_id is not null and v_existing.payment in ('not_required', 'paid', 'pending') then
    return query
      select e.attendees_count, v_existing.payment,
             case when v_existing.payment = 'pending' then v_existing.fee_cents else 0 end
        from events e where e.id = p_event;
    return;
  end if;

  v_payment := case when coalesce(v_event.fee_cents, 0) > 0
                    then 'pending'::attendance_payment
                    else 'not_required'::attendance_payment end;
  -- The community owner is the payee: with payments on they do not pay themselves.
  if v_payment = 'pending' and private.payments_enabled('event') and exists (
       select 1 from community_members cm
        where cm.community_id = v_event.community_id and cm.role = 'owner' and cm.user_id = v_user) then
    v_payment := 'not_required';
  end if;

  insert into event_attendees (event_id, user_id, payment, fee_cents)
  values (p_event, v_user, v_payment, coalesce(v_event.fee_cents, 0))
  on conflict (event_id, user_id) do update
    set payment = excluded.payment, fee_cents = excluded.fee_cents;

  if attendance_is_confirmed(v_payment) then
    update events set attendees_count = attendees_count + 1 where id = p_event;
  end if;

  return query
    select e.attendees_count, v_payment,
           case when v_payment = 'pending' then coalesce(v_event.fee_cents, 0) else 0 end
      from events e where e.id = p_event;
end $function$;

-- ---------------------------------------------------------------------------
-- C2a / I3. Status guards
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_booking_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare v_actor uuid;
begin
  if current_setting('app.payments_internal', true) = 'on' then return new; end if;
  if current_setting('role', true) = 'service_role' then return new; end if;
  if new.status = old.status then return new; end if;

  v_actor := current_app_user();
  if v_actor = new.client_id then
    if new.status <> 'cancelled' or old.status not in ('pending','confirmed') then
      raise exception 'clients may only cancel pending or confirmed bookings';
    end if;
    if old.scheduled_for <= now() then
      raise exception 'This session has already started.';
    end if;
  elsif v_actor = new.coach_id then
    if new.status not in ('confirmed','completed','no_show','cancelled') then
      raise exception 'unsupported coach booking status transition';
    end if;
    if new.status in ('completed','no_show') and old.scheduled_for > now() then
      raise exception 'That session has not started yet.';
    end if;
    if new.status = 'confirmed' and old.status = 'pending' and exists (
         select 1 from payments where id = old.payment_id and status in ('awaiting_payment','charging')) then
      raise exception 'This booking has not been paid for yet.';
    end if;
  else
    raise exception 'not authorized to update booking status';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.guard_court_reservation_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare v_actor uuid;
begin
  if current_setting('app.payments_internal', true) = 'on' then return new; end if;
  if current_setting('role', true) = 'service_role' then return new; end if;
  if new.total_cents is distinct from old.total_cents
     or new.commission_cents is distinct from old.commission_cents
     or new.price_cents_per_hour is distinct from old.price_cents_per_hour
     or new.equipment_cents_per_hour is distinct from old.equipment_cents_per_hour
     or new.equipment_rented is distinct from old.equipment_rented
     or new.hours is distinct from old.hours
     or new.starts_at is distinct from old.starts_at
     or new.ends_at is distinct from old.ends_at
     or new.court_id is distinct from old.court_id
     or new.client_id is distinct from old.client_id then
    raise exception 'reservation price and slot are set at booking time';
  end if;
  if new.status = old.status then return new; end if;
  v_actor := current_app_user();
  if v_actor = new.client_id then
    if new.status <> 'cancelled' or old.status not in ('pending', 'confirmed') then
      raise exception 'clients may only cancel pending or confirmed reservations';
    end if;
    if old.starts_at <= now() then
      raise exception 'This booking has already started.';
    end if;
  elsif is_court_host(new.court_id) then
    if new.status not in ('confirmed', 'completed', 'no_show', 'cancelled') then
      raise exception 'unsupported venue reservation status transition';
    end if;
  else
    raise exception 'not authorized to update this reservation';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.guard_event_entry_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare v_actor uuid;
begin
  if current_setting('app.payments_internal', true) = 'on' then return new; end if;
  if current_setting('role', true) = 'service_role' then return new; end if;
  if new.total_cents is distinct from old.total_cents
     or new.commission_cents is distinct from old.commission_cents
     or new.venue_event_id is distinct from old.venue_event_id
     or new.client_id is distinct from old.client_id then
    raise exception 'entry fee is set at entry time';
  end if;
  if new.status = old.status then return new; end if;
  v_actor := current_app_user();
  if v_actor = new.client_id then
    if new.status <> 'cancelled' or old.status not in ('pending', 'confirmed') then
      raise exception 'clients may only cancel pending or confirmed entries';
    end if;
    if exists (select 1 from venue_events where id = old.venue_event_id and starts_on <= current_date) then
      raise exception 'This tournament has already started.';
    end if;
  elsif is_venue_event_host(new.venue_event_id) then
    if new.status not in ('confirmed', 'completed', 'no_show', 'cancelled') then
      raise exception 'unsupported tournament entry status transition';
    end if;
  else
    raise exception 'not authorized to update this entry';
  end if;
  return new;
end $function$;

-- ---------------------------------------------------------------------------
-- I1b. An event with paid attendees keeps its start in the future
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.events_guard_paid_start()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  if new.starts_at is distinct from old.starts_at
     and (new.starts_at is null or new.starts_at < now())
     and exists (select 1 from payments where kind = 'event' and subject_id = new.id and status = 'held') then
    raise exception 'This event has paid attendees; its start cannot be moved into the past.';
  end if;
  return new;
end $function$;

revoke execute on function private.events_guard_paid_start() from public, anon, authenticated;
drop trigger if exists trg_events_guard_paid_start on public.events;
create trigger trg_events_guard_paid_start before update of starts_at on public.events
  for each row execute function private.events_guard_paid_start();

-- ---------------------------------------------------------------------------
-- M2. A venue owner booking their own court or tournament does not pay themselves
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.venue_rows_hold_unpaid()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v_payee uuid;
begin
  if private.payments_enabled(tg_argv[0]) and new.total_cents > 0 then
    if tg_argv[0] = 'court' then
      select v.owner_id into v_payee from courts c join venues v on v.id = c.venue_id where c.id = new.court_id;
    else
      select v.owner_id into v_payee from venue_events e join venues v on v.id = e.venue_id where e.id = new.venue_event_id;
    end if;
    -- Left as the RPC set it (confirmed): no payment opens for paying yourself.
    if v_payee is distinct from new.client_id then new.status := 'pending'; end if;
  end if;
  return new;
end $function$;

-- ---------------------------------------------------------------------------
-- I5 / M1. Releases record what the payee is owed; one bad row does not stall the rest
-- ---------------------------------------------------------------------------
alter table public.payment_releases add column if not exists payee_cents int;

CREATE OR REPLACE FUNCTION private.release_due()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare r record; v_n int := 0; v_method uuid; v_share int; v_gross int; v_commission int;
begin
  for r in
    select rel.*, p.payee_id, p.price_cents, p.list_price_cents, p.rate_bps
      from payment_releases rel join payments p on p.id = rel.payment_id
     where rel.status = 'waiting' and rel.release_at <= now()
     for update of rel skip locked
  loop
    begin
      -- What this release is worth to the payee: above the amount held only under a platform code.
      v_gross := case when r.price_cents > 0 then round(r.amount_cents::numeric * r.list_price_cents / r.price_cents)::int
                      else r.list_price_cents end;
      v_commission := case when v_gross = r.amount_cents then r.commission_cents
                           else round(v_gross * r.rate_bps / 10000.0)::int end;
      v_share := v_gross - v_commission;
      perform private.ensure_account('payee:' || r.payee_id, 'liability', r.payee_id);
      perform private.post_entry('release', 'release:' || r.id, 'payment_release', r.id, jsonb_build_array(
        jsonb_build_object('account', 'held',                 'amount', r.amount_cents),
        jsonb_build_object('account', 'payee:' || r.payee_id, 'amount', -v_share),
        jsonb_build_object('account', 'commission_revenue',   'amount', -v_commission),
        jsonb_build_object('account', 'promo_expense',        'amount', v_gross - r.amount_cents)));
      update payment_releases set status = 'released', released_at = now(), commission_cents = v_commission,
                                  payee_cents = v_share
       where id = r.id;

      if v_share > 0 then
        select id into v_method from payment_methods
         where user_id = r.payee_id and default_receive and removed_at is null;
        insert into payee_payouts (payee_id, release_id, method_id, amount_cents, status)
        values (r.payee_id, r.id, v_method, v_share, case when v_method is null then 'waiting_method' else 'queued' end);
      end if;

      perform private.close_if_settled(r.payment_id);
      v_n := v_n + 1;
    exception when others then
      raise warning 'release_due: release % failed: %', r.id, sqlerrm;
    end;
  end loop;
  return v_n;
end $function$;

CREATE OR REPLACE FUNCTION public.resolve_dispute(p_dispute uuid, p_refund_cents integer, p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare d disputes; r payment_releases; v_rate int; v_left int;
begin
  select * into d from disputes where id = p_dispute for update;
  if not found then raise exception 'Complaint % not found.', p_dispute; end if;
  if d.status <> 'open' then raise exception 'This complaint is already decided.'; end if;
  select * into r from payment_releases where id = d.release_id for update;
  if not found then raise exception 'Release for complaint % not found.', p_dispute; end if;
  if p_refund_cents is null or p_refund_cents < 0 or p_refund_cents > r.amount_cents then raise exception 'Refund must be between 0 and %.', r.amount_cents; end if;

  if p_refund_cents > 0 then
    perform private.refund_payment(r.payment_id, p_refund_cents, 'complaint upheld', r.id);
  end if;
  v_left := r.amount_cents - p_refund_cents;
  select rate_bps into v_rate from payments where id = r.payment_id;
  if v_left = 0 and p_refund_cents > 0 then
    update payment_releases set status = 'refunded' where id = r.id;
  else
    update payment_releases
       set amount_cents = v_left, commission_cents = round(v_left * v_rate / 10000.0)::int,
           payee_cents = v_left - round(v_left * v_rate / 10000.0)::int,
           status = 'waiting', release_at = now() where id = r.id;
  end if;
  update disputes set status = case when p_refund_cents > 0 then 'refunded' else 'released' end,
                      refund_cents = p_refund_cents, resolved_by = p_actor, resolved_at = now()
   where id = p_dispute;
  perform private.release_due();
  perform private.close_if_settled(r.payment_id);
end $function$;

-- ---------------------------------------------------------------------------
-- I2. The tick completes courts and tournaments that are over
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.payments_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare r record; v_url text; v_secret text;
begin
  for r in select id from payments where status = 'awaiting_payment' and expires_at <= now()
           for update skip locked loop
    begin
      perform private.fail_payment(r.id, 'expired');
    exception when others then
      raise warning 'payments_tick: expire failed on %: %', r.id, sqlerrm;
    end;
  end loop;

  for r in select p.id, p.subject_id from payments p join events e on e.id = p.subject_id
            where p.kind = 'event' and p.status = 'held' and e.starts_at < now() - interval '1 day'
              and not exists (select 1 from payment_releases rel where rel.payment_id = p.id) loop
    begin
      perform private.add_release(r.id, r.subject_id);
    exception when others then
      raise warning 'payments_tick: event release failed on %: %', r.id, sqlerrm;
    end;
  end loop;

  -- Courts and tournaments have no completion step of their own: the tick
  -- completes them as the owner would, and the status trigger adds the release.
  begin
    perform set_config('app.payments_internal', 'on', true);
    update court_reservations set status = 'completed'
     where status = 'confirmed' and ends_at <= now() - interval '1 hour';
    perform set_config('app.payments_internal', 'off', true);
  exception when others then
    perform set_config('app.payments_internal', 'off', true);
    raise warning 'payments_tick: court completion failed: %', sqlerrm;
  end;

  begin
    perform set_config('app.payments_internal', 'on', true);
    update venue_event_entries ve set status = 'completed'
      from venue_events e
     where e.id = ve.venue_event_id and ve.status = 'confirmed' and e.ends_on < current_date;
    perform set_config('app.payments_internal', 'off', true);
  exception when others then
    perform set_config('app.payments_internal', 'off', true);
    raise warning 'payments_tick: tournament completion failed: %', sqlerrm;
  end;

  begin
    perform private.release_due();
  exception when others then
    raise warning 'payments_tick: release_due failed: %', sqlerrm;
  end;

  begin
    if exists (select 1 from payee_payouts where status = 'queued') or exists (select 1 from refunds where status = 'queued') then
      select decrypted_secret into v_url from vault.decrypted_secrets where name = 'payments_function_url';
      select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'payments_cron_secret';
      if v_url is not null and v_secret is not null then
        perform net.http_post(
          url := v_url,
          body := jsonb_build_object('action', 'run-queue'),
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-payments-secret', v_secret));
      end if;
    end if;
  exception when others then
    raise warning 'payments_tick: queue call failed: %', sqlerrm;
  end;
end $function$;

-- ---------------------------------------------------------------------------
-- I7. cancel_unused_package says whether held money was sent back
-- ---------------------------------------------------------------------------
drop function if exists public.cancel_unused_package(uuid, uuid);
CREATE FUNCTION public.cancel_unused_package(p_coach uuid, p_package uuid)
 RETURNS TABLE(id uuid, refund_cents integer, moved boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_me      uuid := require_app_user();
  v_taken   int;
  v_price   int;
  v_paid_n  int;
  v_request uuid;
begin
  if not exists (
    select 1 from bookings b
     where b.client_id = v_me and b.coach_id = p_coach and b.package_id = p_package
  ) then
    raise exception 'You have no sessions on that package.';
  end if;

  if exists (
    select 1 from package_cancellations r
     where r.client_id = v_me and r.coach_id = p_coach and r.package_id = p_package
       and r.status in ('requested', 'offered', 'approved')
  ) then
    raise exception 'There is already a cancellation open on that package.';
  end if;

  select count(*)::int into v_taken
    from bookings b
   where b.client_id = v_me and b.coach_id = p_coach
     and b.package_id = p_package and b.status = 'completed';

  if v_taken > 0 then
    raise exception 'This package has a session you both confirmed. Ask to cancel instead, and settle the amount together.';
  end if;

  perform 1 from payments p join bookings f on f.id = p.subject_id
   where p.kind = 'package' and p.payer_id = v_me and f.package_id = p_package
     for update of p;
  select count(*)::int,
         coalesce(sum(case when p.status = 'held' then private.payment_unallocated(p.id) else 0 end), 0)::int
    into v_paid_n, v_price
    from payments p join bookings f on f.id = p.subject_id
   where p.kind = 'package' and p.payer_id = v_me and f.package_id = p_package;

  if v_paid_n = 0 then
    select p.price_cents into v_price from packages p where p.id = p_package;
  end if;

  update bookings b set status = 'cancelled'
   where b.client_id = v_me and b.coach_id = p_coach
     and b.package_id = p_package and b.status in ('pending', 'confirmed');

  insert into package_cancellations
    (client_id, coach_id, package_id, reason, status, refund_cents, decided_by, decided_at)
  values
    (v_me, p_coach, p_package, 'No sessions taken', 'approved',
     coalesce(v_price, 0), v_me, now())
  returning package_cancellations.id into v_request;

  -- Held money is refunded by the package_cancellations trigger, capped at what is held.
  return query
    select v_request, coalesce(v_price, 0), v_paid_n > 0 and coalesce(v_price, 0) > 0;
end $function$;

revoke execute on function public.cancel_unused_package(uuid, uuid) from public, anon;
grant execute on function public.cancel_unused_package(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Minor. Promo codes are entered, not browsed
-- ---------------------------------------------------------------------------
alter policy promo_read on public.platform_promos to authenticated;
