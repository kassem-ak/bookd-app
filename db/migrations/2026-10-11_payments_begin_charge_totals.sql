-- Charge the total that was locked, not the total that was read earlier.
--
-- The payments function used to read a payment's price and fee, and only then
-- call `payments_begin_charge` to lock it. In that gap a member could apply a
-- 100% code, start checkout, and take the code off again: the function had read
-- a total of zero, so it captured a full-price booking as "free" (or, on the
-- paid path, charged a stale amount).
--
-- 1. `payments_begin_charge` now returns the locked row's totals with the
--    outcome: (begun, price_cents, fee_cents). When nothing could be locked it
--    returns one row (false, null, null). The totals can no longer change after
--    this point, because a payment in 'charging' cannot have a code applied or
--    removed. Service role only, as before.
--
-- 2. `private.mark_payment_held` refuses a `free:` capture on a payment that
--    costs money, and a real capture on a payment that is free, so a wrong
--    branch in a caller cannot book the wrong thing. The body is the live one,
--    with the two checks added after the status check.

drop function if exists public.payments_begin_charge(uuid);

create function public.payments_begin_charge(p_payment uuid)
returns table(begun boolean, price_cents int, fee_cents int)
language plpgsql security definer set search_path = public as $$
begin
  return query
    update payments p set status = 'charging'
     where p.id = p_payment and p.status = 'awaiting_payment' and p.expires_at > now()
    returning true, p.price_cents, p.fee_cents;
  if not found then
    return query select false, null::int, null::int;
  end if;
end $$;

revoke execute on function public.payments_begin_charge(uuid) from public, anon, authenticated;
grant execute on function public.payments_begin_charge(uuid) to service_role;

create or replace function private.mark_payment_held(p_payment uuid, p_ref text, p_cost integer, p_method uuid)
returns void
language plpgsql security definer set search_path = public, private as $$
declare v payments; v_red uuid;
begin
  select * into v from payments where id = p_payment for update;
  if v.status in ('held','closed') then return; end if;
  if v.status <> 'charging' then raise exception 'This payment is %, not being charged.', v.status; end if;
  if p_ref like 'free:%' and v.price_cents + v.fee_cents > 0 then raise exception 'This payment is not free.'; end if;
  if p_ref not like 'free:%' and v.price_cents + v.fee_cents = 0 then raise exception 'This payment is free.'; end if;

  update payments set status = 'held', provider_ref = p_ref, method_id = p_method, held_at = now()
   where id = p_payment returning * into v;

  perform private.post_entry('checkout', 'checkout:' || v.id, 'payment', v.id, jsonb_build_array(
    jsonb_build_object('account', 'company_cash', 'amount', v.price_cents + v.fee_cents),
    jsonb_build_object('account', 'held',         'amount', -v.price_cents),
    jsonb_build_object('account', 'fee_income',   'amount', -v.fee_cents)));
  if p_cost > 0 then
    perform private.post_entry('gateway_cost', 'gateway_cost:' || v.id, 'payment', v.id, jsonb_build_array(
      jsonb_build_object('account', 'gateway_cost', 'amount', p_cost),
      jsonb_build_object('account', 'company_cash', 'amount', -p_cost)));
  end if;

  -- Captured money is always recorded above. If the subject is gone, give it back (the fee stays).
  if not private.confirm_subject(v) then
    perform private.refund_payment(v.id, v.price_cents, 'cancelled before the payment landed');
  elsif v.promo_id is not null then
    insert into promo_redemptions (promo_kind, promo_id, user_id, payment_id)
    values (v.promo_kind, v.promo_id, v.payer_id, v.id)
    on conflict do nothing
    returning id into v_red;
    if v_red is null then
      raise warning 'promo % already redeemed by %; payment % captured without a fresh redemption', v.promo_code, v.payer_id, v.id;
    end if;
  end if;
end $$;
