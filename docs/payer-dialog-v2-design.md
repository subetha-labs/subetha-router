# payer approval dialog v2 — a dialog a person can read (requirements and design, 2026-10-13)

Owner's direction (2026-10-13 03:05 JST): the native approval dialog of `@subetha/payer` is not user-friendly. It must say, in plain
words, what is about to happen, what permission is being asked for, and that the passphrase of the wallet this payer manages must be
entered; it may show the payment method, chain and currency (logos if possible).

## 1. What stays (security properties of 0.2.0, `docs/agent-payer-design.md` §3.5, `docs/payer-rails-design.md` SR-R4)

- The dialog is `/usr/bin/osascript` `display dialog` (root-owned helper, env allowlist, hidden answer, default button Cancel, 120 s
  give-up). The text is rendered **deterministically from the frozen approval record** and nothing else: no agent prose, no upstream
  body, no labels from the URL. The approval binds the record by digest (`recordHash`), not the text.
- The **security phrase is the first line**. It is the only anti-spoofing signal (README "Upgrading"/"Approving"); v2 labels it.
- Full addresses stay visible (the person must be able to compare the recipient with what the agent showed); amounts are shown in
  both the asset's decimal form and base units.
- `sanitize` on every record string; AppleScript escaping unchanged; `renderConfirmation(record, phrase)` keeps its signature.

## 2. The v2 text (rendered from a dynamic record; static routes differ only in the "Provider" lines)

```
Security phrase: <phrase>
If this line is missing or not your phrase, click Cancel.

An AI agent on this Mac asks to buy data through SubEtha Router.

What happens if you approve
- This payer signs a payment of 0.011 USDC on Base Sepolia (testnet) to the Router, from your wallet.
- The Router pays the provider 0.010 USDC on Solana devnet from its own balance and returns the data to the agent.
- Funds move when the Router settles the purchase, not at approval.            (x402 / solana charge: the scheme line)
- The operator has not verified this provider. No refund if it takes the payment and returns no usable data.   (dynamic only)

Details
Provider URL: https://provider-x402-sol.subethalabs.com/v1/sol/snapshot          (dynamic) | Route: md-x402-eth-snapshot (operator fixed) (static)
Price: 0.010 USDC + Router fee 0.001 USDC = 0.011 USDC (11000 base units, 6 decimals)
Pay with: USDC on Base Sepolia (testnet), x402
From your wallet: 0x88c527F64dcDa8eefE1af8a56894047D0f1Ae0A2
To the Router: 0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2
Provider receives: 0.010 USDC on Solana devnet, x402, to 4LrB4peq75FSg9UhSyfhp4onb6GMKgEtC3o3wndgguBc
Offer expires: 2026-10-13 02:52:46 UTC

To approve, enter the passphrase of the wallet this payer manages and click Approve. Pressing Enter cancels.
```

- The funds line follows the source scheme exactly as today (`fundsLineOf`): Tempo MPP → "Approving SENDS 0.011 pathUSD now; it cannot be
  undone and nothing is refunded if the Router later refuses."; Solana MPP → "Signing only; the Router broadcasts at purchase and your
  Solana key pays the network fee (devnet SOL)."; x402 → "Funds move when the Router settles the purchase, not at approval."
- Names: a small fixed table in `src/ui/labels.ts` for the payer's four networks (`eip155:84532` Base Sepolia (testnet), `eip155:42431`
  Tempo testnet, `eip155:5042002` Arc testnet, `solana:EtWT…` Solana devnet) and their assets (USDC, pathUSD) from `PAYER_NETWORKS`; a
  network or asset not in the table is shown as its raw id (never invented). Rail: `x402`, `MPP` (scheme in parentheses when it is a charge).
- Amounts: base units → decimal string with the record's `decimals` (bigint, exact; no float). Missing destination decimals → base units only.
- Everything in the record that v1 showed is still shown (Router URL and the Router-internal resource path move to a last "Technical" line:
  `Router: …; resource GET /v1/routes/<id>/resource; ref p_…`) so inspection and the dialog still agree.

## 3. What a `display dialog` cannot do (owner's "logos")

`display dialog` shows one icon (`with icon` = a `.icns` file) and plain text; it cannot place per-chain or per-currency images. v2 ships
no icon (a file under the user-writable install would need its own integrity story; same-user tampering is outside the 0.2.x guarantee,
but a visual trust mark deserves a design of its own). Per-rail logos need a native helper window (Swift/AppKit) — a separate slice after
the hackathon, with the same helper-integrity rules as `safeHelper`.

## 4. Tests

`test/unit/render.test.ts` (phrase first; hostile phrase/addresses sanitized; AppleScript escaping), `test/unit/record.test.ts` (render is
deterministic and contains no agent text), new cases: amount formatting (11000/6 → 0.011; 1/6 → 0.000001; 10 decimals; 0), network/asset
labels (known → name, unknown → raw id), Tempo MPP funds line, static route lines, dynamic disclosures, every v1 field still present.
`npm test` (unit + wire) green; `subetha-payer ui-check` on the owner's Mac shows the fixed test text as before (unchanged).

## 5. Rollout

Publish 0.2.1 (owner: `npm publish`), the owner upgrades (`install_changed` → README "Upgrading" → `install accept` in their terminal), and the
demo's purchase scene is re-recorded once with the new dialog (one more testnet purchase).

## 6. Independent review 1 (Codex `gpt-6-astra`, 2026-10-13, `.claude_workflow/local/payer-dialog-v2-review1.md`): REJECT → fixed

Blocking: (1) v1 facts dropped — the destination's base units and decimals were shown only when decimals were missing; the dynamic
upstream amount and fee lacked base units; the `exact` scheme, the `application/json` wording and the deadline's milliseconds were gone.
Fixed: every amount is shown in asset units **and** base units with its decimals; `Pay with` shows the scheme (`x402 (exact)`,
`MPP (tempo/charge)`); the disclosure says `application/json object`; the deadline is the full ISO instant. (2) The dynamic price line
formatted the **upstream amount** (destination units) with the source's decimals and asset; fixed: the provider's amount is shown in the
destination's units, the equation uses `pricing.converted` (the source-currency equivalent) + fee = total, all in base units too.
Nonblocking applied: tests assert labelled lines and use legs with distinct amounts; runtime version strings (ping, shim, PAYER_VERSION)
say 0.2.1; own-property lookups in the name table; EVM asset ids compare case-insensitively, Solana mints exactly; `GET` methods sanitized
like every other field; "returns the data" → "passes the provider's response"; the formatter comment says string placement, not bigint.

**Review 2** (`.claude_workflow/local/payer-dialog-v2-review2.md`): APPROVE WITH CHANGES, no blocking; both round-1 blockers verified fixed.
Applied: a mixed-decimals test (destination 8 decimals / source 6, upstream 1000000 ≠ converted 10000) that fails on either wrong-leg
formatting or an `upstreamAmount`/`converted` swap; the price line separates the conversion from the sum ("provider … , equivalent to …;
total … + Router fee … = …") so it never reads as "provider amount = fee-inclusive total".

