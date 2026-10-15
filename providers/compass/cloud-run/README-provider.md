# SubEtha Compass as an x402 Provider (judges' access, until 2026-10-28)

Compass chooses one of four API candidates (Hyperliquid ETH perp, Hyperliquid SOL perp,
Uniswap USDC/WETH spot, Exa search) for a task you describe, using the live DiffusionGemma
model on one NVIDIA L4 in Cloud Run (asia-southeast1). The service is public, scales to zero,
and is paid per request over **x402 on Base Sepolia USDC** (testnet only).

**URL: `https://crp-b54f8ec1c5924032-mulpnxrscq-as.a.run.app`** (published 2026-10-16 01:2x JST).
Verified: direct paid purchases deliver live selections (ETH 12.0 s, SOL 11.8 s, settled on Base Sepolia);
the hosted Router quotes it via `dyn-arc-to-x402`. A paid purchase through the Router is not yet run.
Evidence: `providers/compass/notes/cloud-run-evidence.md`.

## What to expect (disclosure)

- **Waking the instance.** The service runs with zero instances when idle. Your first
  `GET /health` starts the GPU instance. Measured once (2026-10-15): instance start about
  1 s after the request, engine ready about 147 s later, first answer 161.3 s after the
  request. GPU allocation can take longer: a new-revision deployment once waited 8.5 min.
  So expect **about 3 minutes, possibly more than 10** (the longer figure is an estimate,
  not a measurement).
- **Idling out.** We observed zero instances about 11.5 min after the last request. The exact
  idle time is Cloud Run's behaviour, not a guarantee. After it stops, the next call waits again.
- **Requests during startup** are held by Cloud Run and may fail after 600 s; the instance keeps
  starting (to be confirmed in acceptance). Poll `/health` every 60 s for at most 15 min; if it
  never returns 200, stop and report. At most two wake attempts per session.
- **No payment before readiness.** While the model is not ready or is busy, `POST /select`
  answers 503 with `Retry-After` and calls neither the facilitator nor the model, whether or not
  a payment header is present.
- **Two windows with no refund.** (1) Via the SubEtha Router, the Router takes your inbound
  payment before calling Compass; if Compass has idled out between quote and purchase, the
  Router ends with `paid_data_unavailable` and nothing is refunded. Always do
  `/health` 200 → quote → purchase **immediately**. (2) Directly: from the moment Compass sends
  `settle` until the answer reaches you (instance shutdown, response loss), the payment stands and
  the answer may be lost.
- `paid: false` and `purchaseEnabled: false` in the answer mean Compass bought nothing downstream;
  they are unrelated to your payment to Compass.

## Price and wire

- `POST /select`, JSON body up to 8 KiB:
  `{"schema":"compass.internal.select.v1","catalogVersion":"existing-resources-v1","task":"<English task>"}`
- Price `10000` units of Base Sepolia USDC (0.01 USDC), asset `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
  (`eip155:84532`), scheme `exact`, `maxTimeoutSeconds` 60, facilitator `https://www.x402.org/facilitator`.
- Unpaid request → 402 with `PAYMENT-REQUIRED` (x402 v2). Paid request → `PAYMENT-SIGNATURE` header.
  Success → 200 with `PAYMENT-RESPONSE` and the answer.
- One paid request takes at most 28 s end to end (verify, inference, settle). If the inference
  does not leave enough time for settlement, Compass refuses **before** settling (503, no charge);
  retry with a **new** credential (a re-presented nonce is answered 409).
- `409` means this nonce was already seen: `recorded` tells the state and `paid` whether a payment
  may stand (`no` / `possibly` / `yes`). Nothing is retried automatically.
- Internal path `/internal/v1/select` does not exist in public mode.

## Direct use (testnet USDC on Base Sepolia)

1. `GET <URL>/health` every 60 s until `{"ready":true}`.
2. `POST <URL>/select` without payment → read `PAYMENT-REQUIRED`.
3. Sign an EIP-3009 authorization for the offer (for example with this repository's
   `npm run sign` tool, which refuses offers that differ from the table) and resend with
   `PAYMENT-SIGNATURE`.
4. Keep the `transaction` from `PAYMENT-RESPONSE` as your receipt.

## Via the SubEtha Router (pay on another testnet rail)

The Router reaches a Base Sepolia x402 upstream only from other rails: profiles
`dyn-mpp-to-x402` (Tempo pathUSD), `dyn-arc-to-x402`, `dyn-sol-to-x402`, `dyn-solmpp-to-x402`,
`dyn-rh-to-x402`, `dyn-arbsep-to-x402`, `dyn-hyperevm-to-x402`. There is no Base→Base profile.

1. `GET <URL>/health` until `ready: true`.
2. `subetha_router_quote_url` with `profileId`, `url: "<URL>/select"`, `method: "POST"`,
   `body: {...}` (the JSON above), a fresh `requestId`.
3. Approve the subject, build the credential, and call `subetha_router_purchase` **right away**.
   The Router's paid call allows 30 s; a warm Compass answers in 0.3–11 s.

## Retention and cost

Kept until 2026-10-28 (finalist announcement) and deleted on 2026-10-29. Planning limit
USD 30 with a Billing budget alert; the operator stops the service without notice once the
cumulative GPU time reaches 8 hours. This is a bounded demo on testnets, not a hosted product.
