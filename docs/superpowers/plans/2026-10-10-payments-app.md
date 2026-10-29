# Payments — App Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members pay for sessions, packages, courts, tournaments and paid events inside BOOK'D. The money is held in the company account until the service is done and the complaint period has passed, then released to the coach, venue or organiser. Everything runs end to end in practice mode (Test gateway, no real money).

**Architecture:**
- **Money records.** A double-entry ledger in Postgres records all money; balances are always derived from it.
- **Hooks on existing tables.** Triggers on the existing booking, reservation, entry and attendance tables open a payment, hold the subject as `pending` until paid, and react to completion and cancellation. The existing booking RPCs are not rewritten.
- **Gateway calls.** One edge function, `payments`, talks to the gateway through an adapter; only the Test adapter exists in this plan.
- **Background job.** A per-minute `pg_cron` tick expires unpaid checkouts, completes past events, releases money after the complaint period, and kicks the payout/refund queue.
- **Off switch.** Nothing changes for members until a kind is listed in `payment_settings.enabled_kinds`.

**Tech Stack:** Supabase Postgres (plpgsql, RLS, pg_cron, pg_net, Vault), Supabase Edge Functions (Deno), Expo React Native web (TypeScript), node:test.

**Spec:** `docs/superpowers/specs/2026-10-09-payments-design.md` — sections 1, 3, 5, 6.A and the developer appendix. Console pages (6.B), daily profit close, expenses, shares and capital are **not** in this plan; they get their own plan.

## Global Constraints

- **Currency and amounts:** one currency, USD; every amount is an integer number of cents, as today.
- **Ledger:** every entry sums to 0, the ledger is append-only, and balances are never written.
- **Member fee:** added to the price, `fee = round(price × fee_bps / 10000) + fee_flat_cents`. Price 0 means fee 0.
- **Commission:** the rate is snapshotted when the payment opens (`rate_bps`). On each release, `commission = round(amount × rate_bps / 10000)`.
- **Complaint period:** default 48 h (`payment_settings.dispute_window_hours`). Unpaid checkouts expire after 15 min (`checkout_minutes`).
- **Fee on cancel:** cancelling before completion refunds the price; the fee is not refunded.
- **Payout fees:** paid by the recipient, so a payout moves `company_cash −amount` and clears the payee's `amount`.
- **Card numbers:** BOOK'D never stores or sees one. In practice mode, members pick from preset test cards.
- **Practice mode:** the banner reads exactly "Practice mode — no real money".
- **Migrations:** files go in `db/migrations/YYYY-MM-DD_name.sql` with a prose header and are applied with the Supabase MCP `apply_migration` (project `qievymkkprhbvxrsdukb`).
- **Client RPC grants:** `revoke execute … from public, anon; grant execute … to authenticated;`.
- **Server-only grants:** `revoke … from public, anon, authenticated; grant … to service_role;`.
- **Repo conventions:** files are CRLF; a patch keeps the file's line endings.
- **App tests:** `cd expo-app && node --test "tests/*.test.cjs"`. Typecheck: `cd expo-app && npx tsc --noEmit -p tsconfig.json`.
- **SQL tests:** a single `do $$ … $$` block whose final line raises `ALL … PASSED`, so it always rolls back. Run it with the Supabase MCP `execute_sql`; that message means pass, a `FAIL n:` message means failure.
- **Shipping and rollout:**
  - No APK builds. Web deploys on merge to `main`.
  - Work on branch `payments-app`, one PR per Stage (A, B, C, D), merged by Kassem.
  - **Do not add anything to `enabled_kinds` in production without Kassem's explicit yes.**

## Review Focus

1. **Venue with no owner** (`venues.owner_id` is nullable). Reserving a court there with payments on must refuse with "This venue cannot take payments yet." Task 4 test.
2. **Checkout expiring while the gateway is charging.** A payment in `charging` must never be expired. Task 3 test.
3. **Cancelling a session that was paid.** Full price goes back to the member; the fee does not. A cancelled unpaid booking closes its payment without money moving. Task 4 test.
4. **Package refund after some sessions released.** The refund is capped at what is still held, never more. Task 4 test.
5. **Reporting a problem after the complaint period ended.** It is refused with "The complaint period for this payment has ended." Task 3 test, and the button is hidden in Task 12.

---

## File Structure

| File | Responsibility |
|---|---|
| `db/migrations/2026-10-10_payments_margin_keys.sql` | Add enum values `package, court, tournament, event` to `margin_key` (own file: new enum values cannot be used in the same transaction). |
| `db/migrations/2026-10-10_payments_ledger.sql` | Ledger tables, zero-sum + append-only triggers, `private.post_entry`, `private.ensure_account`, `ledger_balances` view. |
| `db/migrations/2026-10-10_payments_core.sql` | Settings, methods, payments, releases, refunds, payee_payouts (the name `payouts` is taken by the admin royalties log), disputes; RLS; payment state functions; edge-facing and member-facing RPCs; guard bypass. |
| `db/migrations/2026-10-10_payments_subjects.sql` | Triggers on `bookings`, `package_cancellations`, `court_reservations`, `venue_event_entries`, `event_attendees`. |
| `db/migrations/2026-10-10_payments_tick.sql` | `private.payments_tick()`, pg_cron schedule, Vault secrets for the queue call. |
| `db/tests/payments_ledger.sql`, `db/tests/payments_core.sql`, `db/tests/payments_subjects.sql` | SQL tests. |
| `supabase/functions/payments/adapter.ts` | Gateway interface + `InputError`. |
| `supabase/functions/payments/test-gateway.ts` | Practice-mode gateway. |
| `supabase/functions/payments/index.ts` | Actions `add-method`, `checkout`, `run-queue`. |
| `supabase/config.toml` | `[functions.payments] verify_jwt = false` (the cron call has no user JWT; user actions check the JWT in code). |
| `expo-app/src/lib/payments.ts` | Client API + pure helpers (`quote`, `validWhishNumber`, `earningsSummary`, `paymentsOn`). |
| `expo-app/tests/payments.test.cjs` | Tests for the client lib. |
| `expo-app/src/components/usePaymentConfig.ts` | Hook returning the cached config. |
| `expo-app/src/components/PracticeBanner.tsx` | The practice-mode banner. |
| `expo-app/src/components/AddPaymentMethod.tsx` | Add a test card / Whish number (used by the methods screen and checkout). |
| `expo-app/src/components/CheckoutPanel.tsx` | Pay for the newest awaiting payment. |
| `expo-app/src/overlays/PaymentMethodsOverlay.tsx` | APP-1. |
| `expo-app/src/overlays/PaymentHistoryOverlay.tsx` | APP-4, APP-6 (history, receipts, pay now, report a problem). |
| `expo-app/src/overlays/EarningsOverlay.tsx` | APP-3. |
| Modified: `BookingOverlay.tsx`, `RsvpSheet.tsx`, `CommunityOverlays.tsx`, `BookingsOverlay.tsx`, `RefundNegotiation.tsx`, `ProfileScreen.tsx`, `OverlayRouter.tsx` | Wiring and copy. |
| Deleted: `expo-app/src/overlays/AccountingOverlays.tsx` | APP-7. |

---

# Stage A — Money core (database)

### Task 1: Ledger

**Files:**
- Create: `db/migrations/2026-10-10_payments_margin_keys.sql`
- Create: `db/migrations/2026-10-10_payments_ledger.sql`
- Test: `db/tests/payments_ledger.sql`

**Interfaces:**
- Produces:
  - `private.ensure_account(p_code text, p_kind text, p_owner uuid default null) returns text`
  - `private.post_entry(p_kind text, p_key text, p_subject_type text, p_subject_id uuid, p_lines jsonb) returns uuid`, where `p_lines` is `[{"account": text, "amount": int}]`, positive = debit. It is idempotent on `p_key`.
  - View `public.ledger_balances(code, kind, owner_id, balance_cents)`, where `balance_cents` has the natural sign for the account kind.
- Fixed account codes:
  - `company_cash` (asset)
  - `held` (liability)
  - `commission_revenue` (income)
  - `fee_income` (income)
  - `gateway_cost` (expense)
  - `undistributed_profit` (equity)
  - `company_capital` (equity)
- Per-person account codes:
  - `payee:<users.id>` (liability)
  - `member_refund:<users.id>` (liability)

- [ ] **Step 1: Write the failing test** — `db/tests/payments_ledger.sql`

```sql
-- Ledger invariants. Run with execute_sql; passes when it raises
-- 'ALL PAYMENTS LEDGER CHECKS PASSED' (the raise rolls everything back).
do $$
declare v_entry uuid; v_again uuid; v_err text; v_bal bigint;
begin
  -- 1. A balanced entry posts, and posting the same key again returns the same entry.
  v_entry := private.post_entry('test', 'zz-test-1', null, null,
    '[{"account":"company_cash","amount":500},{"account":"held","amount":-500}]');
  v_again := private.post_entry('test', 'zz-test-1', null, null,
    '[{"account":"company_cash","amount":999},{"account":"held","amount":-999}]');
  if v_entry is distinct from v_again then raise exception 'FAIL 1: same key posted twice'; end if;
  select balance_cents into v_bal from ledger_balances where code = 'held';
  if v_bal < 500 then raise exception 'FAIL 1b: held balance % should include the 500 credit', v_bal; end if;

  -- 2. An unbalanced entry is refused.
  begin
    perform private.post_entry('test', 'zz-test-2', null, null,
      '[{"account":"company_cash","amount":500},{"account":"held","amount":-400}]');
    set constraints all immediate;
    raise exception 'FAIL 2: unbalanced entry accepted';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
    if v_err not like '%does not balance%' then raise exception 'FAIL 2b: wrong error %', v_err; end if;
  end;
  set constraints all deferred;

  -- 3. The ledger cannot be edited or deleted.
  begin
    update ledger_lines set amount_cents = 1 where entry_id = v_entry;
    raise exception 'FAIL 3: line updated';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
  end;
  begin
    delete from ledger_entries where id = v_entry;
    raise exception 'FAIL 3b: entry deleted';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err like 'FAIL%' then raise; end if;
  end;

  -- 4. Members cannot read the ledger.
  if has_table_privilege('authenticated', 'public.ledger_lines', 'select') then
    raise exception 'FAIL 4: authenticated can read ledger_lines';
  end if;

  -- 5. Per-person accounts are created on demand.
  perform private.ensure_account('payee:00000000-0000-0000-0000-000000000000', 'liability', null);
  if not exists (select 1 from ledger_accounts where code = 'payee:00000000-0000-0000-0000-000000000000') then
    raise exception 'FAIL 5: ensure_account did not create the account';
  end if;

  raise exception 'ALL PAYMENTS LEDGER CHECKS PASSED';
end $$;
```

- [ ] **Step 2: Run it to verify it fails**

Run (Supabase MCP `execute_sql`): the file contents.
Expected: error `function private.post_entry(...) does not exist`.

- [ ] **Step 3: Write the enum migration** — `db/migrations/2026-10-10_payments_margin_keys.sql`

```sql
-- Payments: one commission rate per kind of thing paid for.
-- Courts and tournaments used to borrow the 'session' rate. Own file because a
-- new enum value cannot be used in the transaction that adds it.
alter type public.margin_key add value if not exists 'package';
alter type public.margin_key add value if not exists 'court';
alter type public.margin_key add value if not exists 'tournament';
alter type public.margin_key add value if not exists 'event';
```

- [ ] **Step 4: Write the ledger migration** — `db/migrations/2026-10-10_payments_ledger.sql`

```sql
-- Payments ledger.
--
-- Every movement of money is one entry with balanced lines (positive = debit).
-- Balances are always summed from the lines; nothing ever stores or edits a
-- balance. The ledger is append-only: a mistake is corrected by a reversing
-- entry, never by an update. Only company_cash is a real account (the company
-- Whish account); every other account is a soft split of that same money.

create table if not exists public.ledger_accounts (
  code       text primary key,
  kind       text not null check (kind in ('asset','liability','income','expense','equity')),
  owner_id   uuid references public.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.ledger_entries (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null,
  idempotency_key text not null unique,
  subject_type    text,
  subject_id      uuid,
  created_at      timestamptz not null default now()
);

create table if not exists public.ledger_lines (
  id           bigint generated always as identity primary key,
  entry_id     uuid not null references public.ledger_entries(id) on delete restrict,
  account      text not null references public.ledger_accounts(code) on delete restrict,
  amount_cents bigint not null check (amount_cents <> 0)
);
create index if not exists ledger_lines_account_idx on public.ledger_lines (account);
create index if not exists ledger_lines_entry_idx on public.ledger_lines (entry_id);

alter table public.ledger_accounts enable row level security;
alter table public.ledger_entries  enable row level security;
alter table public.ledger_lines    enable row level security;
revoke all on public.ledger_accounts, public.ledger_entries, public.ledger_lines from public, anon, authenticated;
grant select on public.ledger_accounts, public.ledger_entries, public.ledger_lines to service_role;

insert into public.ledger_accounts (code, kind) values
  ('company_cash','asset'), ('held','liability'), ('commission_revenue','income'),
  ('fee_income','income'), ('gateway_cost','expense'),
  ('undistributed_profit','equity'), ('company_capital','equity')
on conflict (code) do nothing;

-- security definer: a deferred check fires at commit, after any definer
-- function has returned, i.e. as the member whose action posted the entry --
-- and members cannot read the ledger.
create or replace function private.ledger_entry_balances() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_sum bigint;
begin
  select coalesce(sum(amount_cents), 0) into v_sum from ledger_lines where entry_id = new.entry_id;
  if v_sum <> 0 then
    raise exception 'ledger entry % does not balance (%)', new.entry_id, v_sum;
  end if;
  return null;
end $$;

drop trigger if exists ledger_lines_balance on public.ledger_lines;
create constraint trigger ledger_lines_balance
  after insert on public.ledger_lines deferrable initially deferred
  for each row execute function private.ledger_entry_balances();

create or replace function private.ledger_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'the ledger is append-only: post a reversing entry instead';
end $$;

drop trigger if exists ledger_entries_append_only on public.ledger_entries;
create trigger ledger_entries_append_only before update or delete on public.ledger_entries
  for each row execute function private.ledger_append_only();
drop trigger if exists ledger_lines_append_only on public.ledger_lines;
create trigger ledger_lines_append_only before update or delete on public.ledger_lines
  for each row execute function private.ledger_append_only();
drop trigger if exists ledger_entries_no_truncate on public.ledger_entries;
create trigger ledger_entries_no_truncate before truncate on public.ledger_entries
  for each statement execute function private.ledger_append_only();
drop trigger if exists ledger_lines_no_truncate on public.ledger_lines;
create trigger ledger_lines_no_truncate before truncate on public.ledger_lines
  for each statement execute function private.ledger_append_only();

create or replace function private.ensure_account(p_code text, p_kind text, p_owner uuid default null)
returns text language plpgsql security definer set search_path = public as $$
begin
  insert into ledger_accounts (code, kind, owner_id) values (p_code, p_kind, p_owner)
  on conflict (code) do nothing;
  return p_code;
end $$;

create or replace function private.post_entry(
  p_kind text, p_key text, p_subject_type text, p_subject_id uuid, p_lines jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_line jsonb;
begin
  select id into v_id from ledger_entries where idempotency_key = p_key;
  if v_id is not null then return v_id; end if;

  insert into ledger_entries (kind, idempotency_key, subject_type, subject_id)
  values (p_kind, p_key, p_subject_type, p_subject_id)
  returning id into v_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    if (v_line->>'amount')::bigint <> 0 then
      insert into ledger_lines (entry_id, account, amount_cents)
      values (v_id, v_line->>'account', (v_line->>'amount')::bigint);
    end if;
  end loop;
  return v_id;
end $$;

revoke all on function private.ensure_account(text, text, uuid) from public, anon, authenticated;
revoke all on function private.post_entry(text, text, text, uuid, jsonb) from public, anon, authenticated;

create or replace view public.ledger_balances as
select a.code, a.kind, a.owner_id,
       case when a.kind in ('asset','expense') then coalesce(sum(l.amount_cents), 0)
            else -coalesce(sum(l.amount_cents), 0) end as balance_cents
  from public.ledger_accounts a
  left join public.ledger_lines l on l.account = a.code
 group by a.code, a.kind, a.owner_id;
revoke all on public.ledger_balances from public, anon, authenticated;
grant select on public.ledger_balances to service_role;
```

- [ ] **Step 5: Apply both migrations** with the Supabase MCP `apply_migration`, in order: `payments_margin_keys`, then `payments_ledger`.

- [ ] **Step 6: Run the test.** Expected: `ALL PAYMENTS LEDGER CHECKS PASSED`.

- [ ] **Step 7: Commit**

```bash
git checkout payments-app
git add db/migrations/2026-10-10_payments_margin_keys.sql db/migrations/2026-10-10_payments_ledger.sql db/tests/payments_ledger.sql
git commit -m "Payments ledger: balanced, append-only money records"
```

---

### Task 2: Payment tables, settings and member RPCs

**Files:**
- Create: `db/migrations/2026-10-10_payments_core.sql` (sections 1–3 in this task; Task 3 appends section 4)
- Test: `db/tests/payments_core.sql` (sections 1–2 in this task)

**Interfaces:**
- Produces tables:
  - `payment_settings`
  - `payment_methods`
  - `payments`
  - `payment_releases`
  - `refunds`
  - `payee_payouts`
  - `disputes`
  - (columns as below)
- Produces member RPCs:
  - `public.remove_payment_method(p_id uuid) returns void`
  - `public.set_default_payment_method(p_id uuid, p_purpose text) returns void`, with `p_purpose` in (`'pay'`, `'receive'`)

- [ ] **Step 1: Write the failing test** — `db/tests/payments_core.sql`

```sql
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

  raise exception 'ALL PAYMENTS CORE CHECKS PASSED';
end $$;
```

- [ ] **Step 2: Run it to verify it fails.** Expected: `relation "payment_methods" does not exist`.

- [ ] **Step 3: Write sections 1–3 of `db/migrations/2026-10-10_payments_core.sql`**

```sql
-- Payments core: what was paid, by whom, for what, and where it is now.
--
-- payments          one checkout (price + fee), held until the service is done
-- payment_releases  one release per completed session/reservation/event; waits
--                   out the complaint period, then moves money to the payee
-- refunds / payouts the money-out queue the payments edge function works through
-- disputes          a member's "report a problem" on one release
--
-- Members read their own rows. Nobody writes these tables directly: every
-- change goes through the functions below, which also post the ledger.

-- ============================================================================
-- 1. Settings and rates
-- ============================================================================
insert into public.platform_margins (key, pct)
select k::public.margin_key, coalesce((select pct from public.platform_margins where key = 'session'), 12)
  from unnest(array['package','court','tournament','event']) as k
on conflict (key) do nothing;

create table if not exists public.payment_settings (
  id                   boolean primary key default true check (id),
  mode                 text not null default 'test' check (mode in ('test','live')),
  provider             text not null default 'test',
  enabled_kinds        text[] not null default '{}'
                       check (enabled_kinds <@ array['session','package','court','tournament','event']),
  fee_bps              int not null default 0 check (fee_bps between 0 and 2000),
  fee_flat_cents       int not null default 0 check (fee_flat_cents between 0 and 10000),
  dispute_window_hours int not null default 48 check (dispute_window_hours between 0 and 720),
  checkout_minutes     int not null default 15 check (checkout_minutes between 5 and 120),
  updated_at           timestamptz not null default now(),
  check ((mode = 'test') = (provider = 'test'))
);
insert into public.payment_settings default values on conflict (id) do nothing;
alter table public.payment_settings enable row level security;
drop policy if exists payment_settings_read on public.payment_settings;
create policy payment_settings_read on public.payment_settings for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.payment_settings from public, anon, authenticated;
grant select on public.payment_settings to anon, authenticated;

-- ============================================================================
-- 2. Tables
-- ============================================================================
create table if not exists public.payment_methods (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  kind            text not null check (kind in ('card','whish')),
  provider        text not null,
  token           text not null,
  display         text not null,
  can_pay         boolean not null default true,
  can_receive     boolean not null default false,
  default_pay     boolean not null default false,
  default_receive boolean not null default false,
  created_at      timestamptz not null default now(),
  removed_at      timestamptz,
  check (not default_receive or can_receive),
  check (not default_pay or can_pay)
);
create unique index if not exists payment_methods_one_default_pay
  on public.payment_methods (user_id) where default_pay and removed_at is null;
create unique index if not exists payment_methods_one_default_receive
  on public.payment_methods (user_id) where default_receive and removed_at is null;

create table if not exists public.payments (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('session','package','court','tournament','event')),
  subject_id       uuid not null,
  payer_id         uuid not null references public.users(id) on delete restrict,
  payee_id         uuid not null references public.users(id) on delete restrict,
  price_cents      int not null check (price_cents > 0),
  fee_cents        int not null check (fee_cents >= 0),
  rate_bps         int not null check (rate_bps between 0 and 10000),
  package_sessions int check (package_sessions > 0),
  status           text not null default 'awaiting_payment'
                   check (status in ('awaiting_payment','charging','held','closed','failed','expired','cancelled')),
  provider         text not null,
  provider_ref     text unique,
  method_id        uuid references public.payment_methods(id),
  expires_at       timestamptz not null,
  held_at          timestamptz,
  created_at       timestamptz not null default now()
);
create unique index if not exists payments_one_open_per_subject
  on public.payments (kind, subject_id, payer_id) where status in ('awaiting_payment','charging','held');
create index if not exists payments_payer_idx on public.payments (payer_id, created_at desc);
create index if not exists payments_payee_idx on public.payments (payee_id, created_at desc);

create table if not exists public.payment_releases (
  id               uuid primary key default gen_random_uuid(),
  payment_id       uuid not null references public.payments(id) on delete restrict,
  subject_id       uuid not null,
  amount_cents     int not null check (amount_cents >= 0),
  commission_cents int not null check (commission_cents >= 0),
  release_at       timestamptz not null,
  status           text not null default 'waiting' check (status in ('waiting','disputed','released','refunded')),
  released_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (payment_id, subject_id)
);

create table if not exists public.refunds (
  id           uuid primary key default gen_random_uuid(),
  payment_id   uuid not null references public.payments(id) on delete restrict,
  release_id   uuid references public.payment_releases(id),
  member_id    uuid not null references public.users(id) on delete restrict,
  amount_cents int not null check (amount_cents > 0),
  reason       text not null,
  status       text not null default 'queued' check (status in ('queued','sending','sent','failed')),
  provider_ref text,
  failure      text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);

create table if not exists public.payee_payouts (
  id           uuid primary key default gen_random_uuid(),
  payee_id     uuid not null references public.users(id) on delete restrict,
  release_id   uuid references public.payment_releases(id),
  method_id    uuid references public.payment_methods(id),
  amount_cents int not null check (amount_cents > 0),
  fee_cents    int not null default 0,
  status       text not null default 'queued' check (status in ('waiting_method','queued','sending','sent','failed')),
  provider_ref text,
  failure      text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);

create table if not exists public.disputes (
  id           uuid primary key default gen_random_uuid(),
  release_id   uuid not null unique references public.payment_releases(id),
  raised_by    uuid not null references public.users(id) on delete restrict,
  reason       text not null,
  status       text not null default 'open' check (status in ('open','released','refunded')),
  refund_cents int,
  resolved_by  uuid references public.users(id),
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- ============================================================================
-- 3. Who may read what. No member writes anything here directly.
-- ============================================================================
alter table public.payment_methods  enable row level security;
alter table public.payments         enable row level security;
alter table public.payment_releases enable row level security;
alter table public.refunds          enable row level security;
alter table public.payee_payouts          enable row level security;
alter table public.disputes         enable row level security;

revoke all on public.payment_methods, public.payments, public.payment_releases,
              public.refunds, public.payee_payouts, public.disputes from public, anon, authenticated;
grant all on public.payment_methods, public.payments, public.payment_releases,
             public.refunds, public.payee_payouts, public.disputes to service_role;

-- The token never leaves the server.
grant select (id, user_id, kind, display, can_pay, can_receive, default_pay, default_receive, created_at)
  on public.payment_methods to authenticated;
grant select on public.payments, public.payment_releases, public.refunds, public.payee_payouts, public.disputes to authenticated;

drop policy if exists payment_methods_own on public.payment_methods;
create policy payment_methods_own on public.payment_methods for select to authenticated
  using (user_id = current_app_user() and removed_at is null);

drop policy if exists payments_party on public.payments;
create policy payments_party on public.payments for select to authenticated
  using (payer_id = current_app_user() or payee_id = current_app_user());

drop policy if exists payment_releases_party on public.payment_releases;
create policy payment_releases_party on public.payment_releases for select to authenticated
  using (exists (select 1 from public.payments p where p.id = payment_id
                  and (p.payer_id = current_app_user() or p.payee_id = current_app_user())));

drop policy if exists refunds_party on public.refunds;
create policy refunds_party on public.refunds for select to authenticated
  using (exists (select 1 from public.payments p where p.id = payment_id
                  and (p.payer_id = current_app_user() or p.payee_id = current_app_user())));

drop policy if exists payee_payouts_own on public.payee_payouts;
create policy payee_payouts_own on public.payee_payouts for select to authenticated
  using (payee_id = current_app_user());

drop policy if exists disputes_party on public.disputes;
create policy disputes_party on public.disputes for select to authenticated
  using (exists (select 1 from public.payment_releases r join public.payments p on p.id = r.payment_id
                  where r.id = release_id
                    and (p.payer_id = current_app_user() or p.payee_id = current_app_user())));

create or replace function public.remove_payment_method(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := require_app_user();
begin
  update payment_methods set removed_at = now(), default_pay = false, default_receive = false
   where id = p_id and user_id = v_me and removed_at is null;
  if not found then raise exception 'That payment method is not yours.'; end if;
end $$;

create or replace function public.set_default_payment_method(p_id uuid, p_purpose text) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := require_app_user(); v_m payment_methods;
begin
  select * into v_m from payment_methods where id = p_id and user_id = v_me and removed_at is null;
  if not found then raise exception 'That payment method is not yours.'; end if;
  if p_purpose = 'pay' then
    if not v_m.can_pay then raise exception 'This method cannot be used to pay.'; end if;
    update payment_methods set default_pay = false where user_id = v_me and default_pay;
    update payment_methods set default_pay = true where id = p_id;
  elsif p_purpose = 'receive' then
    if not v_m.can_receive then raise exception 'Money can only be received into a Whish account.'; end if;
    update payment_methods set default_receive = false where user_id = v_me and default_receive;
    update payment_methods set default_receive = true where id = p_id;
    -- Anything that was waiting for somewhere to go can go now.
    update payee_payouts set method_id = p_id, status = 'queued' where payee_id = v_me and status = 'waiting_method';
  else
    raise exception 'Unknown purpose %', p_purpose;
  end if;
end $$;

revoke execute on function public.remove_payment_method(uuid) from public, anon;
grant execute on function public.remove_payment_method(uuid) to authenticated;
revoke execute on function public.set_default_payment_method(uuid, text) from public, anon;
grant execute on function public.set_default_payment_method(uuid, text) to authenticated;
```

- [ ] **Step 4: Apply** with `apply_migration` named `payments_core_tables`, using sections 1–3 only.

- [ ] **Step 5: Run the test.** Expected: `ALL PAYMENTS CORE CHECKS PASSED`.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/2026-10-10_payments_core.sql db/tests/payments_core.sql
git commit -m "Payment tables: members read their own, nobody writes directly"
```

---

### Task 3: Payment state functions

**Files:**
- Modify: `db/migrations/2026-10-10_payments_core.sql` (append section 4)
- Modify: `db/tests/payments_core.sql` (add section 3 before the final raise)

**Interfaces:**
- Consumes:
  - `private.post_entry`
  - `private.ensure_account`
  - the Task 2 tables
- Produces (private, used by Task 4 triggers and Task 5 tick):
  - `private.payments_enabled(p_kind text) returns boolean`
  - `private.open_payment(p_kind text, p_subject uuid, p_payer uuid, p_payee uuid, p_price int, p_sessions int default null) returns uuid`. It raises `This venue cannot take payments yet.` when `p_payee` is null.
  - `private.payment_unallocated(p_payment uuid) returns int`
  - `private.mark_payment_held(p_payment uuid, p_ref text, p_cost int, p_method uuid) returns void`
  - `private.fail_payment(p_payment uuid, p_status text) returns void`, where `p_status` is `failed|expired|cancelled`
  - `private.add_release(p_payment uuid, p_subject uuid) returns void`
  - `private.refund_payment(p_payment uuid, p_amount int, p_reason text, p_release uuid default null) returns void`
  - `private.release_due() returns int`
  - `private.close_if_settled(p_payment uuid) returns void`
  - `private.confirm_subject(p_payment payments) returns void`
  - `private.cancel_subject(p_payment payments) returns void`
- Produces (service_role, used by the edge function):
  - `public.payments_begin_charge(p_payment uuid) returns boolean`
  - `public.payments_end_charge(p_payment uuid) returns void`
  - `public.payments_mark_held(p_payment uuid, p_ref text, p_cost int, p_method uuid) returns void`
  - `public.payments_claim_queue(p_limit int) returns table(item_kind text, item_id uuid, amount_cents int, token text, charge_ref text)`
  - `public.payments_queue_sent(p_kind text, p_id uuid, p_ref text, p_fee int) returns void`
  - `public.payments_queue_failed(p_kind text, p_id uuid, p_message text) returns void`
  - `public.resolve_dispute(p_dispute uuid, p_refund_cents int, p_actor uuid) returns void`
- Produces (authenticated):
  - `public.raise_dispute(p_release uuid, p_reason text) returns uuid`
- Session flag: `app.payments_internal = 'on'` (set by these functions so status guards let them through; see section 4f).

- [ ] **Step 1: Add the failing test section** to `db/tests/payments_core.sql`, immediately before `raise exception 'ALL PAYMENTS CORE CHECKS PASSED';`

```sql
  -- section 3: payment state (no subject triggers yet: kinds stay disabled, subjects are fake ids)
  set local role service_role;
  declare
    v_pay uuid; v_rel uuid; v_disp uuid; v_cash bigint; v_held bigint; v_payee bigint; v_sid uuid := gen_random_uuid();
  begin
    update payment_settings set fee_bps = 300, fee_flat_cents = 0, dispute_window_hours = 48;

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
    v_pay := private.open_payment('session', gen_random_uuid(), v_me, v_other, 5000);
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

    v_pay := private.open_payment('session', gen_random_uuid(), v_me, v_other, 5000);
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
    v_pay := private.open_payment('session', gen_random_uuid(), v_me, v_other, 4000);
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
```

- [ ] **Step 2: Run it to verify it fails.** Expected: `function private.open_payment(...) does not exist`.

- [ ] **Step 3: Append section 4 to `db/migrations/2026-10-10_payments_core.sql`**

```sql
-- ============================================================================
-- 4. Payment state. Every function sets app.payments_internal so the existing
--    booking/reservation status guards let the payment system through (4f).
-- ============================================================================

-- 4a. Helpers ----------------------------------------------------------------
create or replace function private.payments_enabled(p_kind text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p_kind = any(enabled_kinds) from payment_settings), false);
$$;

create or replace function private.payment_unallocated(p_payment uuid) returns int
language sql stable security definer set search_path = public as $$
  select p.price_cents
       - coalesce((select sum(r.amount_cents) from payment_releases r where r.payment_id = p.id and r.status <> 'refunded'), 0)
       - coalesce((select sum(f.amount_cents) from refunds f where f.payment_id = p.id), 0)
    from payments p where p.id = p_payment;
$$;

create or replace function private.close_if_settled(p_payment uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  update payments set status = 'closed'
   where id = p_payment and status = 'held'
     and private.payment_unallocated(p_payment) = 0
     and not exists (select 1 from payment_releases where payment_id = p_payment and status in ('waiting','disputed'));
end $$;

-- 4b. Opening ----------------------------------------------------------------
create or replace function private.open_payment(
  p_kind text, p_subject uuid, p_payer uuid, p_payee uuid, p_price int, p_sessions int default null)
returns uuid language plpgsql security definer set search_path = public, private as $$
declare v_id uuid; v_s payment_settings; v_rate int;
begin
  if p_payee is null then raise exception 'This venue cannot take payments yet.'; end if;
  if p_payee = p_payer then raise exception 'You cannot pay yourself.'; end if;
  select * into v_s from payment_settings;
  select coalesce(
           (select round(pct * 100)::int from platform_margins where key::text = p_kind),
           (select round(pct * 100)::int from platform_margins where key = 'session'),
           1200)
    into v_rate;
  insert into payments (kind, subject_id, payer_id, payee_id, price_cents, fee_cents, rate_bps,
                        package_sessions, provider, expires_at)
  values (p_kind, p_subject, p_payer, p_payee, p_price,
          round(p_price * v_s.fee_bps / 10000.0)::int + v_s.fee_flat_cents,
          v_rate, p_sessions, v_s.provider, now() + make_interval(mins => v_s.checkout_minutes))
  returning id into v_id;
  return v_id;
end $$;

-- 4c. Subjects: confirm when paid, cancel when not ----------------------------
create or replace function private.confirm_subject(p_payment payments) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  perform set_config('app.payments_internal', 'on', true);
  if p_payment.kind = 'session' then
    update bookings set status = 'confirmed' where id = p_payment.subject_id and status = 'pending';
  elsif p_payment.kind = 'package' then
    update bookings b set status = 'confirmed'
      from bookings first
     where first.id = p_payment.subject_id
       and b.client_id = first.client_id and b.package_id = first.package_id and b.status = 'pending';
  elsif p_payment.kind = 'court' then
    update court_reservations set status = 'confirmed' where id = p_payment.subject_id and status = 'pending';
  elsif p_payment.kind = 'tournament' then
    update venue_event_entries set status = 'confirmed' where id = p_payment.subject_id and status = 'pending';
  elsif p_payment.kind = 'event' then
    perform public.mark_event_payment_settled(p_payment.subject_id, p_payment.payer_id,
                                              p_payment.provider_ref, p_payment.price_cents);
  end if;
  perform set_config('app.payments_internal', 'off', true);
end $$;

create or replace function private.cancel_subject(p_payment payments) returns void
language plpgsql security definer set search_path = public, private as $$
declare v_pkg uuid; v_coach uuid;
begin
  perform set_config('app.payments_internal', 'on', true);
  if p_payment.kind = 'session' then
    update bookings set status = 'cancelled' where id = p_payment.subject_id and status = 'pending';
  elsif p_payment.kind = 'package' then
    select package_id, coach_id into v_pkg, v_coach from bookings where id = p_payment.subject_id;
    update bookings set status = 'cancelled'
     where client_id = p_payment.payer_id and package_id = v_pkg and status = 'pending';
    -- The pack was never bought: drop its balance unless a session of it is still live.
    delete from client_package_balances
     where client_id = p_payment.payer_id and coach_id = v_coach and package_id = v_pkg
       and not exists (select 1 from bookings where client_id = p_payment.payer_id and package_id = v_pkg
                        and status in ('confirmed','completed','no_show'));
  elsif p_payment.kind = 'court' then
    update court_reservations set status = 'cancelled' where id = p_payment.subject_id and status = 'pending';
  elsif p_payment.kind = 'tournament' then
    update venue_event_entries set status = 'cancelled' where id = p_payment.subject_id and status = 'pending';
  elsif p_payment.kind = 'event' then
    delete from event_attendees
     where event_id = p_payment.subject_id and user_id = p_payment.payer_id and payment = 'pending';
  end if;
  perform set_config('app.payments_internal', 'off', true);
end $$;

-- 4d. Money in, money held, money released -----------------------------------
create or replace function private.mark_payment_held(p_payment uuid, p_ref text, p_cost int, p_method uuid)
returns void language plpgsql security definer set search_path = public, private as $$
declare v payments;
begin
  select * into v from payments where id = p_payment for update;
  if v.status in ('held','closed') then return; end if;
  if v.status <> 'charging' then raise exception 'This payment is %, not being charged.', v.status; end if;

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

  perform private.confirm_subject(v);
end $$;

create or replace function private.fail_payment(p_payment uuid, p_status text) returns void
language plpgsql security definer set search_path = public, private as $$
declare v payments;
begin
  if p_status not in ('failed','expired','cancelled') then raise exception 'Unknown failure %', p_status; end if;
  -- Only an unpaid checkout can fail. 'charging' is left alone: the gateway is mid-call.
  update payments set status = p_status where id = p_payment and status = 'awaiting_payment' returning * into v;
  if not found then return; end if;
  perform private.cancel_subject(v);
end $$;

create or replace function private.add_release(p_payment uuid, p_subject uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare v payments; v_n int; v_amount int; v_left int; v_hours int;
begin
  select * into v from payments where id = p_payment for update;
  if v.status <> 'held' then return; end if;
  v_left := private.payment_unallocated(p_payment);
  if v.kind = 'package' and v.package_sessions is not null then
    select count(*) into v_n from payment_releases where payment_id = p_payment;
    v_amount := case when v_n + 1 >= v.package_sessions then v_left
                     else v.price_cents / v.package_sessions end;
  else
    v_amount := v_left;
  end if;
  v_amount := least(v_amount, v_left);
  if v_amount <= 0 then return; end if;

  select dispute_window_hours into v_hours from payment_settings;
  insert into payment_releases (payment_id, subject_id, amount_cents, commission_cents, release_at)
  values (p_payment, p_subject, v_amount, round(v_amount * v.rate_bps / 10000.0)::int,
          now() + make_interval(hours => v_hours))
  on conflict (payment_id, subject_id) do nothing;
end $$;

create or replace function private.release_due() returns int
language plpgsql security definer set search_path = public, private as $$
declare r record; v_n int := 0; v_method uuid; v_share int;
begin
  for r in
    select rel.*, p.payee_id
      from payment_releases rel join payments p on p.id = rel.payment_id
     where rel.status = 'waiting' and rel.release_at <= now()
     for update of rel skip locked
  loop
    v_share := r.amount_cents - r.commission_cents;
    perform private.ensure_account('payee:' || r.payee_id, 'liability', r.payee_id);
    perform private.post_entry('release', 'release:' || r.id, 'payment_release', r.id, jsonb_build_array(
      jsonb_build_object('account', 'held',                 'amount', r.amount_cents),
      jsonb_build_object('account', 'payee:' || r.payee_id, 'amount', -v_share),
      jsonb_build_object('account', 'commission_revenue',   'amount', -r.commission_cents)));
    update payment_releases set status = 'released', released_at = now() where id = r.id;

    if v_share > 0 then
      select id into v_method from payment_methods
       where user_id = r.payee_id and default_receive and removed_at is null;
      insert into payee_payouts (payee_id, release_id, method_id, amount_cents, status)
      values (r.payee_id, r.id, v_method, v_share, case when v_method is null then 'waiting_method' else 'queued' end);
    end if;

    perform private.close_if_settled(r.payment_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function private.refund_payment(p_payment uuid, p_amount int, p_reason text, p_release uuid default null)
returns void language plpgsql security definer set search_path = public, private as $$
declare v payments; v_amount int; v_id uuid;
begin
  select * into v from payments where id = p_payment for update;
  if v.status <> 'held' then return; end if;
  if p_release is null then
    v_amount := least(p_amount, private.payment_unallocated(p_payment));
  else
    v_amount := least(p_amount, (select amount_cents from payment_releases where id = p_release and status = 'disputed'));
  end if;
  if coalesce(v_amount, 0) <= 0 then return; end if;

  insert into refunds (payment_id, release_id, member_id, amount_cents, reason)
  values (p_payment, p_release, v.payer_id, v_amount, p_reason) returning id into v_id;
  perform private.ensure_account('member_refund:' || v.payer_id, 'liability', v.payer_id);
  perform private.post_entry('refund', 'refund:' || v_id, 'refund', v_id, jsonb_build_array(
    jsonb_build_object('account', 'held',                         'amount', v_amount),
    jsonb_build_object('account', 'member_refund:' || v.payer_id, 'amount', -v_amount)));
  if p_release is null then perform private.close_if_settled(p_payment); end if;
end $$;

-- 4e. Edge-function RPCs (service_role) and the member's complaint -------------
create or replace function public.payments_begin_charge(p_payment uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update payments set status = 'charging'
   where id = p_payment and status = 'awaiting_payment' and expires_at > now();
  return found;
end $$;

create or replace function public.payments_end_charge(p_payment uuid) returns void
language sql security definer set search_path = public as $$
  update payments set status = 'awaiting_payment' where id = p_payment and status = 'charging';
$$;

create or replace function public.payments_mark_held(p_payment uuid, p_ref text, p_cost int, p_method uuid)
returns void language sql security definer set search_path = public, private as $$
  select private.mark_payment_held(p_payment, p_ref, p_cost, p_method);
$$;

create or replace function public.payments_claim_queue(p_limit int)
returns table(item_kind text, item_id uuid, amount_cents int, token text, charge_ref text)
language plpgsql security definer set search_path = public as $$
begin
  return query
  with p as (
    update payee_payouts o set status = 'sending'
     where o.id in (select id from payee_payouts where status = 'queued' order by created_at limit p_limit for update skip locked)
    returning o.id, o.amount_cents, o.method_id
  )
  select 'payout'::text, p.id, p.amount_cents, m.token, null::text
    from p join payment_methods m on m.id = p.method_id;

  return query
  with f as (
    update refunds r set status = 'sending'
     where r.id in (select id from refunds where status = 'queued' order by created_at limit p_limit for update skip locked)
    returning r.id, r.amount_cents, r.payment_id
  )
  select 'refund'::text, f.id, f.amount_cents, null::text, pay.provider_ref
    from f join payments pay on pay.id = f.payment_id;
end $$;

create or replace function public.payments_queue_sent(p_kind text, p_id uuid, p_ref text, p_fee int) returns void
language plpgsql security definer set search_path = public, private as $$
declare v_who uuid; v_amount int;
begin
  if p_kind = 'payout' then
    update payee_payouts set status = 'sent', provider_ref = p_ref, fee_cents = p_fee, sent_at = now()
     where id = p_id and status = 'sending' returning payee_id, amount_cents into v_who, v_amount;
    if not found then return; end if;
    perform private.post_entry('payout', 'payout:' || p_id, 'payout', p_id, jsonb_build_array(
      jsonb_build_object('account', 'payee:' || v_who, 'amount', v_amount),
      jsonb_build_object('account', 'company_cash',    'amount', -v_amount)));
  elsif p_kind = 'refund' then
    update refunds set status = 'sent', provider_ref = p_ref, sent_at = now()
     where id = p_id and status = 'sending' returning member_id, amount_cents into v_who, v_amount;
    if not found then return; end if;
    perform private.post_entry('refund_sent', 'refund_sent:' || p_id, 'refund', p_id, jsonb_build_array(
      jsonb_build_object('account', 'member_refund:' || v_who, 'amount', v_amount),
      jsonb_build_object('account', 'company_cash',            'amount', -v_amount)));
  end if;
end $$;

create or replace function public.payments_queue_failed(p_kind text, p_id uuid, p_message text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_kind = 'payout' then
    update payee_payouts set status = 'failed', failure = left(p_message, 500) where id = p_id and status = 'sending';
  elsif p_kind = 'refund' then
    update refunds set status = 'failed', failure = left(p_message, 500) where id = p_id and status = 'sending';
  end if;
end $$;

create or replace function public.raise_dispute(p_release uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me uuid := require_app_user(); v_payer uuid; v_status text; v_at timestamptz; v_id uuid;
begin
  select p.payer_id, r.status, r.release_at into v_payer, v_status, v_at
    from payment_releases r join payments p on p.id = r.payment_id
   where r.id = p_release for update of r;
  if v_payer is distinct from v_me then raise exception 'That payment is not yours.'; end if;
  if v_status <> 'waiting' or v_at <= now() then raise exception 'The complaint period for this payment has ended.'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Say briefly what went wrong.'; end if;
  update payment_releases set status = 'disputed' where id = p_release;
  insert into disputes (release_id, raised_by, reason) values (p_release, v_me, trim(p_reason)) returning id into v_id;
  return v_id;
end $$;

create or replace function public.resolve_dispute(p_dispute uuid, p_refund_cents int, p_actor uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare d disputes; r payment_releases; v_rate int; v_left int;
begin
  select * into d from disputes where id = p_dispute for update;
  if d.status <> 'open' then raise exception 'This complaint is already decided.'; end if;
  select * into r from payment_releases where id = d.release_id for update;
  if p_refund_cents < 0 or p_refund_cents > r.amount_cents then raise exception 'Refund must be between 0 and %.', r.amount_cents; end if;

  if p_refund_cents > 0 then
    perform private.refund_payment(r.payment_id, p_refund_cents, 'complaint upheld', r.id);
  end if;
  v_left := r.amount_cents - p_refund_cents;
  select rate_bps into v_rate from payments where id = r.payment_id;
  if v_left = 0 then
    update payment_releases set status = 'refunded' where id = r.id;
  else
    update payment_releases
       set amount_cents = v_left, commission_cents = round(v_left * v_rate / 10000.0)::int,
           status = 'waiting', release_at = now()
     where id = r.id;
  end if;
  update disputes set status = case when p_refund_cents > 0 then 'refunded' else 'released' end,
                      refund_cents = p_refund_cents, resolved_by = p_actor, resolved_at = now()
   where id = p_dispute;
  perform private.release_due();
  perform private.close_if_settled(r.payment_id);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.payments_begin_charge(uuid)', 'public.payments_end_charge(uuid)',
    'public.payments_mark_held(uuid, text, int, uuid)', 'public.payments_claim_queue(int)',
    'public.payments_queue_sent(text, uuid, text, int)', 'public.payments_queue_failed(text, uuid, text)',
    'public.resolve_dispute(uuid, int, uuid)']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
revoke execute on function public.raise_dispute(uuid, text) from public, anon;
grant execute on function public.raise_dispute(uuid, text) to authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

-- 4f. Let the payment system through the existing status guards. The guards
--     check current_setting('role') = 'service_role'; a cron job or a trigger
--     fired by a member is neither, so each guard gets one line that honours
--     app.payments_internal, which only the functions above set. The live
--     definition is patched in place so newer edits to a guard are kept.
do $$
declare f text; def text;
begin
  foreach f in array array['public.guard_booking_status_transition',
                           'public.guard_court_reservation_write',
                           'public.guard_event_entry_write'] loop
    def := pg_get_functiondef(f::regproc);
    if position('app.payments_internal' in def) = 0 then
      def := regexp_replace(def, E'\nbegin\n',
        E'\nbegin\n  if current_setting(''app.payments_internal'', true) = ''on'' then return new; end if;\n');
      execute def;
    end if;
  end loop;
end $$;
```

- [ ] **Step 4: Apply** section 4 with `apply_migration` named `payments_core_flow`.

- [ ] **Step 5: Verify the guards were patched.**

Run: `select count(*) from pg_proc where proname in ('guard_booking_status_transition','guard_court_reservation_write','guard_event_entry_write') and prosrc like '%app.payments_internal%';`
Expected: `3`.

- [ ] **Step 6: Run `db/tests/payments_core.sql`.** Expected: `ALL PAYMENTS CORE CHECKS PASSED`.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/2026-10-10_payments_core.sql db/tests/payments_core.sql
git commit -m "Payment state: hold, release after the complaint period, refund, dispute"
```

---

### Task 4: Hook payments onto bookings, packages, courts, tournaments and events

**Files:**
- Create: `db/migrations/2026-10-10_payments_subjects.sql`
- Test: `db/tests/payments_subjects.sql`

**Interfaces:**
- Consumes: Task 3 private functions; existing RPCs `create_booking_for_coach`, `book_package_sessions`, `reserve_court`, `confirm_session_fulfilled`, `cancel_unused_package`, `rsvp_to_event`.
- Produces: no new callable API. Behaviour: with a kind enabled, the subject is inserted `pending` and a payment opens; completion adds a release; cancellation refunds or fails the payment.

- [ ] **Step 1: Write the failing test** — `db/tests/payments_subjects.sql`

```sql
-- Payments on real subjects. Passes when it raises 'ALL PAYMENTS SUBJECT CHECKS PASSED'.
do $$
declare
  v_auth uuid := gen_random_uuid(); v_coach_auth uuid := gen_random_uuid();
  v_me uuid; v_coach uuid; v_pkg uuid; v_booking uuid; v_pay uuid; v_venue uuid; v_court uuid;
  v_slot timestamptz := date_trunc('day', now()) + interval '3 days' + interval '10 hours';
  v_err text; v_status text; v_n int;
begin
  insert into auth.users (id) values (v_auth), (v_coach_auth);
  set local role service_role;
  select id into v_me from users where auth_id = v_auth;
  select id into v_coach from users where auth_id = v_coach_auth;
  insert into coach_profiles (user_id, headline, price_cents) values (v_coach, 'ZZ pay coach', 5000);
  insert into packages (coach_id, sessions, price_cents, active) values (v_coach, 4, 20000, true) returning id into v_pkg;
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

  raise exception 'ALL PAYMENTS SUBJECT CHECKS PASSED';
end $$;
```

- [ ] **Step 2: Run it to verify it fails.** Expected: `FAIL 1: booking is confirmed`.

- [ ] **Step 3: Write `db/migrations/2026-10-10_payments_subjects.sql`**

```sql
-- Payments on the things people pay for.
--
-- The existing booking RPCs are untouched: they still insert 'confirmed'. With
-- a kind switched on in payment_settings.enabled_kinds, a BEFORE INSERT
-- trigger holds the row at 'pending' and an AFTER INSERT trigger opens its
-- payment. Paying confirms it (private.confirm_subject); not paying in time
-- cancels it (private.fail_payment). Completion adds a release; cancellation
-- refunds a paid subject or cancels an unpaid one. Switched off, nothing here
-- changes anything.

-- ---- bookings (single sessions and package sessions) -------------------------
create or replace function private.booking_payment(p_booking bookings) returns uuid
language sql stable security definer set search_path = public as $$
  select p.id from payments p
   where p_booking.package_id is null and p.kind = 'session' and p.subject_id = p_booking.id
  union all
  select * from (
    select p.id from payments p join bookings first on first.id = p.subject_id
     where p_booking.package_id is not null and p.kind = 'package'
       and p.payer_id = p_booking.client_id and first.package_id = p_booking.package_id
     order by p.created_at desc limit 1) pack
  limit 1;
$$;

create or replace function private.bookings_hold_unpaid() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.package_id is null then
    if private.payments_enabled('session') and new.total_cents > 0 then new.status := 'pending'; end if;
  elsif private.payments_enabled('package') then
    -- The first booking of a pack carries its price; the rest of the same
    -- purchase carry 0 and wait for that payment too.
    if new.total_cents > 0 or exists (
      select 1 from payments p join bookings first on first.id = p.subject_id
       where p.kind = 'package' and p.payer_id = new.client_id
         and first.package_id = new.package_id and p.status in ('awaiting_payment','charging'))
    then new.status := 'pending'; end if;
  end if;
  return new;
end $$;

create or replace function private.bookings_open_payment() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.status = 'pending' and new.total_cents > 0 then
    perform private.open_payment(
      case when new.package_id is null then 'session' else 'package' end,
      new.id, new.client_id, new.coach_id, new.total_cents,
      (select sessions from packages where id = new.package_id));
  end if;
  return null;
end $$;

create or replace function private.bookings_status_money() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare v_pay uuid; v_status text; v_price int;
begin
  v_pay := private.booking_payment(new);
  if v_pay is null then return null; end if;
  select status, price_cents into v_status, v_price from payments where id = v_pay;

  if new.status in ('completed','no_show') then
    perform private.add_release(v_pay, new.id);
  elsif new.status = 'cancelled' then
    if v_status = 'awaiting_payment' then
      perform private.fail_payment(v_pay, 'cancelled');
    elsif v_status = 'held' and new.package_id is null then
      perform private.refund_payment(v_pay, v_price, 'cancelled before the session');
    end if;
    -- A cancelled session of a paid pack moves no money on its own: unused
    -- sessions are refunded through the package cancellation.
  end if;
  return null;
end $$;

drop trigger if exists trg_bookings_hold_unpaid on public.bookings;
create trigger trg_bookings_hold_unpaid before insert on public.bookings
  for each row execute function private.bookings_hold_unpaid();
drop trigger if exists trg_bookings_open_payment on public.bookings;
create trigger trg_bookings_open_payment after insert on public.bookings
  for each row execute function private.bookings_open_payment();
drop trigger if exists trg_bookings_status_money on public.bookings;
create trigger trg_bookings_status_money after update of status on public.bookings
  for each row when (old.status is distinct from new.status)
  execute function private.bookings_status_money();

-- ---- package refunds (negotiated or free cancel) -----------------------------
create or replace function private.package_cancellation_money() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare v_pay uuid;
begin
  if new.status <> 'approved' or coalesce(new.refund_cents, 0) <= 0 then return null; end if;
  if tg_op = 'UPDATE' and old.status = 'approved' then return null; end if;
  select p.id into v_pay from payments p join bookings first on first.id = p.subject_id
   where p.kind = 'package' and p.payer_id = new.client_id and first.package_id = new.package_id
     and p.status = 'held'
   order by p.created_at desc limit 1;
  if v_pay is not null then
    perform private.refund_payment(v_pay, new.refund_cents, 'package cancellation');
  end if;
  return null;
end $$;

drop trigger if exists trg_package_cancellation_money on public.package_cancellations;
create trigger trg_package_cancellation_money after insert or update of status on public.package_cancellations
  for each row execute function private.package_cancellation_money();

-- ---- courts and tournaments ----------------------------------------------------
create or replace function private.venue_rows_hold_unpaid() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if private.payments_enabled(tg_argv[0]) and new.total_cents > 0 then new.status := 'pending'; end if;
  return new;
end $$;

create or replace function private.court_open_payment() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.status = 'pending' and new.total_cents > 0 then
    perform private.open_payment('court', new.id, new.client_id,
      (select v.owner_id from courts c join venues v on v.id = c.venue_id where c.id = new.court_id),
      new.total_cents);
  end if;
  return null;
end $$;

create or replace function private.entry_open_payment() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.status = 'pending' and new.total_cents > 0 then
    perform private.open_payment('tournament', new.id, new.client_id,
      (select v.owner_id from venue_events e join venues v on v.id = e.venue_id where e.id = new.venue_event_id),
      new.total_cents);
  end if;
  return null;
end $$;

create or replace function private.venue_rows_status_money() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare v_pay uuid; v_status text; v_price int;
begin
  select id, status, price_cents into v_pay, v_status, v_price from payments
   where kind = tg_argv[0] and subject_id = new.id order by created_at desc limit 1;
  if v_pay is null then return null; end if;
  if new.status in ('completed','no_show') then
    perform private.add_release(v_pay, new.id);
  elsif new.status = 'cancelled' then
    if v_status = 'awaiting_payment' then perform private.fail_payment(v_pay, 'cancelled');
    elsif v_status = 'held' then perform private.refund_payment(v_pay, v_price, 'cancelled before the booking');
    end if;
  end if;
  return null;
end $$;

drop trigger if exists trg_court_hold_unpaid on public.court_reservations;
create trigger trg_court_hold_unpaid before insert on public.court_reservations
  for each row execute function private.venue_rows_hold_unpaid('court');
drop trigger if exists trg_court_open_payment on public.court_reservations;
create trigger trg_court_open_payment after insert on public.court_reservations
  for each row execute function private.court_open_payment();
drop trigger if exists trg_court_status_money on public.court_reservations;
create trigger trg_court_status_money after update of status on public.court_reservations
  for each row when (old.status is distinct from new.status)
  execute function private.venue_rows_status_money('court');

drop trigger if exists trg_entry_hold_unpaid on public.venue_event_entries;
create trigger trg_entry_hold_unpaid before insert on public.venue_event_entries
  for each row execute function private.venue_rows_hold_unpaid('tournament');
drop trigger if exists trg_entry_open_payment on public.venue_event_entries;
create trigger trg_entry_open_payment after insert on public.venue_event_entries
  for each row execute function private.entry_open_payment();
drop trigger if exists trg_entry_status_money on public.venue_event_entries;
create trigger trg_entry_status_money after update of status on public.venue_event_entries
  for each row when (old.status is distinct from new.status)
  execute function private.venue_rows_status_money('tournament');

-- ---- paid community events -------------------------------------------------------
-- rsvp_to_event already writes payment = 'pending' with the fee. The organiser
-- is the community's owner.
create or replace function private.event_attendance_money() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare v_pay uuid;
begin
  if tg_op = 'DELETE' then
    select id into v_pay from payments where kind = 'event' and subject_id = old.event_id
       and payer_id = old.user_id and status = 'awaiting_payment';
    if v_pay is not null then perform private.fail_payment(v_pay, 'cancelled'); end if;
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
    select id into v_pay from payments where kind = 'event' and subject_id = new.event_id
       and payer_id = new.user_id and status = 'held';
    if v_pay is not null then
      perform private.refund_payment(v_pay, new.fee_cents, 'left the event');
    end if;
  end if;
  return null;
end $$;

drop trigger if exists trg_event_attendance_money on public.event_attendees;
create trigger trg_event_attendance_money after insert or update of payment or delete on public.event_attendees
  for each row execute function private.event_attendance_money();

-- Trigger functions are invoked by the triggers themselves, never called by a
-- role, so they need no grants. Never `revoke ... on all functions in schema
-- private`: the schema also holds the older RPC bodies that members call
-- through non-definer public wrappers, and a blanket revoke takes the app down.
```

- [ ] **Step 4: Apply** with `apply_migration` named `payments_subjects`.

- [ ] **Step 5: Run `db/tests/payments_subjects.sql`.** Expected: `ALL PAYMENTS SUBJECT CHECKS PASSED`. (`book_package_sessions` reads `at` and `label` from each slot and inserts one row per slot in a loop, so the second pack booking sees the first one's open payment.)

- [ ] **Step 6: Re-run `db/tests/release_invariants.sql`.** Expected: its usual pass message. Payments are off, so nothing changed.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/2026-10-10_payments_subjects.sql db/tests/payments_subjects.sql
git commit -m "Hold bookings, courts, entries and paid RSVPs until paid; release or refund on outcome"
```

---

### Task 5: Per-minute tick

**Files:**
- Create: `db/migrations/2026-10-10_payments_tick.sql`
- Modify: `db/tests/payments_core.sql` (add check 16 before the final raise)

**Interfaces:**
- Consumes:
  - `private.fail_payment`
  - `private.add_release`
  - `private.release_due`
  - Vault secrets `payments_function_url` and `payments_cron_secret`
- Produces:
  - `private.payments_tick() returns void`, scheduled every minute as cron job `payments-tick`
  - `public.payments_cron_secret_matches(p_secret text) returns boolean` (service_role)

- [ ] **Step 1: Add the failing check** to `db/tests/payments_core.sql` before the final raise:

```sql
  -- 16. The tick expires unpaid checkouts and releases what is due.
  set local role service_role;
  declare v_t uuid;
  begin
    v_t := private.open_payment('session', gen_random_uuid(), v_me, v_other, 1000);
    update payments set expires_at = now() - interval '1 second' where id = v_t;
    perform private.payments_tick();
    if (select status from payments where id = v_t) <> 'expired' then raise exception 'FAIL 16: tick did not expire'; end if;
  end;
```

- [ ] **Step 2: Run the test to verify it fails.** Expected: `function private.payments_tick() does not exist`.

- [ ] **Step 3: Write `db/migrations/2026-10-10_payments_tick.sql`**

```sql
-- The payments clock. Once a minute:
--   1. unpaid checkouts past their 15 minutes are expired (their booking is freed)
--   2. a paid community event counts as done one day after it starts (events
--      have no end time), which starts its complaint period
--   3. releases whose complaint period has passed are paid to the payee's balance
--   4. if payouts or refunds are queued, the payments edge function is asked to
--      send them. The URL and shared secret live in Vault:
--        select vault.create_secret('https://qievymkkprhbvxrsdukb.supabase.co/functions/v1/payments', 'payments_function_url');
--        select vault.create_secret('<random 32+ chars>', 'payments_cron_secret');
create extension if not exists pg_cron with schema pg_catalog;

create or replace function private.payments_tick() returns void
language plpgsql security definer set search_path = public, private, extensions as $$
declare r record; v_url text; v_secret text;
begin
  for r in select id from payments where status = 'awaiting_payment' and expires_at <= now()
           for update skip locked loop
    perform private.fail_payment(r.id, 'expired');
  end loop;

  for r in select p.id, p.subject_id from payments p join events e on e.id = p.subject_id
            where p.kind = 'event' and p.status = 'held' and e.starts_at < now() - interval '1 day'
              and not exists (select 1 from payment_releases rel where rel.payment_id = p.id) loop
    perform private.add_release(r.id, r.subject_id);
  end loop;

  perform private.release_due();

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
end $$;
revoke all on function private.payments_tick() from public, anon, authenticated;

create or replace function public.payments_cron_secret_matches(p_secret text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(p_secret <> '' and p_secret = (select decrypted_secret from vault.decrypted_secrets
                                                  where name = 'payments_cron_secret'), false);
$$;
revoke execute on function public.payments_cron_secret_matches(text) from public, anon, authenticated;
grant execute on function public.payments_cron_secret_matches(text) to service_role;

select cron.unschedule('payments-tick') where exists (select 1 from cron.job where jobname = 'payments-tick');
select cron.schedule('payments-tick', '* * * * *', $$select private.payments_tick()$$);
```

- [ ] **Step 4: Apply** with `apply_migration` named `payments_tick`. Then create the two Vault secrets. Generate the secret with `python -c "import secrets;print(secrets.token_urlsafe(32))"`, run the `vault.create_secret` statements from the header through `execute_sql`, and do not echo the secret back in chat.

- [ ] **Step 5: Run `db/tests/payments_core.sql`.** Expected: `ALL PAYMENTS CORE CHECKS PASSED`. Then check `select jobname, schedule from cron.job where jobname = 'payments-tick';` returns one row.

- [ ] **Step 6: Commit, push, open the Stage A PR**

```bash
git add db/migrations/2026-10-10_payments_tick.sql db/tests/payments_core.sql
git commit -m "Payments clock: expire unpaid checkouts, release after the complaint period"
git push -u origin payments-app
gh pr create --title "Payments stage A: money core (inert until switched on)" --body "Ledger, payment tables, state functions, subject triggers and the per-minute tick. enabled_kinds is empty, so no member sees any change. SQL tests: payments_ledger, payments_core, payments_subjects, plus release_invariants re-run."
```

---

---

### Task 5b: Promo codes at checkout (coach codes and platform codes)

Added 2026-10-11 at Kassem's request. Ruling recorded in the ledger: a **coach** code reduces the coach's price (coach bears it, commission on the reduced price); a **platform** code is borne by the company (payee receives full price minus normal commission; the difference is posted to `promo_expense`). Shop coupons stay out until the shop is routed.

**Files:**
- Create: `db/migrations/2026-10-11_payments_promo_codes.sql`
- Test: `db/tests/payments_promos.sql`

**Interfaces:**
- Consumes: `payments` (Task 2), `private.mark_payment_held`, `private.release_due`, `private.post_entry` (Task 3), `coach_promos(coach_id, code, pct, active)`, `platform_promos(code, pct, audience, active)`, enum `promo_audience ('all','new','inactive_30d')`.
- Produces:
  - `payments` gains `list_price_cents int` (what the payee's side is worth; equals `price_cents` when no platform code), `discount_cents int default 0`, `promo_kind text` (`coach`|`platform`), `promo_id uuid`, `promo_code text`. `price_cents` keeps its meaning: what the member pays and what is held/refunded. Constraint relaxed to `price_cents >= 0 and (price_cents > 0 or discount_cents > 0)`.
  - `promo_redemptions(id, promo_kind, promo_id, user_id, payment_id, created_at)` with `unique (promo_kind, promo_id, user_id)`.
  - `public.apply_promo_code(p_payment uuid, p_code text) returns table(price_cents int, discount_cents int, fee_cents int, total_cents int, promo_kind text)` — authenticated, payer only, payment must be `awaiting_payment`. Validates: code exists and is active; a coach code's `coach_id` must equal `payments.payee_id` and kind in (`session`,`package`); a platform code's audience: `'all'` always, `'new'` only if the member's `users.created_at > now() - interval '30 days'`, `'inactive_30d'` only if the member has no booking/reservation/entry/attendance created in the last 30 days; not already redeemed by this member. Recomputes `discount = round(original × pct / 100)`, `price_cents = original − discount`, fee from `payment_settings` on the new price (0 when price is 0). Replacing an existing code is allowed (one code at a time). Error messages: `'That code does not exist or has ended.'`, `'That code is for a different coach.'`, `'You have already used that code.'`, `'That code is not available to your account.'`, `'This payment can no longer be changed.'`.
  - `public.remove_promo_code(p_payment uuid) returns void` — restores the original price and fee.
  - `private.mark_payment_held` inserts the `promo_redemptions` row when `promo_id` is set (on conflict do nothing).
  - `private.release_due` posts, per release: `gross = round(amount × list_price_cents / price_cents)` when `price_cents > 0` else `list_price_cents` (single release) ; `commission = round(gross × rate_bps / 10000)`; lines `held +amount`, `payee −(gross − commission)`, `commission_revenue −commission`, `promo_expense +(gross − amount)` (omitted when 0). Add `promo_expense` (expense) to `ledger_accounts`.
  - Free checkout: a payment whose `price_cents + fee_cents = 0` is captured without a gateway call — Task 6's `checkout` action calls `payments_begin_charge` then `payments_mark_held(p_ref := 'free:' || id, p_cost := 0, p_method := null)` directly.

- [ ] **Step 1: Write the failing test** — `db/tests/payments_promos.sql`: one `do $$ … $$` block, fixture = member, coach with price 10000 and `coach_promos` row `COACH20` (20%), `platform_promos` rows `WELCOME50` (50%, audience all) and `NEWBIE` (audience new), a second coach; `payment_settings` fee_bps 300, enabled_kinds `{session}`. Checks: (1) `apply_promo_code` with COACH20 on a session with the first coach → price 8000, discount 2000, fee 240, promo_kind coach; (2) COACH20 on a booking with the second coach → `'That code is for a different coach.'`; (3) WELCOME50 → price 5000, list_price 10000, fee 150; after pay + complete + release: payee balance 10000 − 1200, commission 1200, promo_expense 5000, soft-split holds; (4) same member, second payment, WELCOME50 again → `'You have already used that code.'`; (5) NEWBIE for a member whose `users.created_at` is set 40 days back → `'That code is not available to your account.'`; (6) a 100% platform code → price 0, fee 0, `payments_begin_charge` + `payments_mark_held('free:…', 0, null)` captures it and the booking is confirmed; (7) `remove_promo_code` restores 10000 / fee 300; (8) apply on a `held` payment → `'This payment can no longer be changed.'`; (9) an inactive code → `'That code does not exist or has ended.'`. Final raise `ALL PAYMENTS PROMO CHECKS PASSED`.
- [ ] **Step 2: Run it to verify it fails.** Expected: `function apply_promo_code(...) does not exist`.
- [ ] **Step 3: Write the migration** implementing every item under Produces, as `create or replace` of `private.mark_payment_held` and `private.release_due` (copy the live bodies with `pg_get_functiondef` and change only the promo lines) plus the new objects. Grants: `apply_promo_code`/`remove_promo_code` revoke from public, anon; grant to authenticated. RLS on `promo_redemptions`: members select their own; writes service_role only. No blanket revoke on schema private.
- [ ] **Step 4: Apply** as `payments_promo_codes`. **Step 5: Run the test** → pass. Re-run `payments_core.sql` and `payments_subjects.sql` (they must still pass with the relaxed constraint and the new release maths). **Step 6: Commit.**

Downstream additions (carried into those tasks' dispatches):
- Task 6: the free-checkout path above; `checkout` reply unchanged.
- Task 7: `applyPromoCode(paymentId, code)` and `removePromoCode(paymentId)` in `lib/payments.ts` returning the quote; `MyPayment` gains `discountCents` and `promoCode`.
- Task 9: `CheckoutPanel` gets a "Have a code?" field with Apply/Remove, a Discount line when `discountCents > 0`, and pays without a method when the total is 0.
- Task 12: history shows the discount line.

# Stage B — Gateway (edge function)

### Task 6: `payments` edge function with the Test gateway

**Files:**
- Create: `supabase/functions/payments/adapter.ts`
- Create: `supabase/functions/payments/test-gateway.ts`
- Create: `supabase/functions/payments/index.ts`
- Modify: `supabase/config.toml` (append)

**Interfaces:**
- Consumes:
  - RPCs `payments_begin_charge`, `payments_end_charge`, `payments_mark_held`, `payments_claim_queue`, `payments_queue_sent`, `payments_queue_failed`, `payments_cron_secret_matches`
  - `current_app_user` (as the caller)
- Produces HTTP `POST /functions/v1/payments`:
  - `{action:'add-method', kind:'card', testCard:'visa_ok'|'visa_decline'}` → `{id}`
  - `{action:'add-method', kind:'whish', number}` → `{id}`
  - `{action:'checkout', paymentId, methodId}` → `{ok:true}` | `{ok:false, message}`
  - `{action:'run-queue'}`, called with header `x-payments-secret` → `{sent, failed}`
  - Errors are `{error: string}` with a 4xx/5xx status.

- [ ] **Step 1: Write `supabase/functions/payments/adapter.ts`**

```ts
// The one shape every payment provider is wrapped in. The Test gateway is the
// only implementation today; Whish and a card gateway implement the same four
// calls later, so nothing outside this folder changes when they arrive.
export type Tokenised = { token: string; display: string; canPay: boolean; canReceive: boolean };
export type ChargeResult = { ok: true; ref: string; costCents: number } | { ok: false; message: string };
export type SendResult = { ok: true; ref: string; feeCents: number } | { ok: false; message: string };

export type MethodInput =
  | { kind: "card"; testCard: string }
  | { kind: "whish"; number: string };

export interface Gateway {
  tokenise(input: MethodInput): Promise<Tokenised>;
  charge(input: { token: string; amountCents: number; reference: string }): Promise<ChargeResult>;
  payout(input: { token: string; amountCents: number; reference: string }): Promise<SendResult>;
  refund(input: { chargeRef: string; amountCents: number; reference: string }): Promise<SendResult>;
}

/** A problem with what the member sent, safe to show them as is. */
export class InputError extends Error {}
```

- [ ] **Step 2: Write `supabase/functions/payments/test-gateway.ts`**

```ts
import { Gateway, InputError } from "./adapter.ts";

// Practice mode. No real money moves and no card number is ever entered: the
// member picks one of two preset cards, one that approves and one that declines.
const TEST_CARDS: Record<string, { token: string; display: string }> = {
  visa_ok: { token: "tok_test_visa_4242", display: "Visa ·· 4242 (test)" },
  visa_decline: { token: "tok_test_visa_0002", display: "Visa ·· 0002 (test, declines)" },
};

export const WHISH_NUMBER = /^\+?961\d{7,8}$/;

export const testGateway: Gateway = {
  async tokenise(input) {
    if (input.kind === "card") {
      const card = TEST_CARDS[input.testCard];
      if (!card) throw new InputError("Pick one of the test cards.");
      return { ...card, canPay: true, canReceive: false };
    }
    const number = input.number.replace(/[\s-]/g, "");
    if (!WHISH_NUMBER.test(number)) throw new InputError("Enter a Lebanese Whish number, like +961 71 123 456.");
    return { token: `tok_test_whish_${number}`, display: `Whish ·· ${number.slice(-4)} (test)`, canPay: true, canReceive: true };
  },
  async charge({ token }) {
    if (token === TEST_CARDS.visa_decline.token) return { ok: false, message: "The test card was declined. Try another method." };
    return { ok: true, ref: `test_ch_${crypto.randomUUID()}`, costCents: 0 };
  },
  async payout() {
    return { ok: true, ref: `test_po_${crypto.randomUUID()}`, feeCents: 0 };
  },
  async refund() {
    return { ok: true, ref: `test_rf_${crypto.randomUUID()}`, feeCents: 0 };
  },
};
```

- [ ] **Step 3: Write `supabase/functions/payments/index.ts`**

```ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Gateway, InputError } from "./adapter.ts";
import { testGateway } from "./test-gateway.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Admin = ReturnType<typeof createClient>;

async function gatewayFor(admin: Admin): Promise<Gateway | null> {
  const { data } = await admin.from("payment_settings").select("mode, provider").maybeSingle();
  if (data?.mode === "test" && data?.provider === "test") return testGateway;
  return null; // Whish / card adapters arrive in later stages.
}

async function runQueue(admin: Admin, gateway: Gateway) {
  const { data: items, error } = await admin.rpc("payments_claim_queue", { p_limit: 20 });
  if (error) throw error;
  let sent = 0, failed = 0;
  for (const item of (items ?? []) as { item_kind: string; item_id: string; amount_cents: number; token: string | null; charge_ref: string | null }[]) {
    const result = item.item_kind === "payout"
      ? await gateway.payout({ token: item.token!, amountCents: item.amount_cents, reference: item.item_id })
      : await gateway.refund({ chargeRef: item.charge_ref!, amountCents: item.amount_cents, reference: item.item_id });
    if (result.ok) {
      await admin.rpc("payments_queue_sent", { p_kind: item.item_kind, p_id: item.item_id, p_ref: result.ref, p_fee: result.feeCents });
      sent++;
    } else {
      await admin.rpc("payments_queue_failed", { p_kind: item.item_kind, p_id: item.item_id, p_message: result.message });
      failed++;
    }
  }
  return { sent, failed };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Send JSON." }, 400); }
  const action = String(body.action ?? "");

  const gateway = await gatewayFor(admin);
  if (!gateway) return json({ error: "Live payments are not connected yet." }, 503);

  // The clock's call: no member, a shared secret from Vault instead.
  if (action === "run-queue") {
    const { data: ok } = await admin.rpc("payments_cron_secret_matches", { p_secret: req.headers.get("x-payments-secret") ?? "" });
    if (ok !== true) return json({ error: "Not allowed." }, 401);
    return json(await runQueue(admin, gateway));
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Sign in first." }, 401);
  const asCaller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: me } = await asCaller.rpc("current_app_user");
  if (typeof me !== "string") return json({ error: "Sign in first." }, 401);

  if (action === "add-method") {
    try {
      const kind = body.kind === "whish" ? "whish" : "card";
      const tokenised = await gateway.tokenise(kind === "whish"
        ? { kind, number: String(body.number ?? "") }
        : { kind, testCard: String(body.testCard ?? "") });
      const { count } = await admin.from("payment_methods").select("id", { count: "exact", head: true })
        .eq("user_id", me).is("removed_at", null);
      const { data: hasReceive } = await admin.from("payment_methods").select("id")
        .eq("user_id", me).eq("default_receive", true).is("removed_at", null).maybeSingle();
      const { data, error } = await admin.from("payment_methods").insert({
        user_id: me, kind, provider: "test", token: tokenised.token, display: tokenised.display,
        can_pay: tokenised.canPay, can_receive: tokenised.canReceive,
        default_pay: (count ?? 0) === 0 && tokenised.canPay,
        default_receive: !hasReceive && tokenised.canReceive,
      }).select("id").single();
      if (error) throw error;
      if (!hasReceive && tokenised.canReceive) {
        // Payouts that were waiting for somewhere to go can go now.
        await admin.from("payee_payouts").update({ method_id: data.id, status: "queued" })
          .eq("payee_id", me).eq("status", "waiting_method");
      }
      return json({ id: data.id });
    } catch (e) {
      if (e instanceof InputError) return json({ error: e.message }, 422);
      throw e;
    }
  }

  if (action === "checkout") {
    const paymentId = String(body.paymentId ?? "");
    const methodId = String(body.methodId ?? "");
    const { data: payment } = await admin.from("payments")
      .select("id, payer_id, price_cents, fee_cents, status").eq("id", paymentId).maybeSingle();
    if (!payment || payment.payer_id !== me) return json({ error: "That payment was not found." }, 404);
    const { data: method } = await admin.from("payment_methods")
      .select("id, user_id, token, can_pay, removed_at").eq("id", methodId).maybeSingle();
    if (!method || method.user_id !== me || method.removed_at || !method.can_pay) {
      return json({ error: "Pick one of your payment methods." }, 422);
    }

    const { data: begun } = await admin.rpc("payments_begin_charge", { p_payment: payment.id });
    if (begun !== true) return json({ error: "This checkout has expired or is already paid. Book again if needed." }, 409);

    const result = await gateway.charge({
      token: method.token, amountCents: payment.price_cents + payment.fee_cents, reference: payment.id,
    });
    if (!result.ok) {
      await admin.rpc("payments_end_charge", { p_payment: payment.id });
      return json({ ok: false, message: result.message });
    }
    const { error } = await admin.rpc("payments_mark_held", {
      p_payment: payment.id, p_ref: result.ref, p_cost: result.costCents, p_method: method.id,
    });
    if (error) {
      // The money was taken but not recorded. Leave the payment in 'charging'
      // (the clock never expires it) and shout, so an admin settles it by hand.
      console.error(`PAYMENTS: charged ${result.ref} for ${payment.id} but could not record it: ${error.message}`);
      return json({ error: "Your payment went through but we could not confirm the booking. We will sort it out — do not pay again." }, 500);
    }
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, 400);
});
```

- [ ] **Step 4: Append to `supabase/config.toml`**

```toml
[functions.payments]
verify_jwt = false
```

- [ ] **Step 5: Deploy** with the Supabase MCP `deploy_edge_function`, name `payments`, files `index.ts`, `adapter.ts` and `test-gateway.ts`, `verify_jwt: false`.

- [ ] **Step 6: Probe the guards live.**
1. `curl -s -X POST https://qievymkkprhbvxrsdukb.supabase.co/functions/v1/payments -H "Content-Type: application/json" -d '{"action":"run-queue"}'`
   Expected: `{"error":"Not allowed."}`
2. The same call with body `{"action":"checkout"}` and no Authorization header.
   Expected: `{"error":"Sign in first."}`
3. In SQL, run `select private.payments_tick();` then `select status_code from net._http_response order by created desc limit 1;`.
   Expected: no row while the queue is empty. That is correct: the tick only calls when something is queued.

- [ ] **Step 7: Commit, push, PR**

```bash
git add supabase/functions/payments supabase/config.toml
git commit -m "payments edge function: practice-mode gateway, checkout, payout/refund queue"
git push
gh pr create --title "Payments stage B: practice-mode gateway" --body "Edge function payments with the Test gateway. Card numbers are never entered: practice mode offers two preset test cards. run-queue only answers the Vault secret. Still inert: enabled_kinds is empty."
```

---

# Stage C — App: payment methods, checkout

### Task 7: Client library

**Files:**
- Create: `expo-app/src/lib/payments.ts`
- Test: `expo-app/tests/payments.test.cjs`

**Interfaces:**
- Consumes: `supabase` from `./supabase`; `ensureAppSession` and `currentAppUserId` from `./session`.
- Produces:

```ts
type PaymentKind = 'session' | 'package' | 'court' | 'tournament' | 'event';
type PaymentConfig = { mode: 'test' | 'live'; enabledKinds: PaymentKind[]; feeBps: number; feeFlatCents: number; disputeWindowHours: number };
const NO_PAYMENTS: PaymentConfig;
function paymentsOn(config: PaymentConfig, kind: PaymentKind): boolean;
function quote(config: PaymentConfig, priceCents: number): { priceCents: number; feeCents: number; totalCents: number };
function validWhishNumber(input: string): boolean;
type PaymentMethod = { id: string; kind: 'card' | 'whish'; display: string; canPay: boolean; canReceive: boolean; defaultPay: boolean; defaultReceive: boolean };
type Release = { id: string; amountCents: number; commissionCents: number; releaseAt: string; status: 'waiting' | 'disputed' | 'released' | 'refunded' };
type MyPayment = { id: string; kind: PaymentKind; subjectId: string; role: 'payer' | 'payee'; priceCents: number; feeCents: number; status: string; createdAt: string; expiresAt: string; releases: Release[]; refundedCents: number };
type Payout = { id: string; amountCents: number; status: 'waiting_method' | 'queued' | 'sending' | 'sent' | 'failed'; createdAt: string };
type Earnings = { notYetDoneCents: number; inComplaintPeriodCents: number; disputedCents: number; releasedCents: number; commissionCents: number };
function earningsSummary(payments: MyPayment[]): Earnings;
async function fetchPaymentConfig(): Promise<PaymentConfig>;
async function listPaymentMethods(): Promise<PaymentMethod[]>;
async function addTestCard(card: 'visa_ok' | 'visa_decline'): Promise<string>;
async function addWhish(number: string): Promise<string>;
async function removePaymentMethod(id: string): Promise<void>;
async function setDefaultPaymentMethod(id: string, purpose: 'pay' | 'receive'): Promise<void>;
async function fetchMyPayments(): Promise<MyPayment[]>;
async function fetchAwaitingPayment(): Promise<MyPayment | null>;
async function fetchMyPayouts(): Promise<Payout[]>;
async function payFor(paymentId: string, methodId: string): Promise<{ ok: true } | { ok: false; message: string }>;
async function raiseDispute(releaseId: string, reason: string): Promise<void>;
```

- [ ] **Step 1: Write the failing test** — `expo-app/tests/payments.test.cjs`

```js
// Run: node --test tests/payments.test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const { createClient } = require('@supabase/supabase-js');

const ME = '11111111-1111-1111-1111-111111111111';

function harness(responses = {}) {
  const calls = [];
  const supabase = createClient('https://example.invalid', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (url, init) => {
        const target = new URL(url);
        calls.push({ method: init?.method ?? 'GET', path: target.pathname, query: target.search, body: init?.body ? JSON.parse(init.body) : null });
        const key = Object.keys(responses).find((k) => target.pathname.endsWith(k));
        return new Response(JSON.stringify(key ? responses[key] : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    },
  });
  const dependencies = {
    './supabase': { supabase },
    './session': { ensureAppSession: async () => {}, currentAppUserId: async () => ME },
  };
  const filename = join(__dirname, '../src/lib/payments.ts');
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports,
    require: (id) => { assert.ok(id in dependencies, `Unexpected import: ${id}`); return dependencies[id]; },
    URL, Response, Headers, Promise, Array, Object, JSON, Number, Math, String, Date,
  }, { filename });
  return { module: exports, calls };
}

const ON = { mode: 'test', enabledKinds: ['session', 'court'], feeBps: 300, feeFlatCents: 25, disputeWindowHours: 48 };

test('quote adds the fee to the price, rounded like the server', () => {
  const { module } = harness();
  assert.deepEqual({ ...module.quote(ON, 10000) }, { priceCents: 10000, feeCents: 325, totalCents: 10325 });
  assert.deepEqual({ ...module.quote(ON, 1050) }, { priceCents: 1050, feeCents: 57, totalCents: 1107 }, '31.5 rounds up');
  assert.deepEqual({ ...module.quote(ON, 0) }, { priceCents: 0, feeCents: 0, totalCents: 0 }, 'free is free');
});

test('paymentsOn only for switched-on kinds', () => {
  const { module } = harness();
  assert.equal(module.paymentsOn(ON, 'session'), true);
  assert.equal(module.paymentsOn(ON, 'event'), false);
  assert.equal(module.paymentsOn(module.NO_PAYMENTS, 'session'), false);
});

test('a Whish number must be Lebanese', () => {
  const { module } = harness();
  for (const ok of ['+96171123456', '96171123456', '+961 71 123 456', '+961-3-123456']) assert.equal(module.validWhishNumber(ok), true, ok);
  for (const bad of ['', '71123456', '+33612345678', '+961 71 12', 'abc']) assert.equal(module.validWhishNumber(bad), false, bad);
});

test('earnings split by where the money is', () => {
  const { module } = harness();
  const base = { kind: 'session', subjectId: 's', role: 'payee', feeCents: 0, status: 'held', createdAt: '', expiresAt: '', refundedCents: 0 };
  const summary = module.earningsSummary([
    { ...base, id: 'a', priceCents: 5000, releases: [] },
    { ...base, id: 'b', priceCents: 5000, releases: [{ id: 'r1', amountCents: 5000, commissionCents: 600, releaseAt: '', status: 'waiting' }] },
    { ...base, id: 'c', priceCents: 5000, releases: [{ id: 'r2', amountCents: 5000, commissionCents: 600, releaseAt: '', status: 'released' }] },
    { ...base, id: 'd', priceCents: 5000, releases: [{ id: 'r3', amountCents: 5000, commissionCents: 600, releaseAt: '', status: 'disputed' }] },
    { ...base, id: 'e', priceCents: 4000, refundedCents: 4000, releases: [] },
    { ...base, id: 'f', role: 'payer', priceCents: 9999, releases: [] },
  ]);
  assert.deepEqual({ ...summary }, {
    notYetDoneCents: 5000, inComplaintPeriodCents: 4400, disputedCents: 4400, releasedCents: 4400, commissionCents: 600,
  });
});

test('payFor sends the checkout action and passes a decline through', async () => {
  const { module, calls } = harness({ '/functions/v1/payments': { ok: false, message: 'The test card was declined. Try another method.' } });
  const result = await module.payFor('p1', 'm1');
  assert.deepEqual({ ...result }, { ok: false, message: 'The test card was declined. Try another method.' });
  assert.deepEqual(calls.at(-1).body, { action: 'checkout', paymentId: 'p1', methodId: 'm1' });
});

test('fetchMyPayments marks my role and totals refunds', async () => {
  const { module } = harness({
    '/rest/v1/payments': [{
      id: 'p1', kind: 'session', subject_id: 'b1', payer_id: ME, payee_id: 'x', price_cents: 5000, fee_cents: 150,
      status: 'held', created_at: '2026-10-10T10:00:00Z', expires_at: '2026-10-10T10:15:00Z',
      payment_releases: [], refunds: [{ amount_cents: 1000 }, { amount_cents: 500 }],
    }],
  });
  const [row] = await module.fetchMyPayments();
  assert.equal(row.role, 'payer');
  assert.equal(row.refundedCents, 1500);
  assert.equal(row.feeCents, 150);
});
```

- [ ] **Step 2: Run it to verify it fails.**
Run: `cd expo-app && node --test tests/payments.test.cjs`
Expected: FAIL, `ENOENT … src/lib/payments.ts`.

- [ ] **Step 3: Write `expo-app/src/lib/payments.ts`**

```ts
import { supabase } from './supabase';
import { currentAppUserId, ensureAppSession } from './session';

// Paying inside BOOK'D. The server decides everything that matters -- price,
// fee, rate, who is paid -- and this file only reads it back and asks the
// payments edge function to charge. quote() mirrors the server's fee formula
// so a total can be shown before the payment row exists.

export type PaymentKind = 'session' | 'package' | 'court' | 'tournament' | 'event';

export type PaymentConfig = {
  mode: 'test' | 'live';
  enabledKinds: PaymentKind[];
  feeBps: number;
  feeFlatCents: number;
  disputeWindowHours: number;
};

export const NO_PAYMENTS: PaymentConfig = { mode: 'test', enabledKinds: [], feeBps: 0, feeFlatCents: 0, disputeWindowHours: 48 };

export function paymentsOn(config: PaymentConfig, kind: PaymentKind) {
  return config.enabledKinds.includes(kind);
}

/** Same formula as private.open_payment: round(price × bps / 10000) + flat. */
export function quote(config: PaymentConfig, priceCents: number) {
  const feeCents = priceCents > 0 ? Math.round((priceCents * config.feeBps) / 10000) + config.feeFlatCents : 0;
  return { priceCents, feeCents, totalCents: priceCents + feeCents };
}

export function validWhishNumber(input: string) {
  return /^\+?961\d{7,8}$/.test(input.replace(/[\s-]/g, ''));
}

export type PaymentMethod = {
  id: string; kind: 'card' | 'whish'; display: string;
  canPay: boolean; canReceive: boolean; defaultPay: boolean; defaultReceive: boolean;
};

export type Release = {
  id: string; amountCents: number; commissionCents: number; releaseAt: string;
  status: 'waiting' | 'disputed' | 'released' | 'refunded';
};

export type MyPayment = {
  id: string; kind: PaymentKind; subjectId: string; role: 'payer' | 'payee';
  priceCents: number; feeCents: number; status: string; createdAt: string; expiresAt: string;
  releases: Release[]; refundedCents: number;
};

export type Payout = {
  id: string; amountCents: number;
  status: 'waiting_method' | 'queued' | 'sending' | 'sent' | 'failed'; createdAt: string;
};

export type Earnings = {
  notYetDoneCents: number; inComplaintPeriodCents: number; disputedCents: number;
  releasedCents: number; commissionCents: number;
};

/** Where a payee's money is. Amounts after commission, except notYetDone,
 *  which is the price still held for services not yet done. */
export function earningsSummary(payments: MyPayment[]): Earnings {
  const out: Earnings = { notYetDoneCents: 0, inComplaintPeriodCents: 0, disputedCents: 0, releasedCents: 0, commissionCents: 0 };
  for (const p of payments) {
    if (p.role !== 'payee' || p.status === 'awaiting_payment' || p.status === 'charging') continue;
    let allocated = p.refundedCents;
    for (const r of p.releases) {
      if (r.status === 'refunded') continue;
      allocated += r.amountCents;
      const share = r.amountCents - r.commissionCents;
      if (r.status === 'waiting') out.inComplaintPeriodCents += share;
      else if (r.status === 'disputed') out.disputedCents += share;
      else if (r.status === 'released') { out.releasedCents += share; out.commissionCents += r.commissionCents; }
    }
    if (p.status === 'held') out.notYetDoneCents += Math.max(0, p.priceCents - allocated);
  }
  return out;
}

async function callPayments<T>(body: Record<string, unknown>): Promise<T> {
  await ensureAppSession();
  const { data, error } = await supabase.functions.invoke('payments', { method: 'POST', body });
  if (error) throw error;
  if (data && typeof data === 'object' && 'error' in data) throw new Error(String((data as { error: unknown }).error));
  return data as T;
}

export async function fetchPaymentConfig(): Promise<PaymentConfig> {
  const { data, error } = await supabase
    .from('payment_settings')
    .select('mode, enabled_kinds, fee_bps, fee_flat_cents, dispute_window_hours')
    .maybeSingle();
  // No table yet, or unreadable: behave as if payments are off.
  if (error || !data) return NO_PAYMENTS;
  return {
    mode: data.mode === 'live' ? 'live' : 'test',
    enabledKinds: (data.enabled_kinds ?? []) as PaymentKind[],
    feeBps: data.fee_bps ?? 0,
    feeFlatCents: data.fee_flat_cents ?? 0,
    disputeWindowHours: data.dispute_window_hours ?? 48,
  };
}

export async function listPaymentMethods(): Promise<PaymentMethod[]> {
  await ensureAppSession();
  const { data, error } = await supabase
    .from('payment_methods')
    .select('id, kind, display, can_pay, can_receive, default_pay, default_receive')
    .order('created_at');
  if (error) throw error;
  return (data ?? []).map((m) => ({
    id: m.id, kind: m.kind, display: m.display, canPay: m.can_pay, canReceive: m.can_receive,
    defaultPay: m.default_pay, defaultReceive: m.default_receive,
  }));
}

export async function addTestCard(card: 'visa_ok' | 'visa_decline') {
  return (await callPayments<{ id: string }>({ action: 'add-method', kind: 'card', testCard: card })).id;
}

export async function addWhish(number: string) {
  return (await callPayments<{ id: string }>({ action: 'add-method', kind: 'whish', number })).id;
}

export async function removePaymentMethod(id: string) {
  await ensureAppSession();
  const { error } = await supabase.rpc('remove_payment_method', { p_id: id });
  if (error) throw error;
}

export async function setDefaultPaymentMethod(id: string, purpose: 'pay' | 'receive') {
  await ensureAppSession();
  const { error } = await supabase.rpc('set_default_payment_method', { p_id: id, p_purpose: purpose });
  if (error) throw error;
}

const PAYMENT_COLUMNS =
  'id, kind, subject_id, payer_id, payee_id, price_cents, fee_cents, status, created_at, expires_at, '
  + 'payment_releases(id, amount_cents, commission_cents, release_at, status), refunds(amount_cents)';

type PaymentRow = {
  id: string; kind: PaymentKind; subject_id: string; payer_id: string; payee_id: string;
  price_cents: number; fee_cents: number; status: string; created_at: string; expires_at: string;
  payment_releases: { id: string; amount_cents: number; commission_cents: number; release_at: string; status: Release['status'] }[] | null;
  refunds: { amount_cents: number }[] | null;
};

function toPayment(row: PaymentRow, me: string | null): MyPayment {
  return {
    id: row.id, kind: row.kind, subjectId: row.subject_id,
    role: row.payer_id === me ? 'payer' : 'payee',
    priceCents: row.price_cents, feeCents: row.fee_cents, status: row.status,
    createdAt: row.created_at, expiresAt: row.expires_at,
    releases: (row.payment_releases ?? []).map((r) => ({
      id: r.id, amountCents: r.amount_cents, commissionCents: r.commission_cents, releaseAt: r.release_at, status: r.status,
    })),
    refundedCents: (row.refunds ?? []).reduce((sum, r) => sum + r.amount_cents, 0),
  };
}

export async function fetchMyPayments(): Promise<MyPayment[]> {
  await ensureAppSession();
  const me = await currentAppUserId();
  const { data, error } = await supabase.from('payments').select(PAYMENT_COLUMNS)
    .order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return ((data ?? []) as unknown as PaymentRow[]).map((row) => toPayment(row, me));
}

/** The checkout the member just started: their newest unpaid payment. */
export async function fetchAwaitingPayment(): Promise<MyPayment | null> {
  await ensureAppSession();
  const me = await currentAppUserId();
  if (!me) return null;
  const { data, error } = await supabase.from('payments').select(PAYMENT_COLUMNS)
    .eq('payer_id', me).eq('status', 'awaiting_payment')
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  const row = (data ?? [])[0] as unknown as PaymentRow | undefined;
  return row ? toPayment(row, me) : null;
}

export async function fetchMyPayouts(): Promise<Payout[]> {
  await ensureAppSession();
  const { data, error } = await supabase.from('payee_payouts')
    .select('id, amount_cents, status, created_at').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return (data ?? []).map((p) => ({ id: p.id, amountCents: p.amount_cents, status: p.status, createdAt: p.created_at }));
}

export async function payFor(paymentId: string, methodId: string) {
  return callPayments<{ ok: true } | { ok: false; message: string }>({ action: 'checkout', paymentId, methodId });
}

export async function raiseDispute(releaseId: string, reason: string) {
  await ensureAppSession();
  const { error } = await supabase.rpc('raise_dispute', { p_release: releaseId, p_reason: reason });
  if (error) throw error;
}
```

- [ ] **Step 4: Run the tests.** Run: `cd expo-app && node --test tests/payments.test.cjs`. Expected: all 6 pass. If `currentAppUserId` is not exported from `./session`, check `src/lib/session.ts` and import it from where `lib/availability.ts:3` does.

- [ ] **Step 5: Typecheck.** Run: `cd expo-app && npx tsc --noEmit -p tsconfig.json`. Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add expo-app/src/lib/payments.ts expo-app/tests/payments.test.cjs
git commit -m "Client payments library: config, methods, history, earnings, checkout"
```

---

### Task 8: Payment methods screen (APP-1) and the practice banner (APP-8)

**Files:**
- Create: `expo-app/src/components/usePaymentConfig.ts`
- Create: `expo-app/src/components/PracticeBanner.tsx`
- Create: `expo-app/src/components/AddPaymentMethod.tsx`
- Create: `expo-app/src/overlays/PaymentMethodsOverlay.tsx`
- Modify: `expo-app/src/navigation/OverlayRouter.tsx` (add case)
- Modify: `expo-app/src/screens/ProfileScreen.tsx` (Settings card, after the Notifications row near line 220)

**Interfaces:**
- Consumes: Task 7 lib.
- Produces:
  - `usePaymentConfig(): PaymentConfig`
  - `<PracticeBanner />`
  - `<AddPaymentMethod onAdded={(id: string) => void} />`
  - overlay id `'paymentMethods'`

- [ ] **Step 1: Write `expo-app/src/components/usePaymentConfig.ts`**

```ts
import { useEffect, useState } from 'react';
import { fetchPaymentConfig, NO_PAYMENTS, PaymentConfig } from '../lib/payments';

// One read per app session. Settings change through the console a few times a
// year; a reload picks the change up.
let pending: Promise<PaymentConfig> | null = null;

export function usePaymentConfig(): PaymentConfig {
  const [config, setConfig] = useState<PaymentConfig>(NO_PAYMENTS);
  useEffect(() => {
    let live = true;
    pending ??= fetchPaymentConfig().catch(() => NO_PAYMENTS);
    void pending.then((value) => { if (live) setConfig(value); });
    return () => { live = false; };
  }, []);
  return config;
}
```

- [ ] **Step 2: Write `expo-app/src/components/PracticeBanner.tsx`**

```tsx
import React from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../theme';
import { usePaymentConfig } from './usePaymentConfig';

/** Shown wherever money appears while the gateway is the Test one. */
export function PracticeBanner() {
  const { c, t } = useTheme();
  const config = usePaymentConfig();
  if (config.mode !== 'test' || config.enabledKinds.length === 0) return null;
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: c.amberText, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 12 }}>
      <Text style={[t.bodySm, { color: c.ink, fontWeight: '700' }]}>Practice mode — no real money</Text>
    </View>
  );
}
```

- [ ] **Step 3: Write `expo-app/src/components/AddPaymentMethod.tsx`**

```tsx
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { addTestCard, addWhish, validWhishNumber } from '../lib/payments';
import { useTheme } from '../theme';
import { Button, Field, Row } from './ui';
import { usePaymentConfig } from './usePaymentConfig';

/** Add a way to pay or be paid. Card numbers are never typed into BOOK'D: in
 *  practice mode there are two preset test cards; live cards will open the
 *  gateway's own form. */
export function AddPaymentMethod({ onAdded }: { onAdded: (id: string) => void }) {
  const { c, t } = useTheme();
  const config = usePaymentConfig();
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<string>) => {
    setBusy(label); setError(null);
    try { onAdded(await action()); setNumber(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not add that method.'); }
    finally { setBusy(null); }
  };

  return (
    <View style={{ gap: 10 }}>
      {config.mode === 'test' ? (
        <Row gap={8} style={{ flexWrap: 'wrap' }}>
          <Button label="Add test Visa (approves)" tone="secondary" busy={busy === 'ok'}
            onPress={() => void run('ok', () => addTestCard('visa_ok'))} />
          <Button label="Add test Visa (declines)" tone="secondary" busy={busy === 'decline'}
            onPress={() => void run('decline', () => addTestCard('visa_decline'))} />
        </Row>
      ) : (
        <Text style={[t.bodySm, { color: c.txt3 }]}>Cards open the payment company's secure form. Coming with live payments.</Text>
      )}
      <Field label="Whish number" value={number} onChange={setNumber} placeholder="+961 71 123 456" keyboardType="phone-pad" />
      <Button label="Add Whish account" tone="primary" busy={busy === 'whish'}
        enabled={validWhishNumber(number)}
        onPress={() => void run('whish', () => addWhish(number))} />
      {error && <Text accessibilityRole="alert" style={[t.bodySm, { color: c.danger }]}>{error}</Text>}
    </View>
  );
}
```

- [ ] **Step 4: Write `expo-app/src/overlays/PaymentMethodsOverlay.tsx`**

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { AddPaymentMethod } from '../components/AddPaymentMethod';
import { OverlayHeader, OverlayScaffold } from '../components/Overlay';
import { PracticeBanner } from '../components/PracticeBanner';
import { Button, Card, Chip, ErrorNote, Row, SectionHeading } from '../components/ui';
import { listPaymentMethods, PaymentMethod, removePaymentMethod, setDefaultPaymentMethod } from '../lib/payments';
import { useStore } from '../state/store';
import { useTheme } from '../theme';

export function PaymentMethodsOverlay() {
  const { c, t } = useTheme();
  const s = useStore();
  const [methods, setMethods] = useState<PaymentMethod[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setMethods(await listPaymentMethods()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load your payment methods.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (action: () => Promise<void>) => {
    try { await action(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'That did not work.'); }
  };

  return (
    <OverlayScaffold header={<OverlayHeader title="Payment methods" onBack={s.closeOverlay} />}>
      <View style={{ padding: 16, gap: 16 }}>
        <PracticeBanner />
        {error && <ErrorNote message={error} onRetry={() => void load()} retryLabel="Load payment methods again" />}
        <SectionHeading>Saved</SectionHeading>
        {methods?.length === 0 && <Text style={[t.body, { color: c.txt3 }]}>Nothing saved yet.</Text>}
        {methods?.map((m) => (
          <Card key={m.id} style={{ padding: 14, gap: 10 }}>
            <Text style={[t.bodyLg, { color: c.txt }]}>{m.display}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {m.canPay && <Chip label={m.defaultPay ? 'Pays by default' : 'Pay with this'} active={m.defaultPay}
                onPress={() => void act(() => setDefaultPaymentMethod(m.id, 'pay'))} />}
              {m.canReceive && <Chip label={m.defaultReceive ? 'Receives payouts' : 'Receive payouts here'} active={m.defaultReceive}
                onPress={() => void act(() => setDefaultPaymentMethod(m.id, 'receive'))} />}
            </Row>
            <Button label="Remove" tone="secondary" onPress={() => void act(() => removePaymentMethod(m.id))}
              accessibilityLabel={`Remove ${m.display}`} />
          </Card>
        ))}
        <SectionHeading>Add</SectionHeading>
        <Text style={[t.bodySm, { color: c.txt3 }]}>To receive money from bookings, add a Whish account.</Text>
        <AddPaymentMethod onAdded={() => void load()} />
      </View>
    </OverlayScaffold>
  );
}
```

- [ ] **Step 5: Route it.** In `expo-app/src/navigation/OverlayRouter.tsx`, add the import beside the others and a case inside the `switch (id)`:

```tsx
import { PaymentMethodsOverlay } from '../overlays/PaymentMethodsOverlay';
```
```tsx
    case 'paymentMethods':
      return <PaymentMethodsOverlay />;
```

- [ ] **Step 6: Add the Settings row.** In `expo-app/src/screens/ProfileScreen.tsx`, directly after the `Notifications` `GroupRow` and before `</Card>`:

```tsx
        <RowDivider />
        <GroupRow
          icon="credit-card"
          title="Payment methods"
          body="Cards and Whish, to pay and to be paid"
          onPress={() => s.set('overlay', 'paymentMethods')}
        />
```

- [ ] **Step 7: Typecheck and run all tests.**
Run: `cd expo-app && npx tsc --noEmit -p tsconfig.json && node --test "tests/*.test.cjs"`
Expected: clean, with every test passing.

- [ ] **Step 8: Verify in the browser.** Start the dev server with preview_start (`.claude/launch.json` in `expo-app`), then go to Profile and open "Payment methods".
- With `enabled_kinds` empty, the banner is hidden and the page shows "Nothing saved yet."
- In a signed-in QA account (one Kassem provides; do not create accounts on production), add the test Visa that approves. It appears with "Pays by default".

- [ ] **Step 9: Commit**

```bash
git add expo-app/src/components/usePaymentConfig.ts expo-app/src/components/PracticeBanner.tsx expo-app/src/components/AddPaymentMethod.tsx expo-app/src/overlays/PaymentMethodsOverlay.tsx expo-app/src/navigation/OverlayRouter.tsx expo-app/src/screens/ProfileScreen.tsx
git commit -m "Payment methods in Settings, with a practice-mode banner"
```

---

### Task 9: Checkout panel, wired into coach sessions and packages (APP-2)

**Files:**
- Create: `expo-app/src/components/CheckoutPanel.tsx`
- Modify: `expo-app/src/overlays/BookingOverlay.tsx`:
  - the success screen (around lines 340–360)
  - the bottom-bar caption (around lines 374–386)

**Interfaces:**
- Consumes:
  - `fetchAwaitingPayment`, `listPaymentMethods`, `payFor`, `quote`, `paymentsOn`
  - `usePaymentConfig`, `AddPaymentMethod`, `PracticeBanner`
  - `formatCents` from `../lib/bookings`
- Produces: `<CheckoutPanel onPaid={() => void} />`. It pays the member's newest awaiting payment and renders nothing once there is none.

- [ ] **Step 1: Write `expo-app/src/components/CheckoutPanel.tsx`**

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { formatCents } from '../lib/bookings';
import { fetchAwaitingPayment, listPaymentMethods, MyPayment, PaymentMethod, payFor } from '../lib/payments';
import { useTheme } from '../theme';
import { AddPaymentMethod } from './AddPaymentMethod';
import { PracticeBanner } from './PracticeBanner';
import { Chip, Row, VoltButton } from './ui';

/** Pay for what was just booked. The booking is held as pending until this
 *  succeeds and is released automatically if it does not within the checkout
 *  time, so leaving this screen never leaves a half-paid booking behind. */
export function CheckoutPanel({ onPaid }: { onPaid: () => void }) {
  const { c, t } = useTheme();
  const [payment, setPayment] = useState<MyPayment | null | undefined>(undefined);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, m] = await Promise.all([fetchAwaitingPayment(), listPaymentMethods()]);
    const payable = m.filter((x) => x.canPay);
    setPayment(p);
    setMethods(payable);
    setChosen((current) => current ?? payable.find((x) => x.defaultPay)?.id ?? payable[0]?.id ?? null);
  }, []);
  useEffect(() => { void load().catch(() => setPayment(null)); }, [load]);

  if (payment === undefined) return <ActivityIndicator color={c.accent} style={{ marginVertical: 24 }} />;
  if (payment === null) return null;

  const minutesLeft = Math.max(0, Math.ceil((Date.parse(payment.expiresAt) - Date.now()) / 60000));
  const pay = async () => {
    if (!chosen) return;
    setBusy(true); setMessage(null);
    try {
      const result = await payFor(payment.id, chosen);
      if (result.ok) onPaid();
      else setMessage(result.message);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'The payment did not go through.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 12, width: '100%' }}>
      <PracticeBanner />
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={[t.body, { color: c.txt2 }]}>Price</Text>
        <Text style={[t.body, { color: c.txt }]}>{formatCents(payment.priceCents)}</Text>
      </Row>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={[t.body, { color: c.txt2 }]}>Payment fee</Text>
        <Text style={[t.body, { color: c.txt }]}>{formatCents(payment.feeCents)}</Text>
      </Row>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={[t.bodyLg, { color: c.txt }]}>Total</Text>
        <Text style={[t.price, { color: c.accent }]}>{formatCents(payment.priceCents + payment.feeCents)}</Text>
      </Row>
      <Text style={[t.caption, { color: c.txt3 }]}>
        The money is held by BOOK'D until the session is done. Cancel before then and the price comes back to you;
        the payment fee does not. Finish within {minutesLeft} min or the slot is released.
      </Text>
      {methods.length > 0 ? (
        <Row gap={8} style={{ flexWrap: 'wrap' }}>
          {methods.map((m) => (
            <Chip key={m.id} label={m.display} active={chosen === m.id} onPress={() => setChosen(m.id)} />
          ))}
        </Row>
      ) : (
        <AddPaymentMethod onAdded={(id) => { setChosen(id); void load(); }} />
      )}
      {message && <Text accessibilityRole="alert" style={[t.bodySm, { color: c.danger }]}>{message}</Text>}
      <VoltButton
        label={`Pay ${formatCents(payment.priceCents + payment.feeCents)}`}
        enabled={Boolean(chosen) && minutesLeft > 0}
        busy={busy}
        busyLabel="Paying..."
        onPress={() => void pay()}
      />
    </View>
  );
}
```

- [ ] **Step 2: Wire the success screen in `BookingOverlay.tsx`.** Add the imports:

```tsx
import { CheckoutPanel } from '../components/CheckoutPanel';
import { usePaymentConfig } from '../components/usePaymentConfig';
import { paymentsOn } from '../lib/payments';
```

Add these next to the other `React.useState` calls (around line 136):

```tsx
  const paymentConfig = usePaymentConfig();
  const [paid, setPaid] = React.useState(false);
  const payKind = selectedPkg?.packageId ? 'package' : 'session';
  const takesPayment = paymentsOn(paymentConfig, payKind);
```

At the start of the success branch, which currently opens with `<View style={{ paddingHorizontal: 18, alignItems: 'center', paddingTop: 60 }}>` and "You are booked!", insert a pay step that is shown first when something is owed:

```tsx
          {takesPayment && bookingQuote && !bookingQuote.redeeming && bookingQuote.dueNow > 0 && !paid ? (
            <View style={{ width: '100%' }}>
              <Text style={[t.overlayTitle, { fontSize: 22, color: c.txt, marginBottom: 12 }]}>Pay to confirm</Text>
              <CheckoutPanel onPaid={() => setPaid(true)} />
            </View>
          ) : (
            <>
              {/* existing check icon, "You are booked!", summary text and "View in bookings" button, unchanged */}
            </>
          )}
```

Move the existing success children inside the `<>…</>`.

Then replace the "payable … directly" sentence in that branch:

```tsx
                : bookingQuote.dueNow > 0
                  ? takesPayment
                    ? 'Paid. The money is held until the session is done.'
                    : `$${bookingQuote.dueNow} is payable to ${p.name.split(' ')[0]} directly at your session.`
                  : `Agree the price with ${p.name.split(' ')[0]} directly — BOOK'D does not take payment.`}
```

- [ ] **Step 3: Update the bottom-bar caption** (around line 384):

```tsx
                  : dueNow > 0
                    ? takesPayment
                      ? "You pay when you confirm. BOOK'D holds the money until the session is done."
                      : "Payable to the coach at your session — BOOK'D does not take payment."
                    : "This coach has not set a price. Agree it with them directly — BOOK'D does not take payment."}
```

- [ ] **Step 4: Typecheck and run all tests.** Expected: clean, and all tests pass.

- [ ] **Step 5: Verify in the browser** with a QA account. The setting change below needs Kassem's yes, because it is visible to everyone.
1. Through `execute_sql`, set `enabled_kinds = '{session,package}'`.
2. Book a priced coach session: "Pay to confirm" appears.
3. Pick "Visa ·· 0002 (test, declines)": "The test card was declined. Try another method." appears.
4. Pick the approving card: "You are booked!" appears, and Bookings shows the session as confirmed.
5. Check the SQL: `payments.status = 'held'` and one `checkout:` ledger entry.
6. Set `enabled_kinds = '{}'` again afterwards unless Kassem says keep it on.

- [ ] **Step 6: Commit**

```bash
git add expo-app/src/components/CheckoutPanel.tsx expo-app/src/overlays/BookingOverlay.tsx
git commit -m "Pay to confirm a coach session or package"
```

---

### Task 10: Checkout for courts, tournaments and paid events (APP-2)

**Files:**
- Modify: `expo-app/src/overlays/RsvpSheet.tsx`:
  - `confirm` (around line 131)
  - the `if (booked)` branch (around line 137)
- Modify: `expo-app/src/overlays/CommunityOverlays.tsx`:
  - the fee caption and "I'm going" button (around lines 133–148)

**Interfaces:**
- Consumes:
  - `CheckoutPanel`, `usePaymentConfig`, `paymentsOn`
  - `rsvpToEvent(eventId, going): Promise<RsvpOutcome>` from `../lib/events`

- [ ] **Step 1: RsvpSheet.** Add the imports `CheckoutPanel`, `usePaymentConfig` and `paymentsOn`. Beside `const [booked, setBooked] = useState(false);` add:

```tsx
  const paymentConfig = usePaymentConfig();
  const [paid, setPaid] = useState(false);
  const takesPayment = paymentsOn(paymentConfig, perHour ? 'court' : 'tournament');
```

At the top of the `if (booked)` branch, before the existing `return (<Sheet title="Court reserved" …`:

```tsx
  if (booked && takesPayment && !paid) {
    return (
      <Sheet title="Pay to confirm" subtitle={venue ? venue.name : ''} onClose={close}>
        <View style={{ padding: 16 }}>
          <CheckoutPanel onPaid={() => setPaid(true)} />
        </View>
      </Sheet>
    );
  }
```

Check that `Sheet`'s props in this file accept children and no footer. If `footer` is required, pass `footer={null}`.

Also change the Total row label "Estimate · confirmed by the venue" to:

```tsx
{takesPayment ? 'You pay this when you confirm' : 'Estimate · confirmed by the venue'}
```

- [ ] **Step 2: Paid community events.** In `CommunityOverlays.tsx`, add the imports `CheckoutPanel`, `usePaymentConfig`, `paymentsOn` and `rsvpToEvent`. Add this state in the component that renders the button:

```tsx
  const paymentConfig = usePaymentConfig();
  const eventTakesPayment = paymentsOn(paymentConfig, 'event') && (detail?.feeCents ?? 0) > 0;
  const [paying, setPaying] = React.useState(false);
  const [rsvpError, setRsvpError] = React.useState<string | null>(null);
```

Replace the fee caption text:

```tsx
              {eventTakesPayment
                ? `${feeLabel(detail!.feeCents)} per person, paid now and held by BOOK'D until the event.`
                : `${feeLabel(detail!.feeCents)} per person, settled with the organiser directly.`}
```

Replace the button's `onPress`:

```tsx
            onPress={() => {
              if (going) { setWithdrawing(true); return; }
              if (!eventTakesPayment) { void s.toggleGoing(ev.id); return; }
              setRsvpError(null);
              void rsvpToEvent(ev.id, true)
                .then((outcome) => { if (outcome.payment === 'pending') setPaying(true); })
                .catch((e) => setRsvpError(e instanceof Error ? e.message : 'Could not save your RSVP.'));
            }}
```

Directly above the `<Button` add:

```tsx
          {paying && (
            <View style={{ marginBottom: 12 }}>
              <CheckoutPanel onPaid={() => { setPaying(false); void s.toggleGoing(ev.id); }} />
            </View>
          )}
          {rsvpError && <Text accessibilityRole="alert" style={[t.bodySm, { color: c.danger, marginBottom: 10 }]}>{rsvpError}</Text>}
```

After paying, the existing `toggleGoing` refreshes the "going" list and attendee count. The server already has the member as going (`payment = 'paid'`), so `set_event_attendance(id, true)` is a no-op upsert. Before relying on that, check that `set_event_attendance` with `going=true` does not reset `payment`: read its latest definition with `select pg_get_functiondef('public.set_event_attendance'::regproc);`. If it does reset it, replace the `toggleGoing` call with `useStore.getState().set('goingEvents', [...useStore.getState().goingEvents, ev.id])`.

- [ ] **Step 3: Typecheck and run all tests.** Expected: clean and all pass.

- [ ] **Step 4: Verify in the browser** with a QA account. The setting change needs Kassem's yes.
1. With `enabled_kinds` including `court` and `event`, reserve a court at a venue that has an owner: the sheet shows "Pay to confirm", and paying turns it into "Court reserved".
2. RSVP to a paid community event: the checkout appears, and paying shows "You're going".
3. Reset `enabled_kinds` afterwards.

- [ ] **Step 5: Commit**

```bash
git add expo-app/src/overlays/RsvpSheet.tsx expo-app/src/overlays/CommunityOverlays.tsx
git commit -m "Pay to confirm courts, tournaments and paid community events"
```

---

# Stage D — App: after the payment

### Task 11: Earnings screen (APP-3)

**Files:**
- Create: `expo-app/src/overlays/EarningsOverlay.tsx`
- Modify: `OverlayRouter.tsx` (add case `'earnings'`)
- Modify: `ProfileScreen.tsx` (add row)

**Interfaces:**
- Consumes: `fetchMyPayments`, `fetchMyPayouts`, `earningsSummary`, `listPaymentMethods`, `PracticeBanner`, `formatCents`.

- [ ] **Step 1: Write `expo-app/src/overlays/EarningsOverlay.tsx`**

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { OverlayHeader, OverlayScaffold } from '../components/Overlay';
import { PracticeBanner } from '../components/PracticeBanner';
import { Button, Card, ErrorNote, Row, SectionHeading } from '../components/ui';
import { formatCents } from '../lib/bookings';
import { Earnings, earningsSummary, fetchMyPayments, fetchMyPayouts, listPaymentMethods, Payout } from '../lib/payments';
import { useStore } from '../state/store';
import { useTheme } from '../theme';

const PAYOUT_LABEL: Record<Payout['status'], string> = {
  waiting_method: 'Waiting for your Whish account',
  queued: 'Sending', sending: 'Sending', sent: 'Sent', failed: 'Failed — BOOK\'D will retry',
};

export function EarningsOverlay() {
  const { c, t } = useTheme();
  const s = useStore();
  const [summary, setSummary] = useState<Earnings | null>(null);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [canReceive, setCanReceive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [payments, outs, methods] = await Promise.all([fetchMyPayments(), fetchMyPayouts(), listPaymentMethods()]);
      setSummary(earningsSummary(payments));
      setPayouts(outs);
      setCanReceive(methods.some((m) => m.defaultReceive));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your earnings.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const line = (label: string, cents: number, note: string) => (
    <Row style={{ justifyContent: 'space-between', paddingVertical: 8 }}>
      <View style={{ flex: 1 }}>
        <Text style={[t.body, { color: c.txt }]}>{label}</Text>
        <Text style={[t.caption, { color: c.txt3 }]}>{note}</Text>
      </View>
      <Text style={[t.bodyLg, { color: c.txt }]}>{formatCents(cents)}</Text>
    </Row>
  );

  return (
    <OverlayScaffold header={<OverlayHeader title="Earnings" onBack={s.closeOverlay} />}>
      <View style={{ padding: 16, gap: 16 }}>
        <PracticeBanner />
        {error && <ErrorNote message={error} onRetry={() => void load()} retryLabel="Load earnings again" />}
        {!canReceive && (
          <Card style={{ padding: 14, gap: 10 }}>
            <Text style={[t.body, { color: c.txt }]}>Add a Whish account so BOOK'D can send you what you earn.</Text>
            <Button label="Add Whish account" tone="primary" onPress={() => s.set('overlay', 'paymentMethods')} />
          </Card>
        )}
        {summary && (
          <Card style={{ padding: 14 }}>
            {line('Not yet done', summary.notYetDoneCents, 'Paid by members for sessions still to come')}
            {line('In complaint period', summary.inComplaintPeriodCents, 'Done; released to you after the complaint period')}
            {line('Under review', summary.disputedCents, 'A member reported a problem; an admin decides')}
            {line('Released to you', summary.releasedCents, `After BOOK'D's ${formatCents(summary.commissionCents)} commission`)}
          </Card>
        )}
        <SectionHeading>Payouts</SectionHeading>
        {payouts.length === 0 && <Text style={[t.body, { color: c.txt3 }]}>No payouts yet.</Text>}
        {payouts.map((p) => (
          <Row key={p.id} style={{ justifyContent: 'space-between' }}>
            <Text style={[t.body, { color: c.txt2 }]}>{new Date(p.createdAt).toLocaleDateString()} · {PAYOUT_LABEL[p.status]}</Text>
            <Text style={[t.body, { color: c.txt }]}>{formatCents(p.amountCents)}</Text>
          </Row>
        ))}
      </View>
    </OverlayScaffold>
  );
}
```

- [ ] **Step 2: Route it and add the row.** In `OverlayRouter.tsx`:

```tsx
import { EarningsOverlay } from '../overlays/EarningsOverlay';
```
```tsx
    case 'earnings':
      return <EarningsOverlay />;
```

In `ProfileScreen.tsx`, after the Payment methods row from Task 8:

```tsx
        <RowDivider />
        <GroupRow
          icon="trending-up"
          title="Earnings"
          body="Money from sessions, courts and events you run"
          onPress={() => s.set('overlay', 'earnings')}
        />
```

- [ ] **Step 3: Typecheck, run all tests, then verify in the browser** with the QA coach account after the Task 9 payment:
- "Not yet done" shows the session price.
- After `update bookings set status='completed'` through SQL, the money moves to "In complaint period".
- After setting `release_at` into the past and running `select private.payments_tick();`, it moves to "Released to you".
- The payout shows "Waiting for your Whish account" until a Whish account is added, then "Sent" within a minute.

- [ ] **Step 4: Commit**

```bash
git add expo-app/src/overlays/EarningsOverlay.tsx expo-app/src/navigation/OverlayRouter.tsx expo-app/src/screens/ProfileScreen.tsx
git commit -m "Earnings: held, in complaint period, under review, released, payouts"
```

---

### Task 12: Payment history, receipts, pay now, report a problem (APP-4, APP-6)

**Files:**
- Create: `expo-app/src/overlays/PaymentHistoryOverlay.tsx`
- Modify:
  - `OverlayRouter.tsx` (case `'paymentHistory'`)
  - `ProfileScreen.tsx` (row)
  - `BookingsOverlay.tsx` (the amber `'pending'` chip near line 1145)

**Interfaces:**
- Consumes: `fetchMyPayments`, `raiseDispute`, `CheckoutPanel`, `usePaymentConfig`, `formatCents`.

- [ ] **Step 1: Write `expo-app/src/overlays/PaymentHistoryOverlay.tsx`**

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { CheckoutPanel } from '../components/CheckoutPanel';
import { OverlayHeader, OverlayScaffold } from '../components/Overlay';
import { PracticeBanner } from '../components/PracticeBanner';
import { Button, Card, ErrorNote, Field, Row } from '../components/ui';
import { formatCents } from '../lib/bookings';
import { fetchMyPayments, MyPayment, raiseDispute, Release } from '../lib/payments';
import { useStore } from '../state/store';
import { useTheme } from '../theme';

const KIND_LABEL: Record<MyPayment['kind'], string> = {
  session: 'Coach session', package: 'Session pack', court: 'Court', tournament: 'Tournament entry', event: 'Event',
};
const STATUS_LABEL: Record<string, string> = {
  awaiting_payment: 'Waiting for payment', charging: 'Paying…', held: 'Paid · held until done',
  closed: 'Settled', failed: 'Payment failed', expired: 'Checkout expired', cancelled: 'Cancelled',
};

function openComplaint(r: Release) {
  return r.status === 'waiting' && Date.parse(r.releaseAt) > Date.now();
}

export function PaymentHistoryOverlay() {
  const { c, t } = useTheme();
  const s = useStore();
  const [rows, setRows] = useState<MyPayment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setRows((await fetchMyPayments()).filter((p) => p.role === 'payer')); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load your payments.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const report = async (releaseId: string) => {
    setBusy(true); setError(null);
    try { await raiseDispute(releaseId, reason); setReporting(null); setReason(''); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not send that.'); }
    finally { setBusy(false); }
  };

  const awaiting = rows?.find((p) => p.status === 'awaiting_payment');

  return (
    <OverlayScaffold header={<OverlayHeader title="Payments" onBack={s.closeOverlay} />}>
      <View style={{ padding: 16, gap: 14 }}>
        <PracticeBanner />
        {error && <ErrorNote message={error} onRetry={() => void load()} retryLabel="Load payments again" />}
        {awaiting && (
          <Card style={{ padding: 14, gap: 8 }}>
            <Text style={[t.bodyLg, { color: c.txt }]}>Finish paying · {KIND_LABEL[awaiting.kind]}</Text>
            <CheckoutPanel onPaid={() => void load()} />
          </Card>
        )}
        {rows?.length === 0 && <Text style={[t.body, { color: c.txt3 }]}>No payments yet.</Text>}
        {rows?.filter((p) => p !== awaiting).map((p) => (
          <Card key={p.id} style={{ padding: 14, gap: 6 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={[t.bodyLg, { color: c.txt }]}>{KIND_LABEL[p.kind]}</Text>
              <Text style={[t.bodyLg, { color: c.txt }]}>{formatCents(p.priceCents + p.feeCents)}</Text>
            </Row>
            <Text style={[t.caption, { color: c.txt3 }]}>
              {new Date(p.createdAt).toLocaleString()} · {STATUS_LABEL[p.status] ?? p.status}
            </Text>
            <Text style={[t.caption, { color: c.txt3 }]}>
              Price {formatCents(p.priceCents)} + fee {formatCents(p.feeCents)}
              {p.refundedCents > 0 ? ` · ${formatCents(p.refundedCents)} refunded` : ''}
            </Text>
            {p.releases.filter(openComplaint).map((r) => (
              reporting === r.id ? (
                <View key={r.id} style={{ gap: 8 }}>
                  <Field label="What went wrong?" value={reason} onChange={setReason} placeholder="The coach did not show up" />
                  <Row gap={8}>
                    <Button label="Send to BOOK'D" tone="primary" busy={busy} enabled={reason.trim().length >= 5}
                      onPress={() => void report(r.id)} />
                    <Button label="Cancel" tone="secondary" onPress={() => setReporting(null)} />
                  </Row>
                </View>
              ) : (
                <Button key={r.id} label="Report a problem" tone="secondary" onPress={() => setReporting(r.id)}
                  accessibilityLabel={`Report a problem with this ${KIND_LABEL[p.kind].toLowerCase()}, before ${new Date(r.releaseAt).toLocaleString()}`} />
              )
            ))}
            {p.releases.some((r) => r.status === 'disputed') && (
              <Text style={[t.bodySm, { color: c.amberText }]}>You reported a problem. An admin will decide and the money stays held until then.</Text>
            )}
          </Card>
        ))}
      </View>
    </OverlayScaffold>
  );
}
```

- [ ] **Step 2: Route it and add the row.** `OverlayRouter.tsx`:

```tsx
import { PaymentHistoryOverlay } from '../overlays/PaymentHistoryOverlay';
```
```tsx
    case 'paymentHistory':
      return <PaymentHistoryOverlay />;
```

In `ProfileScreen.tsx`, after the Earnings row:

```tsx
        <RowDivider />
        <GroupRow
          icon="file-text"
          title="Payments"
          body="What you paid, receipts and refunds"
          onPress={() => s.set('overlay', 'paymentHistory')}
        />
```

- [ ] **Step 3: Bookings chip.** In `BookingsOverlay.tsx` near line 1145, where a `'pending'` booking renders the amber chip:
- relabel it "Awaiting payment";
- make it pressable with `onPress={() => s.set('overlay', 'paymentHistory')}`, using the same press pattern as other chips in that file;
- add `accessibilityLabel="Awaiting payment. Open payments to pay."`.

- [ ] **Step 4: Typecheck, run all tests, verify in the browser.**
1. A session paid in Task 9 shows "Paid · held until done".
2. After completion through SQL, "Report a problem" appears. Sending "The coach did not show up" shows the under-review note.
3. A booking left unpaid shows "Awaiting payment" in Bookings, and the chip opens Payments with the pay panel.

- [ ] **Step 5: Commit**

```bash
git add expo-app/src/overlays/PaymentHistoryOverlay.tsx expo-app/src/navigation/OverlayRouter.tsx expo-app/src/screens/ProfileScreen.tsx expo-app/src/overlays/BookingsOverlay.tsx
git commit -m "Payment history with receipts, pay now and report a problem"
```

---

### Task 13: Real refunds in the copy (APP-5) and removing the fake Accounting screen (APP-7)

**Files:**
- Modify: `expo-app/src/components/RefundNegotiation.tsx` (copy near line 109)
- Delete: `expo-app/src/overlays/AccountingOverlays.tsx`
- Modify: `expo-app/src/state/store.ts` (only the accounting state used solely by that file)

- [ ] **Step 1: Refund copy.** In `RefundNegotiation.tsx`:
- import `usePaymentConfig` and `paymentsOn`;
- add `const takesPayment = paymentsOn(usePaymentConfig(), 'package');` at the top of the component;
- replace the sentence saying BOOK'D "does not move the money" with:

```tsx
{takesPayment
  ? "Once you both agree, BOOK'D sends the refund back to the card or Whish account that paid."
  : /* the existing sentence, unchanged */}
```

- [ ] **Step 2: Find what only the Accounting screen uses.**
Run: `cd expo-app && grep -rn "AccountingOverlays\|adminAccounting\|AdminAccountingOverlay\|AccountingExpenseOverlay\|AccountingHistoryOverlay" src`
Expected: only `src/overlays/AccountingOverlays.tsx` itself and `src/state/store.ts` (the `'adminAccounting'` sets near lines 1470 and 1484).

- [ ] **Step 3: Delete the file** with `git rm expo-app/src/overlays/AccountingOverlays.tsx`. Then, for each store field or action that `AccountingOverlays.tsx` read (the accounting slice near `store.ts:1349-1489`), run `grep -rn "<name>" src`. Remove the ones that now have no reader, and nothing else.

- [ ] **Step 4: Typecheck and run all tests.**
Run: `cd expo-app && npx tsc --noEmit -p tsconfig.json && node --test "tests/*.test.cjs"`
Expected: clean and all pass. If a test referenced the removed state, delete only that test's accounting cases and say so in the commit message.

- [ ] **Step 5: Commit, push, open the Stage C+D PR**

```bash
git add -A expo-app/src
git commit -m "Refund copy says money moves; remove the disconnected in-app Accounting screen"
git push
gh pr create --title "Payments stages C–D: pay in the app, earnings, history, complaints" --body "Payment methods, checkout for sessions, packages, courts, tournaments and paid events, earnings, payment history, report a problem, practice-mode banner. Inert until enabled_kinds is set; every screen checks it. Verified on a QA account with enabled_kinds switched on temporarily."
```

---

### Task 14: End-to-end run on the Test gateway

**Files:** none (verification only).

- [ ] **Step 1: Ask Kassem** which kinds to switch on, and whether to leave them on after the run. Do not proceed without a yes.

- [ ] **Step 2: Run the whole path on a QA member account and a QA coach account** that Kassem provides:
1. Book a session and pay with the approving test card.
2. Both sides confirm.
3. Set the release's `release_at` into the past and run `select private.payments_tick();`.
4. Within a minute, the coach's payout reaches `sent`, provided the coach has a Whish account.
5. Check the soft-split rule:

```sql
select (select balance_cents from ledger_balances where code = 'company_cash') as cash,
       (select sum(balance_cents) from ledger_balances where kind in ('liability','equity','income'))
     - (select coalesce(sum(balance_cents),0) from ledger_balances where kind = 'expense') as split;
```
Expected: `cash = split`.

- [ ] **Step 3: Run every SQL test and the app suite one last time,** and report the outputs verbatim in the final summary:
- `payments_ledger`
- `payments_core`
- `payments_subjects`
- `release_invariants`

---

---

# Stage E — Member wallet (added 2026-10-12 at Kassem's request)

### Task 15: Wallet — deposits and paying from balance (database)

Ruling recorded in the ledger: no withdrawals in v1 (wallet money is spent on bookings or refunded back into the wallet); deposits carry the member fee (the gateway fee), wallet payments carry no fee; wallet balances are part of the protected pool (never spendable by the company).

**Files:**
- Create: `db/migrations/2026-10-12_payments_wallet.sql`
- Test: `db/tests/payments_wallet.sql`

**Interfaces:**
- Consumes: ledger (`private.post_entry`, `private.ensure_account`), `payments`, `private.mark_payment_held`, `private.refund_payment`, `private.payments_tick`, `payment_settings`, the `payments` edge function's `checkout` contract.
- Produces:
  - `ledger_accounts` per-member code `wallet:<users.id>` (liability, owner = member), created on demand.
  - `payment_settings` gains `wallet_min_deposit_cents int not null default 500`, `wallet_max_balance_cents int not null default 100000`.
  - `wallet_deposits(id, user_id, amount_cents, fee_cents, status awaiting_payment|charging|held|failed|expired, provider, provider_ref unique, method_id, expires_at, held_at, created_at)` — RLS: member selects own; writes service_role only.
  - `public.wallet_balance_cents() returns int` — authenticated, own balance, derived from the ledger.
  - `public.open_wallet_deposit(p_amount int) returns table(id uuid, amount_cents int, fee_cents int, total_cents int)` — authenticated; checks min ('Deposit at least …') and max (balance + open deposits + amount ≤ max, 'Your wallet can hold at most …'); fee as `open_payment` computes it.
  - Service-role RPCs mirroring the payment ones: `wallet_deposit_begin_charge(p_deposit) returns table(begun boolean, amount_cents int, fee_cents int)`, `wallet_deposit_end_charge(p_deposit)`, `wallet_deposit_mark_held(p_deposit, p_ref, p_cost, p_method)` — on held it posts `company_cash +(amount+fee)`, `wallet:<user> −amount`, `fee_income −fee` (+ a gateway_cost entry when p_cost > 0), idempotent on the deposit id.
  - `public.pay_from_wallet(p_payment uuid) returns void` — authenticated, payer only, payment must be `awaiting_payment` and not expired; locks the payment row, then `pg_advisory_xact_lock(hashtext('wallet:' || member))`; sets `fee_cents = 0`; requires balance ≥ price_cents else 'Not enough in your wallet.'; sets `charging` then calls `private.mark_payment_held(p_payment, 'wallet:' || p_payment, 0, null)`. `mark_payment_held` learns the `wallet:` ref: the checkout entry becomes `wallet:<payer> +price`, `held −price` (no cash line, no fee line); the free/non-free ref checks treat `wallet:` like a real ref (total must be > 0).
  - Refunds of wallet-paid payments (provider_ref like `wallet:%`): `private.refund_payment` inserts the `refunds` row directly as `sent` with `provider_ref = 'wallet'` and posts `held +r`, `wallet:<payer> −r` (no `member_refund`, no queue).
  - `private.payments_tick` also expires `wallet_deposits` past `expires_at` (own exception block).
  - Protected-pool rule (spec section 1; enforced by whichever function spends company money): spendable = `company_cash − (held + Σpayee + Σmember_refund + Σwallet)`.

- [ ] **Step 1: Write the failing test** — `db/tests/payments_wallet.sql`: fixture member + coach (price 5000), `fee_bps 300`, `enabled_kinds {session}`, min 500, max 100000. Checks: (1) `open_wallet_deposit(10000)` → fee 300, total 10300; (2) 400 → 'Deposit at least'; (3) begin/mark_held → `wallet_balance_cents()` = 10000, `company_cash` +10300, soft-split identity holds; (4) book a session, `pay_from_wallet` → payment `held`, fee 0, balance 5000, `held` ledger 5000, cash unchanged; (5) a second session with balance 5000 and price 5000 passes, a third → 'Not enough in your wallet.'; (6) cancel a wallet-paid session → refund row `sent`, provider_ref 'wallet', balance restored; (7) another member calling `pay_from_wallet` on it → refused; (8) complete + release → payee balance 5000 − commission, commission posted, wallet unchanged; (9) a deposit that would exceed the max → refused; (10) tick expires an overdue deposit. Final raise `ALL PAYMENTS WALLET CHECKS PASSED`.
- [ ] **Step 2: Run it to verify it fails.** **Step 3: Write the migration** (copy live bodies of `mark_payment_held`, `refund_payment`, `payments_tick` with `pg_get_functiondef`; change only the wallet lines; grants by name; no blanket revoke). **Step 4: Apply** as `payments_wallet`. **Step 5: Run the test**, then `payments_core.sql`, `payments_promos.sql`, `payments_subjects.sql`, `payments_ledger.sql`. **Step 6: Commit.**

### Task 16: Wallet — gateway and client

- Edge function `payments`: new action `deposit` `{depositId, methodId}` → same shape as `checkout` (lock via `wallet_deposit_begin_charge`, charge `amount + fee`, `wallet_deposit_mark_held`, decline → `wallet_deposit_end_charge`, same error contract). Redeploy; probe unauthenticated → 'Sign in first.'.
- `lib/payments.ts`: `walletBalance(): Promise<number>`, `openDeposit(amountCents): Promise<{id, amountCents, feeCents, totalCents}>`, `payDeposit(depositId, methodId): Promise<{ok:true}|{ok:false,message}>`, `payFromWallet(paymentId): Promise<void>` (rpc), `fetchWalletHistory(): Promise<WalletEntry[]>` (`{id, kind:'deposit'|'payment'|'refund', amountCents, status, createdAt, label}` from `wallet_deposits`, wallet-paid `payments`, and wallet `refunds`, newest first). A test for each.

### Task 17: Wallet — app

- `overlays/WalletOverlay.tsx` (route `'wallet'`; Settings row "Wallet" — "Top up and pay from your balance", icon `dollar-sign`): balance, "Top up" with preset amounts ($10 / $25 / $50) and a custom field, pays with a saved method (chips) or `AddPaymentMethod`, shows the fee and total before paying, history list. `PracticeBanner` on top.
- `CheckoutPanel`: a "Pay from wallet · balance $X" chip first in the method list when balance ≥ total; when short, a line "Top up to pay from your wallet" that opens the wallet. Choosing it calls `payFromWallet` and then `onPaid()`.
- Copy: refunds of wallet-paid bookings "go back to your wallet".

## Not in this plan (console plan next)

- **Console pages:** payment setup (developer admin only, unanimous approval), rates, expenses, profit & loss, shares, wallet, capital, money operations, reconciliation, activity log.
- **Daily profit close and share split.**
- **Retrying failed payouts/refunds and settling a payment stuck in `charging`:** both are console actions on ADM-7.
- **Whish and card adapters:** stages 2 and 3 of the spec.
- **Shop checkout:** the shop overlays are not routed in the app today (`ShopOverlays.tsx` is imported nowhere). Add it once the shop is reachable.
