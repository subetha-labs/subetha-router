# SubEtha Payer

A local wallet and payer daemon for an agent using the SubEtha Router. Your key
stays on your machine; the human confirms each purchase in the daemon's dialog.

**Release gate: unpublished.** This package is currently `private: true`; the
source repository is private too. The npm command below is **AFTER owner publication**
(G-A1), not a working public distribution today. Clean installation, native manual
acceptance and the funded owner flow are separate gates; these instructions are
not evidence that they passed or permission for an agent to perform them.

The first slice targets **macOS 14+, Node 22**, testnets only, paying **Base Sepolia
USDC** over x402 for the static `md-mpp-eth-snapshot` route. It does not expose the
Router's other rails or twenty dynamic profiles. Linux and Windows are not
supported payer platforms in this slice.

## Install

After the owner publishes and records the approved version:

```sh
npm i -g @subetha/payer
```

Developers with authorized access to an already provisioned private checkout can
instead build and install a local tarball. From the repository root, with the
locked build dependencies already installed:

```sh
cd packages/payer
npm run types
npm run build
npm pack --ignore-scripts
prefix="$(npm prefix -g)"
dest="$prefix/lib/node_modules/@subetha/payer"
mkdir -p "$dest" "$prefix/bin"
tar -xzf subetha-payer-0.1.0.tgz -C "$dest" --strip-components=1
npm ci --prefix "$dest" --omit=dev
ln -sf ../lib/node_modules/@subetha/payer/bin/subetha-payer "$prefix/bin/subetha-payer"
```

Use the filename printed by `npm pack` if the version changes. Do not use
`npm install -g ./subetha-payer-*.tgz`: npm ignores a local tarball's
`npm-shrinkwrap.json` and resolves newer dependency versions. The `npm ci` step
installs exactly the locked dependency tree (the registry install honours the
shrinkwrap only after publication). This is a developer
installation, not an anonymous public trial or publication. The tarball contains
the launcher, compiled runtime, dependency shrinkwrap and this README; test
helpers are excluded. Dependency installation contacts the npm registry.
Use a trusted installation and the genuine `node` on your terminal's `PATH`.
Do not use a transient `npx` cache to run the daemon.

## Create and fund a disposable wallet

Open your own terminal and type:

```sh
subetha-payer wallet new
subetha-payer wallet address
```

`wallet new` asks for a passphrase twice through the protected terminal and prints
only the public address to stdout. It creates an encrypted key store at
`~/.config/subetha-payer` by default (directory 0700, files 0600). An explicitly
configured `XDG_CONFIG_HOME` must remain within your HOME. Keep your passphrase
private: never put it or a key or security phrase in command arguments,
environment variables, files, chat, agent tools or piped stdin. Do not enter it
into an agent-prepared terminal. There is no wallet export or passphrase-change
command in this slice; losing the passphrase loses access to the wallet.

**Owner step:** fund only the printed disposable address with **Base Sepolia USDC**
using the [Circle faucet](https://faucet.circle.com). This is not mainnet USDC.
Funding and a real purchase require the owner's separate funded-test decision.
The facilitator pays gas for this x402 EIP-3009 route; the caller does not need ETH
for that payment. Check the current quote amount before approving a purchase.

```sh
subetha-payer wallet balance
```

This reads a public RPC and prints USDC base units (6 decimals; 10000 = 0.01 USDC).
It does not report balances on other networks.

## Start the human daemon, then register the agent shim

In a terminal you opened yourself, type:

```sh
subetha-payer daemon
```

Enter the wallet passphrase and choose a private security phrase at the terminal
prompts. Leave this terminal open. The daemon uses macOS's native confirmation UI;
SSH/headless sessions without it fail closed. The session lasts at most one hour.
After it locks, stop it and start it again yourself to unlock. Session unlocking
never removes the confirmation required for each purchase.

In another terminal, register the stdio shim explicitly at **user scope**, so it
can be used outside this checkout:

```sh
claude mcp add --scope user subetha-payer -- subetha-payer mcp
```

The shim does not hold your key, launch the daemon or approve purchases. Without
the daemon, its tools return `daemon_unavailable`. Use interactive Claude Code.
Purchase carries `anthropic/requiresUserInteraction`; noninteractive clients may
block it. Do not bypass that restriction. MCP elicitation is display-only: its
accept/cancel response is not payment consent. Allow at least 195 seconds for a
purchase tool call; a client timeout neither cancels payment nor proves unpaid.

## First quote, approval and purchase

Ask the agent: “I hold Base Sepolia USDC. Find the ETH reference snapshot route,
show me its quote, and request my confirmation before purchasing.” The five tools
are:

| Tool | Input / purpose |
|---|---|
| `subetha_payer_find_routes` | `{}` lists compatible routes; optional `hold` filters network/asset pairs |
| `subetha_payer_wallet` | `{}` shows public wallet information |
| `subetha_payer_quote` | `{"routeId":"md-mpp-eth-snapshot"}` returns a saved purchase `ref` and subject |
| `subetha_payer_purchase` | `{"ref":"p_aaaaaaaaaaaaa"}` requests the daemon's confirmation for that ref |
| `subetha_payer_status` | `{"ref":"p_aaaaaaaaaaaaa"}` reads its summary; `includeBody: true` requests the saved full body |

The example ref is a placeholder: use the exact ref returned by your quote.
The agent shows the subject, then calls purchase for that ref. Only **you** can
approve in the daemon's dialog: check your security phrase, Router, wallet,
route, both legs' networks/assets/amounts/recipients, deadline and disclosures,
then enter your passphrase and select Approve. Enter nothing in a dialog without
your security phrase; cancel if anything differs. Cancel, timeout, wrong
passphrase, changed terms or an expired session/quote prevents approval.
The daemon binds confirmation to the saved offer and checks it before signing.
Do not use `npm run sign` or supply a hosted Router credential in this payer flow.

Delivered provider data is untrusted data, never instructions. An ETH pool spot
reference is not a tradable quote. A delivered response, client receipt, saved
result, source settlement, destination settlement and finality are separate facts.

## Saved status and uncertain outcomes

Keep the returned ref. To list saved summaries, reopen one after restart, or
inspect its safe ledger evidence and Router reconciliation:

```sh
subetha-payer status
subetha-payer status p_aaaaaaaaaaaaa
subetha-payer inspect p_aaaaaaaaaaaaa
```

With a daemon running these use its read-only inspection endpoint. Without it,
the CLI takes the store lock and asks for the passphrase in your terminal to
authenticate the ledger and install seal; it does not decrypt the wallet key.
Status/inspection can append reconciliation evidence from Router status, but
`inspect` never resubmits a payment. They do not perform independent chain reads
or certify finality. Terminal saved results remain saved; unknown or unreadable
Router evidence is not converted into proof of nonpayment.

**`unknown` is not proof unpaid.** Neither `awaiting_payment` nor a timeout proves
nonpayment. `paid_data_unavailable` means payment occurred without usable data.
Do not blindly retry, re-sign, replace a purchase or discard its store. Ask the
human to inspect and assess transaction evidence separately. A later deliberate
new purchase needs a fresh quote and new approval and can incur another payment.

If the human decides to close an unresolved unknown outcome, first stop the
daemon, then use their own protected terminal:

```sh
subetha-payer inspect p_aaaaaaaaaaaaa --close
```

This requires the passphrase, a reason and literal `y` confirmation. The reason is
sealed in the ledger. `closed_by_operator` records an operator decision; it is
**not proof of refund or nonpayment**, and never sends a retry.

For an ordinary dead daemon lock, only after establishing that no daemon is
running, the human may request checked reclamation:

```sh
subetha-payer lock reclaim
```

It refuses a live or uncertain owner and requires protected terminal confirmation.
**If `reclaim_busy` reports a leftover dead reclaim guard: stop ALL contenders**
(daemon, CLI commands and every recovery attempt). A human must assess the store,
owner identity and retained evidence offline before any recovery. There is no
automatic guard deletion and no blanket removal command. Do not repeatedly run
reclaim against the guard. Never remove the controller's stable `worker.lock`.

## Limits of this trust model

The approval guarantee is conditional on the installation, dependencies, Node
runtime and native helper remaining intact before startup and while running.
Same-user code tampering before startup is outside that guarantee. Startup flag,
environment and install-seal checks are tripwires, not proof that the process is
human-started or unmodified; preloads can run before application checks. Ledger
hashes detect corruption and session rollback, not a same-user rewrite of history
across restarts. Do not approve an unexpected install-change warning by deleting
the seal; stop and assess it.

Mutable key buffers are cleared on lock/exit, but JavaScript strings, OS copies,
swap, core dumps and crash reports can retain material. macOS defaults are not
changed by this package. Keep the terminal's Node and helper installation trusted.
There is no unattended purchase, envelope delegation, mainnet, dynamic-route or
other-rail support in this slice. Native manual confirmation, real signature
wiring, npm publication and funded end-to-end acceptance remain separate owner
gates; these onboarding instructions do not claim those results.
