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
    try {
      const result = item.item_kind === "payout"
        ? await gateway.payout({ token: item.token!, amountCents: item.amount_cents, reference: item.item_id })
        : await gateway.refund({ chargeRef: item.charge_ref!, amountCents: item.amount_cents, reference: item.item_id });
      if (result.ok) {
        const { error: sentError } = await admin.rpc("payments_queue_sent", { p_kind: item.item_kind, p_id: item.item_id, p_ref: result.ref, p_fee: result.feeCents });
        if (sentError) {
          console.error(`PAYMENTS: queue item ${item.item_kind} ${item.item_id} was sent (${result.ref}) but could not be recorded: ${sentError.message}`);
        } else {
          sent++;
        }
      } else {
        const { error: failError } = await admin.rpc("payments_queue_failed", { p_kind: item.item_kind, p_id: item.item_id, p_message: result.message });
        if (failError) console.error(`PAYMENTS: queue item ${item.item_kind} ${item.item_id} failed but could not be recorded: ${failError.message}`);
        failed++;
      }
    } catch (e) {
      // The real outcome is unknown, so do not mark it failed: an operator settles it from the console.
      console.error(`PAYMENTS: queue item ${item.item_kind} ${item.item_id} threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { sent, failed };
}

async function handle(req: Request): Promise<Response> {
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
      .select("id, payer_id, status").eq("id", paymentId).maybeSingle();
    if (!payment || payment.payer_id !== me) return json({ error: "That payment was not found." }, 404);
    // A double-submit of a checkout that already went through is not an error.
    if (payment.status === "held") return json({ ok: true });

    // Lock first, then charge what the lock returns: a code taken off in the gap cannot change the total.
    const { data: lock, error: beginError } = await admin.rpc("payments_begin_charge", { p_payment: payment.id });
    if (beginError) return json({ error: "Could not start the payment." }, 500);
    const locked = (Array.isArray(lock) ? lock[0] : lock) as { begun: boolean; price_cents: number; fee_cents: number } | null;
    if (locked?.begun !== true) return json({ error: "This checkout has expired or is already paid. Book again if needed." }, 409);
    const totalCents = locked.price_cents + locked.fee_cents;

    // A 100% promo code leaves nothing to charge: hold it with no method and no gateway call.
    if (totalCents === 0) {
      const { error: freeError } = await admin.rpc("payments_mark_held", {
        p_payment: payment.id, p_ref: "free:" + payment.id, p_cost: 0, p_method: null,
      });
      if (freeError) {
        // Nothing was captured, so release the payment for a retry (and for the clock to expire).
        console.error(`PAYMENTS: free checkout ${payment.id} could not be recorded: ${freeError.message}`);
        await admin.rpc("payments_end_charge", { p_payment: payment.id });
        return json({ error: "We could not confirm the booking. Please try again." }, 500);
      }
      return json({ ok: true });
    }

    const { data: method } = await admin.from("payment_methods")
      .select("id, user_id, token, can_pay, removed_at").eq("id", methodId).maybeSingle();
    if (!method || method.user_id !== me || method.removed_at || !method.can_pay) {
      await admin.rpc("payments_end_charge", { p_payment: payment.id });
      return json({ error: "Pick one of your payment methods." }, 422);
    }

    let result;
    try {
      result = await gateway.charge({
        token: method.token, amountCents: totalCents, reference: payment.id,
      });
    } catch (e) {
      console.error(`PAYMENTS: charge threw for ${payment.id}: ${e instanceof Error ? e.message : String(e)}`);
      await admin.rpc("payments_end_charge", { p_payment: payment.id });
      return json({ ok: false, message: "The payment could not be taken. Try again." });
    }
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
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  try {
    return await handle(req);
  } catch (e) {
    console.error("PAYMENTS: unhandled", e);
    return json({ error: "Something went wrong on our side. Nothing was charged." }, 500);
  }
});
