/**
 * 本番の入口（`tools/remote-mcp.ts`）が Router に渡す**設定の生成**。鍵と子プロセスの起動から切り離してある
 * （試験で、どの env を与えても動的機能の有効・無効とプロファイルの構成が変わらないことを確かめる。T13・G-4）。
 * このファイルは Router の SDK に依存しない（試験から import できる）。
 */

/**
 * 経路 1（既存・変更しない）: **x402 で払って MPP の Provider B に届く**。
 * routeId は既に公開済みなので**改名しない**（審査員の手元の手順が壊れる）。
 */
export const ROUTE = "md-mpp-eth-snapshot";
export const UPSTREAM = "https://provider-mpp.subethalabs.com/v1/eth/snapshot";

/**
 * 経路 2（新規）: **MPP で払って x402 の Provider A に届く**。逆向きの主張。
 * 送信レグに Base Sepolia USDC が要るので、その鍵が無い構成では**登録しない**。
 */
export const ROUTE_MPP_IN = "md-x402-eth-snapshot";
export const UPSTREAM_X402 = "https://provider-x402.subethalabs.com/v1/eth/snapshot";

/** x402 受信（Base Sepolia USDC）。 */
export const INBOUND = {
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "10000",
  facilitator: "https://www.x402.org/facilitator",
} as const;
/** MPP 受信（Tempo pathUSD）。 */
const INBOUND_MPP = {
  network: "eip155:42431",
  asset: "0x20c0000000000000000000000000000000000000",
  amount: "10000",
} as const;
/** MPP 送信（Provider B）。 */
const OUTBOUND = {
  network: "eip155:42431",
  asset: "0x20c0000000000000000000000000000000000000",
  payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1",
} as const;
/** x402 送信（Provider A）。 */
const OUTBOUND_X402 = {
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1",
} as const;

/** 本番の公開ホスト名（`docs/DEPLOY.md`）。動的上流 URL の拒否ホストに入れる（自分自身には向けない）。 */
export const PUBLIC_HOSTNAME = "router.subethalabs.com";

/**
 * 動的上流 URL の手数料・上限（G-1。owner が 2026-10-06 に決定。手数料の決め方は `docs/dynamic-gas-fee-design.md`）。
 * - x402 送信（Router にチェーン手数料がかからない）: 定額 1,000（0.001）
 * - MPP 送信（Router が Tempo の手数料を払う）: quote の時点でその送金のガス代（gas × maxFeePerGas）を見積もり、
 *   cap = ceil(bound × feeMargin / 10000)（`feeMargin` 20,000 = 2 倍。仮の値——quote 時と purchase 時の bound を本番で並べてから見直す）、
 *   手数料 = max(定額 1,000, cap)。cap が天井 `maxFee` 50,000（0.05。署名前の上限の実測 79〜706 の約 70 倍）を超える quote は出さない。
 *   呼び出し側が先に払う手数料 ≥ 署名時の上限、を quote ごとに保つ（設計 §2・§3）。
 *   「チェーンが請求する額が署名時の上限以下」という Tempo 側の前提が確立するまで、このプロファイルは本番で有効にしない（`docs/DEPLOY.md` §2b の条件 6）。
 */
const DYNAMIC_MAX_FEE_CEILING = "50000";
const DYNAMIC_FEE_MARGIN_BPS = 20_000;
const DYNAMIC_FEE_X402_OUT = { flat: "1000", bps: 0, min: "1000" } as const;
const DYNAMIC_FEE_MPP_OUT = { flat: "1000", bps: 0, min: "1000" } as const;
const DYNAMIC_MAX_UPSTREAM_AMOUNT = "10000";

/** MPP 送信のプロファイルを登録するか。Tempo の手数料の仕様で上限が確立するまで `false`（`docs/DEPLOY.md` §2b の条件 6）。 */
const MPP_OUTBOUND_PROFILE_ENABLED = false;

/**
 * 登録する動的プロファイル。1 つも無ければ `undefined`（`dynamic` の節を書かない。空の `profiles` は設定の検証が拒否する）。
 * x402 送信（`dyn-mpp-to-x402`）は MPP 受信の秘密と x402 送信の鍵がそろっているとき（経路 2 と同じ条件）だけ。
 */
export function dynamicProfilesOf(env: Readonly<Record<string, string | undefined>>, receiver: string, mppInboundEnabled: boolean): Record<string, unknown> | undefined {
  void env;
  const profiles: Record<string, unknown> = {
    ...(MPP_OUTBOUND_PROFILE_ENABLED
      ? {
          "dyn-x402-to-mpp": {
            profileId: "dyn-x402-to-mpp",
            sourceRail: "x402",
            source: { network: INBOUND.network, asset: INBOUND.asset, decimals: 6, payTo: receiver },
            rail: "mpp",
            destination: {
              scheme: "tempo/charge",
              network: OUTBOUND.network,
              asset: OUTBOUND.asset,
              decimals: 6,
              feeAsset: OUTBOUND.asset,
              maxFee: DYNAMIC_MAX_FEE_CEILING,
              feeMargin: DYNAMIC_FEE_MARGIN_BPS,
            },
            par: true,
            maxUpstreamAmount: DYNAMIC_MAX_UPSTREAM_AMOUNT,
            fee: DYNAMIC_FEE_MPP_OUT,
          },
        }
      : {}),
    ...(mppInboundEnabled
      ? {
          "dyn-mpp-to-x402": {
            profileId: "dyn-mpp-to-x402",
            sourceRail: "mpp",
            source: { network: INBOUND_MPP.network, asset: INBOUND_MPP.asset, decimals: 6, payTo: receiver },
            rail: "x402",
            destination: { scheme: "exact", network: OUTBOUND_X402.network, asset: OUTBOUND_X402.asset, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
            par: true,
            maxUpstreamAmount: DYNAMIC_MAX_UPSTREAM_AMOUNT,
            fee: DYNAMIC_FEE_X402_OUT,
          },
        }
      : {}),
  };
  return Object.keys(profiles).length === 0 ? undefined : profiles;
}

/**
 * 本番の入口が Router に渡す設定。**鍵と子プロセスの起動から切り離した純粋関数**。動的機能の有効・無効と
 * プロファイルの構成はこの関数と `MPP_OUTBOUND_PROFILE_ENABLED` だけで決まり、env からは変えられない（予算の額・件数と追加の拒否ホストは env）。
 */
export function routerConfigOf(env: Readonly<Record<string, string | undefined>>, receiver: string, mppInboundEnabled: boolean): Record<string, unknown> {
  return {
    router: {
      /**
       * 承認期限。**実効期限は `min(approvalTtlMs, offerExpiry)`** なので、
       * offer 側（既定 600 秒）より短いとこちらが先に切れる。
       * 人間が承認を挟む運用（収録・審査員のデモ）では、読み上げや確認で数分使うため
       * 5 分だと**承認前に失効する**ことが実測で起きた。既定を offer と揃える。
       */
      approvalTtlMs: Number(env["SUBETHA_APPROVAL_TTL_SECONDS"] ?? "600") * 1000,
      routes: {
        [ROUTE]: {
          routeId: ROUTE,
          canonicalPath: `/v1/routes/${ROUTE}/resource`,
          rail: "mpp",
          sourceRail: "x402",
          source: {
            amount: INBOUND.amount,
            asset: INBOUND.asset,
            decimals: 6,
            network: INBOUND.network,
            payTo: receiver,
          },
          destination: {
            scheme: "tempo/charge",
            network: OUTBOUND.network,
            asset: OUTBOUND.asset,
            payTo: OUTBOUND.payTo,
          },
        },
        // 逆向きの経路。鍵と秘密がそろっているときだけ公開する。
        ...(mppInboundEnabled
          ? {
              [ROUTE_MPP_IN]: {
                routeId: ROUTE_MPP_IN,
                canonicalPath: `/v1/routes/${ROUTE_MPP_IN}/resource`,
                rail: "x402",
                sourceRail: "mpp",
                source: {
                  amount: INBOUND_MPP.amount,
                  asset: INBOUND_MPP.asset,
                  decimals: 6,
                  network: INBOUND_MPP.network,
                  payTo: receiver,
                },
                destination: {
                  scheme: "exact",
                  network: OUTBOUND_X402.network,
                  asset: OUTBOUND_X402.asset,
                  payTo: OUTBOUND_X402.payTo,
                },
              },
            }
          : {}),
      },
      // 「予算の続く限り」使えるように大きく取るが、暴走時に止まるようゼロにはしない。
      // bucket は (network, asset) 単位。2 経路は同じ 2 組を向きだけ変えて使うので、
      // この 2 本で両方をカバーする（経路ごとに増やす必要はない）。
      budget: {
        maxPurchases: Number(env["SUBETHA_MAX_PURCHASES"] ?? "100000"),
        buckets: [
          {
            network: INBOUND.network,
            asset: INBOUND.asset,
            maxTotal: env["SUBETHA_INBOUND_MAX_TOTAL"] ?? "1000000000",
            maxPerPurchase: "10000",
          },
          {
            network: OUTBOUND.network,
            asset: OUTBOUND.asset,
            maxTotal: env["SUBETHA_OUTBOUND_MAX_TOTAL"] ?? "1000000000",
            maxPerPurchase: "10000",
          },
        ],
      },
      /**
       * 動的上流 URL（設計 `docs/dynamic-upstream-design.md`）。G-4（owner の決定 2026-10-06）で有効化。
       *
       * **受け入れの記録**（`docs/DEPLOY.md` §2b の条件）:
       * - SSRF 防御 B（egress 制御）: 本番ホスト `subetha-router`（AL2023）での受け入れの結果は `docs/ssrf-egress-design.md` **§27**
       *   （2026-10-05、全検証モードの実測）と **§27.1**（同日の切り替えと切り替え後の確認）。設計は同 §25、レビュー #10 で承認。
       *   2026-10-06 のデプロイ（`b-56265da`）でも `subetha-egress check` は正常
       * - G-2（testnet の実決済、両方向）: `docs/dynamic-upstream-tasks.md` T16 の記録（2026-10-06）
       *
       * **有効にするのは x402 送信（`dyn-mpp-to-x402`: Tempo pathUSD で払って x402 の上流に届く）だけ。** MPP 送信（`dyn-x402-to-mpp`）は、
       * Tempo の手数料の仕様で署名時の上限が実額の上限であることが確立するまで登録しない（§2b の条件 6。`MPP_OUTBOUND_PROFILE_ENABLED`）。
       * 値を変える場所はこの関数だけ。戻すのも同じ（`enabled: false`）。
       */
      ...(dynamicProfilesOf(env, receiver, mppInboundEnabled) === undefined
        ? {}
        : {
            dynamic: {
              enabled: true,
              profiles: dynamicProfilesOf(env, receiver, mppInboundEnabled),
              budget: {
                maxPurchases: Number(env["SUBETHA_DYNAMIC_MAX_PURCHASES"] ?? "1000"),
                buckets: [
                  { network: INBOUND.network, asset: INBOUND.asset, maxTotal: env["SUBETHA_DYNAMIC_MAX_TOTAL"] ?? "100000000", maxPerPurchase: "20000" },
                  { network: OUTBOUND.network, asset: OUTBOUND.asset, maxTotal: env["SUBETHA_DYNAMIC_MAX_TOTAL"] ?? "100000000", maxPerPurchase: "20000" },
                ],
              },
              // 自分の公開ホスト名（Caddy の後ろ。canonical は内部の URL なので main.ts はこれを知らない）と、運用者が足すもの。
              denyHosts: [PUBLIC_HOSTNAME, ...(env["SUBETHA_DENY_HOSTS"] ?? "").split(",").map((host) => host.trim().toLowerCase()).filter((host) => host !== "")],
            },
          }),
    },
    // 上流の節は rail に関係なく `x402` という名前（`src/config.ts`）。全 route 分が要る。
    x402: {
      upstreams: {
        [ROUTE]: UPSTREAM,
        ...(mppInboundEnabled ? { [ROUTE_MPP_IN]: UPSTREAM_X402 } : {}),
      },
    },
  };
}

