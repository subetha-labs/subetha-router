# SubEtha Router — リモート MCP サーバ（Streamable HTTP）。
#
# `fs-ext`（journal の flock）が**ネイティブビルド**を要るので、
# ビルド段でツールを入れ、実行段には成果物だけを持ち込む。
#
#   docker build -t subetha-router .
#   docker run -p 8787:8787 \
#     -e SUBETHA_OUTBOUND_PRIVATE_KEY=0x... \
#     -e SUBETHA_ROUTER_RECEIVER=0x... \
#     subetha-router
#
# 受信レグ（呼び出し側の支払い）の鍵は**このコンテナに渡さない**。
# 渡すのは送信レグ（Provider への支払い）＝運営の資金だけ。

FROM node:22-bookworm-slim AS build
WORKDIR /app

# fs-ext のネイティブビルドに必要。実行段には持ち込まない。
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# 依存は完全一致で固定済み。`--ignore-scripts` で任意のインストールスクリプトを止め、
# fs-ext だけ明示的にビルドする（README の手順と同じ）。
RUN npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund \
  && npm rebuild fs-ext --foreground-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY tools ./tools
# `tools/` は実行に必要な足場だけを使う（Router の子プロセス起動と loopback ヘルパ）。
COPY tests/fixtures ./tests/fixtures

# 出荷するものだけを型検査する（`tests/wire` と `examples` は実行時に使わない）。
# `lib` と `skipLibCheck` を `tsconfig.json` に揃える（`lib` は ES2023 だけ: DOM の型を混ぜない。`skipLibCheck`: 依存の `.d.ts` は検査しない。
# `noUncheckedIndexedAccess`・`exactOptionalPropertyTypes`・`verbatimModuleSyntax` は以前からここでは渡していない）。
# T8-b で入口が `tools/rails-entry.ts` 経由で `src/main.ts` を引き込むようになり（子プロセスの入口はファイル名で起動するので対象外）、
# 既定の lib では DOM の `BodyInit` と衝突した。本番ホスト（1.8 GB）で出たヒープ不足は、依存の `.d.ts` の検査が一因と見ている（証明はしていない）。
RUN npx --no-install tsc --noEmit \
      --strict --module nodenext --moduleResolution nodenext --target es2023 --lib es2023 --types node --skipLibCheck \
      tools/remote-mcp.ts

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 非 root で動かす。journal を書く runtime/ だけ所有させる。
RUN useradd --create-home --uid 10001 router

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/src ./src
COPY --from=build /app/tools ./tools
COPY --from=build /app/tests/fixtures ./tests/fixtures

RUN mkdir -p runtime && chown -R router:router /app/runtime
USER router

EXPOSE 8787
ENV PORT=8787

# ヘルスチェックは無課金の /healthz（Router が上がっているかだけを見る）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "--no-install", "tsx", "tools/remote-mcp.ts"]
