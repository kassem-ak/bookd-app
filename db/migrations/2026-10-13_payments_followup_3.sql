-- Payments follow-up 3 (applied as `payments_followup_3`).
--
-- cancel_unused_package: a pack with a past session nobody marked done used to
-- get past the "taken" check, then the booking guard refused the cancel with
-- 'This session has already started.', which tells the member nothing. A
-- pending or confirmed session whose start has passed now counts as taken, so
-- the member gets the existing "Ask to cancel instead" message.
-- Only the "taken" count changes; the rest of the body is the live one.

create or replace function public.cancel_unused_package(p_coach uuid, p_package uuid)
 returns table(id uuid, refund_cents integer, moved boolean)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
     and b.package_id = p_package
     and (b.status = 'completed'
          or (b.status in ('pending', 'confirmed') and b.scheduled_for <= now()));

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

  return query
    select v_request, coalesce(v_price, 0), v_paid_n > 0 and coalesce(v_price, 0) > 0;
end $function$;

revoke execute on function public.cancel_unused_package(uuid, uuid) from public, anon;
grant execute on function public.cancel_unused_package(uuid, uuid) to authenticated, service_role;
