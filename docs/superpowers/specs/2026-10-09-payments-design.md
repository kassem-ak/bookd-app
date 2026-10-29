# BOOK'D Payments — Design

*Draft for review · 9 Oct 2026*

---

## 1. In one paragraph

When a member pays for anything on BOOK'D, the money goes into the **company's Whish account** and
waits there. Once the session (or court, event, order) is confirmed as done, and a short complaint
period has passed, BOOK'D keeps its percentage and sends the rest to the coach, venue, organiser or
seller. Every day, the company's earnings minus its running costs gives a **net profit**, which is
divided on paper between the shareholders by their share percentage. Each shareholder can withdraw
their part, or give some of it to another shareholder, whenever they choose. Nothing is sent to a
shareholder automatically unless they switch that on themselves.

### Where the money physically is

All the money sits **physically in the same company account(s)**. That includes:
- members' payments waiting for completion,
- what is owed to coaches and venues,
- each shareholder's balance,
- company capital.

The split between them is a **soft split: numbers kept in the app**, not separate accounts or real transfers.

Real money leaves the company account **only when someone asks for it**:
- a shareholder withdraws,
- a coach or venue is paid out,
- a member is refunded,
- capital is spent.

Moving money to capital, giving balance to another shareholder, or the nightly profit split only change the numbers.

**Safety rule:** a withdrawal or capital spend is refused if it would leave the company account with
less than what is still owed to members (payments waiting, refunds, wallet balances) and to coaches, venues,
organisers and sellers. Shareholders can never withdraw money that belongs to members or payees.

---

## 2. What you decided

1. **Whish API is not ready yet.** We build everything now with a *practice mode* (no real money),
   then switch Whish on when your merchant account is approved.
2. **Expenses are spread over their period.** A $300 monthly cost is deducted a little each day
   ($10 a day in a 30-day month), so profit is always up to date.
3. **Coaches etc. are paid after a complaint period** (default 48 hours after the session is
   confirmed). If the member complains in that time, the money waits until an admin decides.
4. **Payment fees are added to what the member pays.** Shown as a separate line at checkout.
5. **Every shareholder must approve** any change to share percentages, commission rates, the
   company account or the payment settings, and any move of shareholder money into company capital.
6. **Only the developer admin sets up bank accounts and payment APIs.** That is your account
   (kassem.ak@gmail.com). Your setup does not take effect until every shareholder approves it.

**Things I assumed — tell me if any are wrong:**

- Everything is in **US dollars**.
- When money is sent out (to a coach or a shareholder), the transfer fee comes out of the amount they receive.
- Changing the commission rate only affects new payments, never ones already made.
- A share change can start today or later, never in the past.
- The shareholders are the current admins who have a share.

---

## 3. The journey of one payment

1. **Member books and pays.** They see: price + payment fee = total. They pay by card or Whish.
   The booking is only confirmed once the payment goes through. If it fails or isn't finished in
   15 minutes, the booking is cancelled and the slot is freed.
1b. **Discount codes.** A member can enter one code at checkout. A **coach's own code** reduces that coach's price (the coach bears it; BOOK'D's percentage is taken on the reduced price). A **BOOK'D code** is paid for by the company: the member pays less, the coach or venue still receives their full price minus the normal percentage, and the difference is recorded as a promotion expense. One use per member per code. Refunds return what the member paid.
2. **Money is held** in the company Whish account.
3. **The service happens and is confirmed:**
   - Coach session — both coach and member confirm it happened.
   - Package — the money is released bit by bit, one share per completed session.
   - Court or tournament — the venue owner marks it done.
   - Paid event — automatically once the event has ended.
   - Shop order — the seller marks it delivered.
4. **Complaint period** (default 48 h). The member can press *Report a problem*. If they do, an
   admin looks at it and either releases the money or refunds the member (fully or partly).
5. **Released.** BOOK'D keeps its percentage; the rest becomes the coach's / venue's / organiser's /
   seller's balance.
6. **Paid out** to their Whish account. If they haven't added one yet, the money waits safely and the
   app reminds them.

**If the member cancels before the service:** they get the price back. The payment fee is not
returned (the payment company has already charged it) — this is shown at checkout.

---

## 4. How profit is worked out and shared

Every night the system closes the day:

| | |
|---|---|
| BOOK'D's percentage from payments released today | + |
| Payment fees collected from members, minus what the payment company actually charged | + / − |
| Today's slice of each running cost | − |
| **= Net profit for the day** | |

- **Profit day:** it is shared between shareholders by the percentages valid on *that* day.
- **Loss day:** nothing is shared. The loss is carried forward and taken out of the next profitable days first.
- Amounts are split to the cent, and the parts always add up exactly.

### Share changes

- Anyone can propose a new split, with the **date it starts**. The system records when it was proposed and when it takes effect.
- It takes effect only when **every shareholder approves**. One "no" cancels it.
- Profit earned before the start date uses the old split; after it, the new one.
- The shares must always add up to 100 %.

### Each shareholder's wallet

- **Balance:** your share of profit to date, minus what you have withdrawn or given away.
- **Withdraw:** any amount up to your balance, sent to your own Whish account. Only you can do this.
- **Give to another shareholder:** any amount up to your balance. Only you can do this. Both of you are notified.
- **Automatic transfer:** off unless you turn it on yourself — e.g. "send me everything over $500"
  or "send me my balance every month". No one else can set it for you.

### Member wallet

Members can keep money in an app **wallet** and pay bookings from it.

- **Top up:** the member pays a chosen amount with a card or Whish account. The payment fee applies to the top-up. The money sits in the same company account; the wallet balance is a soft split like everything else.
- **Protected:** wallet balances, like money held for bookings and money owed to coaches and venues, can never be spent by the company. The safety rule in section 1 includes them.
- **Paying:** at checkout the member can pay from the wallet when the balance covers the price. No fee. From there the booking follows the same path: held until done, complaint period, released to the coach or venue minus BOOK'D's percentage.
- **Refunds** of wallet-paid bookings go back into the wallet at once.
- **No withdrawals** for now: wallet money is spent on bookings or refunded into the wallet.
- Minimum top-up and maximum balance are set in the payment settings.

### Company capital

Part of the shareholders' balances can be moved into **company capital**: money that stays with the
company, for example to fund growth or cover costs, instead of being withdrawn.

- **Proposing it:** any shareholder can propose moving money to capital, in one of two ways:
  - a **total amount** (e.g. $5,000), taken from each shareholder in proportion to their share percentage; or
  - a **percentage of each shareholder's current balance** (e.g. 20 % of what each one holds).
- **Approval:** it happens only when **every shareholder approves**. One "no" cancels it.
- **Before anyone approves,** each person's part is shown, so everyone sees exactly what they give.
- **While the proposal is waiting,** those parts are set aside and cannot be withdrawn or given away.
  If the proposal is rejected, they become available again.
- **After it is approved,** the money leaves the shareholders' balances and is added to company capital.
- **Records:** the system keeps track of how much each shareholder has put into capital in total.
- **Spending capital** (on company costs or investments) is recorded in the console against the capital.
- **Returning capital** to the shareholders also needs everyone's approval.
- **Capital is not profit.** It is never shared out in the nightly profit split, and no one can withdraw it from their wallet.

---

## 5. Payment methods

- Every member can save **Visa / Mastercard** or a **Whish account**, and choose which one to pay
  with and which one to be paid into.
- Card numbers are typed into the payment company's own secure form. BOOK'D never sees or stores them.
- **To receive money** (coaches, venues, shareholders), a Whish account is needed for now. Sending
  money *to* a card is rarely offered in Lebanon (see risks).

---

## 6. Who builds what

### A. The BOOK'D app (members, coaches, venues, organisers, sellers)

| # | Feature |
|---|---|
| APP-1 | **Payment methods** in profile settings: add a card or Whish account, pick defaults, remove. |
| APP-2 | **Checkout** for sessions, packages, courts, tournaments, paid events and the shop: price, fee, total, pay. Clear messages when a payment fails or expires. The old "pay the coach directly" text is removed. |
| APP-3 | **Earnings screen** for anyone who gets paid: money waiting, in complaint period, released, paid out, and BOOK'D's percentage on each. |
| APP-4 | **Report a problem** button during the complaint period, and its outcome. |
| APP-5 | **Real refunds** when cancelling, and for the existing package refund agreement. |
| APP-6 | **Payment history and receipts** for members. |
| APP-7 | Remove the old in-app *Accounting* screen (company finances live only in the admin console). |
| APP-8 | A clear **"Practice mode — no real money"** banner while Whish isn't connected. |

### B. The admin console (bookd-admin)

| # | Page | What it does |
|---|---|---|
| ADM-1 | **Payment setup** | Payment provider and its API keys, practice / live mode, the company Whish and bank accounts, the payment fee charged to members, the complaint period length. **Only the developer admin can edit the accounts and API keys.** Every change becomes a proposal and takes effect only when all shareholders approve. Other admins see what is set up (masked) and can approve or reject it, but cannot edit it. |
| ADM-2 | **Commission rates** | BOOK'D's percentage for sessions, packages, courts, tournaments, events and the shop. Changes need everyone's approval and have a start date. |
| ADM-3 | **Expenses** | Add, edit or end running costs, each with an amount, category and period (one-off, daily, weekly, monthly, yearly). Shows the daily amount. |
| ADM-4 | **Profit & loss** | By day and by month: earnings, fees, expenses, net profit, carried-over loss, and each shareholder's part. Replaces today's *Financials* page. |
| ADM-5 | **Shares** | Current split, upcoming changes, full history with "proposed on" and "starts on" dates. Propose, approve or reject. |
| ADM-6 | **My wallet** | Your balance and statement; withdraw; give to another shareholder; set up your own automatic transfer. Replaces today's *Royalties* payouts. |
| ADM-7 | **Money in progress** | Payments waiting, problems reported by members to decide, payouts that failed, people who haven't added a Whish account. |
| ADM-8 | **Bank check** | Compares what the system says is in the company account with the real Whish statement. (Once Whish is live.) |
| ADM-9 | **Activity log** | Every approval, withdrawal, transfer and decision — who and when. |
| ADM-10 | **Company capital** | Capital balance; what each shareholder has put in; propose moving money to capital (a total amount or a % of balances) with each person's part shown; approve or reject; record spending from capital; propose returning capital. Moves in or out need everyone's approval. |

### C. Shared behind the scenes

The money records, rules and automatic jobs live in the shared database used by both the app and
the console. Details for developers are in the appendix.

---

## 7. Order of work

1. **Stage 1 — everything, in practice mode.** All of the above works end to end with fake money,
   so every flow can be tested.
2. **Stage 2 — Whish live.** Once Whish gives you API access, connect it and turn on the bank check.
3. **Stage 3 — cards.** Connect a card payment company for Visa / Mastercard.

**Not included for now:** paid boosts, coach subscriptions, paid promos, other currencies, tax/VAT.

---

## 8. Risks to be aware of

1. **Paying money out to cards** is rarely available in Lebanon. Plan on paying people into Whish accounts. *(Not yet confirmed.)*
2. **What Whish's API can do** (take payments, refund, send money out, fees) is not confirmed yet. We check as soon as you have their documents.
3. **Holding members' money until the service is done** may need a licence or legal approval in Lebanon. Please check with a lawyer. This is not something code can solve.
4. **Changing bookings to "confirmed only after payment"** touches every booking flow, so it is rolled out one type at a time.

---

## Appendix — for developers

**Ledger.** Double-entry: `ledger_entries` + `ledger_lines` (account, signed cents). Each entry sums to 0
(deferred constraint trigger); append-only for everyone; corrections are reversing entries;
idempotency key per entry. Balances are views, never written.

**Soft split.**
- **One real account:** only `company_cash` maps to a real account (the company Whish/bank account, or several summed together).
- **Everything else is virtual:** every other account is a sub-ledger inside that same money.
- **Invariant:** `company_cash` = `held` + Σ`payee` + Σ`member_refund` + `company_capital` + Σ`shareholder` + `undistributed_profit`.
- **Which entries touch `company_cash`:** only those for money arriving or leaving (checkout, payout, refund send, withdrawal, capital spend, gateway cost).
- **Spending guard:** withdrawals and capital spends require `company_cash − amount ≥ held + Σpayee + Σmember_refund`, checked under a lock in the same transaction.

**Accounts.** `company_cash`, `held`, `payee:<user>`, `member_refund:<user>`, `commission_revenue`,
`fee_income`, `gateway_cost`, `expense:<id>`, `undistributed_profit`, `shareholder:<id>`,
`company_capital` (with contributions tracked per shareholder by the lines' `counterparty`).

**Postings.**
- Checkout: `company_cash +(price+fee)`, `held −price`, `fee_income −fee`.
- Release: `held +price`, `payee −(price−commission)`, `commission_revenue −commission`.
- Payout: `payee +amount`, `company_cash −(amount−fee)`, the fee to `gateway_cost`.
- Refund: `held +r`, `member_refund −r`; on send `member_refund +r`, `company_cash −r`.
- Daily close: income and expenses → `undistributed_profit` → `shareholder:<id>`.
- Shareholder transfer: `A +x`, `B −x`.
- Capital allocation (on unanimous approval): `shareholder:<id> +part` for each shareholder, `company_capital −Σparts`.
  Parts are either `amount × bps / 10000` (leftover cents by the same rule as the split) or `balance × pct`. While the proposal is pending, they are held as a reservation that reduces available balance.
- Capital spend: `company_capital +x`, `company_cash −x`.
- Capital return (on unanimous approval): `company_capital +x`, `shareholder:<id> −part`.

**Tables.** `payments` (subject, payee, price, fee, `rate_bps` snapshot, provider, unique `provider_ref`,
status `awaiting_payment → held → completed → released → paid_out`, plus `failed / expired / disputed /
refunded / partially_refunded`), `payouts`, `refunds`, `disputes`, `payment_methods` (token only),
`payment_settings` (no secrets), `expenses` (+ `grain`, `starts_on`, `ends_on`), `share_versions`
(`bps`, `effective_from`, `created_at`, `proposal_id`), generic `proposals` + `proposal_approvals`
(unanimous; replaces fixed 3-approval), `profit_days`, `auto_transfer_rules`.

**Rate keys.** `session, package, court, tournament, event, shop` (+ `boost`, unused).

**Edge function `payments`.** Actions `create-checkout`, `webhook`, `add-method`, `payout`, `refund`.
Adapter interface `charge / refund / payout / tokenise / verifyWebhook / fees`. Test adapter now, Whish
and card adapters later. Provider keys live in Supabase Vault, activated only by an approved developer-admin proposal (see below); webhooks are signature-checked and idempotent.

**Scheduled jobs.** Expire unpaid checkouts (15 min), release after the complaint period, send payouts,
daily close (Beirut midnight, once per day), automatic shareholder transfers.

**Rounding.** Shares: `floor(amount × bps / 10000)`, leftover cents to the largest shares (ties by id).
Packages: `price ÷ sessions`, remainder on the last session.

**Developer admin.**
- **The role:** a single `is_dev_admin` flag on one account (kassem.ak@gmail.com), set by migration.
- **Changing who holds it:** needs a unanimous proposal, raised by the current developer admin.
- **Proposing accounts and APIs:** only the developer admin can create proposals of kind `payment_accounts` or `payment_api`. The RPC checks the flag; the console hides the forms from everyone else.
- **API keys:** submitted keys go into Supabase Vault (encrypted), tied to the proposal.
- **Activation:** keys become live only on unanimous approval; the adapter then reads them from the Vault.
- **Rejection:** if the proposal is rejected, its keys are deleted.
- **Visibility:** keys are never shown again to anyone, the developer admin included. The console shows only "set / not set" and the last 4 characters.

**Security.** Members see only their own payments and methods; payees see payments where they are the
payee; ledger and console views are service-role only. No card numbers stored.

**Tests.** SQL: zero-sum, append-only, release/refund/dispute, package release, expense allocation
over 28/30/31-day months, loss carry-forward, exact split, share effective dates, unanimous approval,
withdrawal ≤ balance, transfer by sender only, auto-transfer by owner only, capital allocation only after
every shareholder approves, reserved parts released on rejection, capital excluded from the profit split, soft-split invariant holds after
every entry, withdrawal/capital spend refused when it would dip into member or payee money. Node: checkout totals and
states, earnings grouping. Live: book → pay → confirm → complaint period → release → payout → daily close → withdraw.
