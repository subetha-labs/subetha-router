/**
 * 本番の入口（`tools/remote-mcp.ts`）が Router に渡す**設定の生成**。鍵と子プロセスの起動から切り離してある
 * （試験で、どの env を与えても `dynamic.enabled === false` であることを確かめる。T13）。
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
 * 動的上流 URL の手数料・上限（G-1。owner が 2026-10-06 に決定）。設計 §3.3 の T0-b。
 * - x402 送信（Router にチェーン手数料がかからない）: 定額 1,000（0.001）
 * - MPP 送信（Router が Tempo の手数料を払う。実測 29〜478、署名前の上限 `maxFee` 5,000）: 定額 5,000 = `maxFee`。
 *   `fee.min >= maxFee`（`src/config.ts` が起動時に確かめる）により、**チェーンが請求する額が署名時の上限以下である限り**運営はチェーン手数料を
 *   負担しない（条件つき。設計 §6.6）。その前提が Tempo の仕様で確立するまで、このプロファイルは本番で有効にしない（`docs/DEPLOY.md` §2b の条件 6）。
 * 次のスライス: quote の時点で Tempo の単価を読んで `maxFee` と手数料を決める（平時は安く、高騰時は断る。設計 §11 の「将来の課題」）。
 */
const DYNAMIC_MAX_FEE = "5000";
const DYNAMIC_FEE_X402_OUT = { flat: "1000", bps: 0, min: "1000" } as const;
const DYNAMIC_FEE_MPP_OUT = { flat: DYNAMIC_MAX_FEE, bps: 0, min: DYNAMIC_MAX_FEE } as const;
const DYNAMIC_MAX_UPSTREAM_AMOUNT = "10000";

/**
 * 本番の入口が Router に渡す設定。**鍵と子プロセスの起動から切り離した純粋関数**（試験で、どの env を与えても
 * `dynamic.enabled === false` であることを確かめる。T13）。
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
       * 動的上流 URL（設計 `docs/dynamic-upstream-design.md`）。**本番の入口では常に無効**（`enabled: false`）。
       * 有効にするのは T16 の G-4 で、変えるのはこの関数のこの 1 箇所だけ。env からは変えられない。
       * プロファイルは 2 つ: Base Sepolia USDC で払って MPP（Tempo pathUSD）の上流に届く、Tempo pathUSD で払って x402（Base Sepolia USDC）の上流に届く。
       * 手数料・上限の値は G-1 で owner が決める案（設計 §3.3 の T0-b）。
       */
      dynamic: {
        enabled: false,
        profiles: {
          "dyn-x402-to-mpp": {
            profileId: "dyn-x402-to-mpp",
            sourceRail: "x402",
            source: { network: INBOUND.network, asset: INBOUND.asset, decimals: 6, payTo: receiver },
            rail: "mpp",
            destination: { scheme: "tempo/charge", network: OUTBOUND.network, asset: OUTBOUND.asset, decimals: 6, feeAsset: OUTBOUND.asset, maxFee: DYNAMIC_MAX_FEE },
            par: true,
            maxUpstreamAmount: DYNAMIC_MAX_UPSTREAM_AMOUNT,
            fee: DYNAMIC_FEE_MPP_OUT,
          },
          // 逆向きは、MPP 受信の秘密と x402 送信の鍵がそろっているとき（経路 2 と同じ条件）だけ。
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
        },
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

