/**
 * chat 側の実実装（`createRouterChatExecution`）を**別プロセスで one-shot 実行**する driver。
 * **テスト基盤であり製品コードではない。**
 *
 * なぜ子プロセスか: chat 側は `.mts` を Node の type-stripping で動かす前提で、こちらは vitest。
 * 同じ実行系で動かして transform 差異による偽陰性を避ける。既存 `loopback.ts` の `spawnApp` は
 * stdin が `ignore` なので親からステップ指示を送れない。そのため **argv でシナリオ名を受け取り、
 * 全ステップの観測を stdout の JSON 行で出して exit する** one-shot 形にしている。
 *
 * なぜ動的 import か: `tsconfig.json` は `rootDir: "."` で emit する（`npm run build`）。
 * worktree 外の `.mts` を静的 import すると `types` / `build` が壊れるため、
 * **非リテラル指定子の動的 import** で参照し、戻りは `unknown` 経由で扱う。
 *
 * chat 側のファイルは**読むだけで、一切変更しない**。
 * 支払い能力は**署名しない spy**（nonce を返すだけ。鍵なし・送金なし）か、未注入。
 *
 * usage: chat-router-driver.ts --chat-dir DIR --scenario NAME --router-origin URL
 *        --directory DIR --route-id ID --principal ID --bearer TOKEN [--payer on|off]
 *        [--upstream-url URL] [--provider-id market-data-a|market-data-b]
 */

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const chatDir = arg("chat-dir", "");
const scenario = arg("scenario", "");
const routerOrigin = arg("router-origin", "");
const directory = arg("directory", "");
const routeId = arg("route-id", "");
const principalId = arg("principal", "");
const bearer = arg("bearer", "");
const payerMode = arg("payer", "on");
const upstreamUrl = arg("upstream-url", "");
const providerId = arg("provider-id", "market-data-a");

/** 観測を 1 行ずつ出す。親テストはこの行だけを根拠にする。 */
function emit(step: string, detail: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ step, ...detail })}\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ChatModule {
  createRouterChatExecution(config: unknown, capabilities: unknown): unknown;
}

interface OpenExecution {
  quote(authority: unknown): Promise<Record<string, unknown>> | Record<string, unknown>;
  proposal(args: unknown, authority: unknown): Promise<Record<string, unknown>> | Record<string, unknown>;
  validateApproval(input: unknown, authority: unknown): unknown;
  approve(explicit: true, context: unknown, signal: AbortSignal): Promise<void>;
  status(): Record<string, unknown>;
  close(): void;
}

interface ChatProfile {
  open(owner: string): OpenExecution;
}

async function main(): Promise<void> {
  // 動的 import（静的にすると rootDir 外のため types/build が壊れる）。
  const executionSpec = `${chatDir}/router-execution.mts`;
  const contractSpec = `${chatDir}/router-contract.mjs`;
  const chat = (await import(executionSpec)) as unknown as ChatModule;
  const contract = (await import(contractSpec)) as unknown as Record<string, unknown>;

  const resultProfile = { providerId, url: upstreamUrl, method: "GET" as const };
  const config = {
    routerOrigin,
    routeId,
    principalId,
    revision: "t5",
    timeoutMs: 20_000,
    // 購入の期限は timeoutMs に効かない（client の既定 180 秒）。この driver は従来の 20 秒の上限を保つ。
    executeTimeoutMs: 20_000,
    resultProfile,
  };

  let payerCalls = 0;
  const capabilities: Record<string, unknown> = {
    routerAuthentication: async () => ({ principalId, bearer }),
    transport: async (url: string, init: RequestInit) => await fetch(url, init),
  };
  if (payerMode === "on") {
    // **署名しない spy**: offer をそのまま返し、その offer 自身の `challengeNonce` を
    // payload に写すだけ。鍵・署名・送金は無い。Router の strict preflight は
    // `credential.payload.challengeNonce === offer.extra.challengeNonce` を要求するため
    // （`src/adapters/inbound/subetha.ts:178`）、固定値では `nonce_mismatch` になる。
    capabilities["prepareSubethaCredential"] = async (input: { offer: unknown }) => {
      payerCalls += 1;
      const offer = input.offer as { extra?: { challengeNonce?: unknown } } | undefined;
      const challengeNonce = offer?.extra?.challengeNonce;
      return { x402Version: 2, accepted: input.offer, payload: { challengeNonce } };
    };
  }

  const factory = chat.createRouterChatExecution(config, capabilities) as (
    options: unknown,
  ) => ChatProfile;

  let sessionId: string | undefined = "t5-session";
  const authority = {
    operatorSessionId: "t5-session",
    current: () => (sessionId === undefined ? undefined : { operatorSessionId: sessionId }),
  };

  const create = scenario !== "reopen" && scenario !== "foreign-status";
  const profile = factory({ directory, create, operatorId: "owner", mode: "create" });
  const open = profile.open("owner");

  try {
    if (scenario === "contract-anchor") {
      emit("anchor", {
        profile: contract["PROFILE"],
        protocol: contract["PROTOCOL"],
      });
      return;
    }

    if (scenario === "payer-unconfigured") {
      // payer を注入しない構成では承認経路に進めない。
      const snapshot = open.status();
      emit("status", {
        executionAvailability: snapshot["executionAvailability"],
        approval: snapshot["approval"],
      });
      return;
    }

    if (scenario === "foreign-status") {
      // 既存の journal（別 principal が作ったもの）を、こちらの資格で開き直す。
      // chat の `recover()` は保存済み binding の paymentId を R4 に問い合わせるが、
      // Router は所有者以外へ 404 を返す。chat 側は 401/403/429 のみを
      // `router_access_denied` に写すので、404 は `status_unknown` として安全に失敗し、
      // 他人の購入内容（結果・状態）は一切見えない。
      const before = open.status();
      emit("foreign-before", {
        payment: before["payment"],
        error: before["error"],
        purchase: before["purchase"] ?? null,
      });
      // reopen 経路の R4 問い合わせを実際に走らせる。
      try {
        await open.quote(authority);
        emit("foreign-quote", { ok: true });
      } catch (error) {
        emit("foreign-quote", { ok: false, error: messageOf(error) });
      }
      const after = open.status();
      emit("foreign-status", {
        payment: after["payment"],
        error: after["error"],
        purchase: after["purchase"] ?? null,
        reopened: after["reopened"],
      });
      return;
    }

    if (scenario === "reopen") {
      // 別プロセスで同じ journal を開き直す（保存 → 再オープン相当）。
      const snapshot = open.status();
      emit("reopened", {
        reopened: snapshot["reopened"],
        payment: snapshot["payment"],
        error: snapshot["error"],
        executionAvailability: snapshot["executionAvailability"],
        purchase: snapshot["purchase"] ?? null,
      });
      return;
    }

    // ここから R2（quote）を実 Router に取りに行く。
    let quoted: Record<string, unknown>;
    try {
      quoted = await open.quote(authority);
      emit("quote", { ok: true, keys: Object.keys(quoted).sort() });
    } catch (error) {
      emit("quote", { ok: false, error: messageOf(error) });
      return;
    }

    const snapshotAfterQuote = open.status();
    emit("prepared", {
      approval: snapshotAfterQuote["approval"],
      executionAvailability: snapshotAfterQuote["executionAvailability"],
      preparedBinding: typeof snapshotAfterQuote["preparedBinding"] === "string",
    });

    if (scenario === "quote-only") {
      return;
    }

    const proposal = await open.proposal({ operation: "router.purchase" }, authority);
    const operationId = String(snapshotAfterQuote["operationId"] ?? "");
    const binding = String(snapshotAfterQuote["preparedBinding"] ?? "");
    emit("proposal", { operation: (proposal["arguments"] as Record<string, unknown>)["operation"] });

    if (scenario === "unapproved") {
      // 承認せずに終える。R3 に到達していないことは親が proxy 計数で確かめる。
      emit("skipped-approval", {});
      return;
    }

    const envelopeOf = contract["approvalEnvelope"] as (
      id: string,
      binding: string,
    ) => Record<string, unknown>;

    let envelope: Record<string, unknown>;
    if (scenario === "wrong-quote-approval") {
      // 別 quote の束縛で承認を作る（束縛が動いていれば credential も R3 も呼ばれない）。
      envelope = envelopeOf(operationId, binding.replace(/.$/, "x"));
    } else {
      envelope = envelopeOf(operationId, binding);
    }

    let context: unknown;
    try {
      context = open.validateApproval(envelope, authority);
      emit("validate-approval", { ok: true });
    } catch (error) {
      emit("validate-approval", { ok: false, error: messageOf(error) });
      return;
    }

    try {
      await open.approve(true, context, AbortSignal.timeout(20_000));
      emit("approve", { ok: true, payerCalls });
    } catch (error) {
      emit("approve", { ok: false, error: messageOf(error), payerCalls });
    }

    const afterApprove = open.status();
    emit("after-approve", {
      payment: afterApprove["payment"],
      error: afterApprove["error"],
      latch: afterApprove["latch"],
      executionAvailability: afterApprove["executionAvailability"],
      purchase: afterApprove["purchase"] ?? null,
    });

    if (scenario === "double-approve") {
      // 2 回目の承認。R3 が再送されないことを親が proxy 計数で確かめる。
      try {
        const again = open.validateApproval(envelopeOf(operationId, binding), authority);
        await open.approve(true, again, AbortSignal.timeout(20_000));
        emit("second-approve", { ok: true, payerCalls });
      } catch (error) {
        emit("second-approve", { ok: false, error: messageOf(error), payerCalls });
      }
      emit("after-second", { payment: open.status()["payment"], payerCalls });
    }

    if (scenario === "lock-conflict") {
      // ロック保持中に同じディレクトリをもう一度開く（fail closed の確認）。
      try {
        factory({ directory, create: false, operatorId: "owner", mode: "open" }).open("owner");
        emit("second-open", { ok: true });
      } catch (error) {
        emit("second-open", { ok: false, error: messageOf(error) });
      }
    }
  } finally {
    try {
      if (scenario !== "lock-conflict") {
        open.close();
      }
    } catch {
      // close の失敗自体は観測済みの状態を変えない。
    }
    sessionId = undefined;
  }
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    emit("driver-error", { error: messageOf(error) });
    process.exit(1);
  },
);
