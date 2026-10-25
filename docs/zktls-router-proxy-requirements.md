# 秘匿購入の proxy 型 TLS（増分 v1.5）要件定義 v2.1

対象: 本 worktree（`subetha-router/zktls-proxy-20261026`、branch `task/zktls-proxy`、基点 `origin/main` `b9e7710`）。
要件フェーズの成果物であり、設計・実装は含まない。既存の秘匿購入の要件 `docs/zktls-router-requirements.md` v3.3（以下「基礎要件」）の上に足す増分で、
基礎要件の FR-Z*・SR-Z*・TR-* は、本書が明示して置き換えるもの以外すべてそのまま効く。
v1 は Codex の独立レビュー（`.claude_workflow/local/proxy-req-review1.md`、REJECT、blocking 1・should 3・minor 1）を受けて v2 に、v2 の再レビュー（`proxy-req-review2.md`、APPROVE WITH CHANGES、should 1）を受けて v2.1 に改めた（§10 に対応表）。

owner の依頼（2026-10-26）: 「proxy 型を Router に組み込むための要件定義から進めていきましょう」。前提となった owner の判断（同日）:
- 利用先の Provider を Router に隠す設計はしない（受信・送信の `payTo` で Provider は Router に分かるため）。既存の TLS・zkTLS の経路を続ける。
- MPC 型と proxy 型の比較の結果、proxy 型で進める。MPC 型は残す。
- proxy 型で残る 2 つのリスク（Provider から全利用者が Router の IP に見える、Router↔Provider の経路を信頼する）は、必要になった時点で対策する前提で受け入れる。

## 1. 背景と目的

基礎要件の秘匿購入では、Payer の executor（TLSNotary の prover）と Router の Verifier が **MPC-TLS** を行い、TLS の鍵の計算を両者で分担する。
Payer は Provider に**直接** TCP 接続し、Verifier とは別の接続で 2 者計算を行う。

**proxy 型**（TLSNotary の Proxy-TLS。上流の説明: https://tlsnotary.org/docs/protocol/proxy-mode 、https://tlsnotary.org/blog/2026/04/22/proxy-mode ）では、
Payer は TLS の鍵を自分だけで持ち、TLS の通信を **Verifier 経由で** Provider と行う。Verifier は Provider への TCP 接続を自分で開いて暗号文を中継・記録し、
通信の後に Payer が鍵の導出と記録の整合を ZK で証明する。

目的は、秘匿購入の主張の範囲（基礎要件 §1）と Router が見ないもの（FR-Z10）を保ったまま、MPC-TLS の 2 者計算を proxy 型に替えられるようにすること。
比較の実測（`subetha-zktls-mpc-vs-proxy-20261026/REPORT.ja.md`。この worktree の外。TLSNotary 本体のみ、Payer↔Verifier の回線だけ模擬、各 3 回の中央値）:

| 回線（往復・帯域） | MPC 型 | proxy 型 |
|---|---|---|
| 遅延なし | 0.27 s | 0.13 s |
| 50 ms・100 Mbps | 5.57 s | 1.09 s |
| 150 ms・20 Mbps | 21.92 s | 3.08 s |
| Payer→Verifier の通信量（1 回、要求上限 2 KiB） | 38.7 MB | 0.54 MB |

同じ調査で、proxy 型でも応答本文の SHA-256 平文 commitment（lab の配送証明が結び付く commitment と同じ形）が MPC 型と同じ形で Verifier に届くことを確かめた
（応答 1 KiB・16 KiB、prover と verifier のハッシュが一致。`commit-check.txt`）。

## 2. 所有権と依存

| 対象 | 所有 | 本増分での扱い |
|---|---|---|
| zkTLS lab の `delivery` バイナリ（`subetha-zktls-router` worktree `private-payment-binding-20261017`、`phase3/runner/src` を phase5 でビルド） | lab の担当セッション（`private-payment-binding-20261017-e5`） | **本増分の前提条件**。現在の `verifier-serve` は proxy 型を明示的に拒否する（`tls.rs` の `VerifierCommitStart::Proxy` → `"expecting MPC-TLS"`）。proxy 型の対応は lab の変更であり、**Router 側からは編集しない**。必要な契約を §5 に書き、owner 経由で lab に依頼する |
| Router 本体・`tools/private-payer.ts`・テスト | 本 worktree | Router 側の変更の全部 |
| 既存の秘匿購入の実装（`zktls-router-20261020`、セッション `zktls-router-20261020-b4`） | 別セッション | 変更しない。本増分は `origin/main` の上で同じファイルに追加変更をするので、統合の順序は owner と調整する |
| Provider A/B/C/F、第三者 Provider | 各所有者 | 読み取り専用の相手。**proxy 型のために Provider 側の変更は要らない**（Provider から見れば普通の TLS クライアントが Router の IP から来るだけ） |

## 3. スコープ

| # | 内容 | 本増分 |
|---|---|---|
| P1 | 基礎要件 Z1〜Z3 の経路（x402 受信・SubEtha V2 burn-sale 受信 → x402 送信 / MPP Tempo pull 送信、POST 秘匿本文・公開 GET）を proxy 型で通す | 対象 |
| P2 | MPC 型をそのまま残し、プロファイルごとに型を選ぶ | 対象 |
| P3 | proxy 型の attestation（Notary 署名。第三者への持ち運べる証明） | 対象外（上流の正式な支持が未確認。§8） |
| P4 | Router が署名する受領証（Agent 間の委任などで第三者に見せる形） | 対象外（別の増分。§8） |
| P5 | Router の送信元 IP の分散、Router↔Provider の経路の強化（配置・DNS の固め） | 対象外（owner が受け入れたリスク。§6 で開示と記録だけ行う） |
| P6 | Verifier の公開露出（loopback 以外の listen）、hosted への配備、`@subetha/payer` 統合 | 対象外（基礎要件 §7 のまま） |

## 4. 機能要件

### 4.1 型の選択・承認・互換性
- FR-X01 **型はプロファイルで決める**: 設定 `private.proxyProfiles`（`private.profiles` の部分集合。省略時は空）。ここに載ったプロファイルの秘匿 quote は proxy 型、
  それ以外は MPC 型。Payer が quote で型を選ぶ入力は設けない。`private.proxyProfiles` に `private.profiles` に無い ID があれば `ConfigError`。
- FR-X00 **MPC 型の不変と、増えるのは proxy 型だけ**（互換性の規則）:
  - MPC 型の quote 文書・quote の記録・承認の指紋（`privateAuthoritativeTermsOf` の値）・journal の行・射影・record の検査は、`proxyProfiles` の有無にかかわらず
    **今と byte 単位で同じ**。MPC 型には型の欄を足さない（型の欄が無いことが MPC 型を意味するのは、**本増分より前から存在する形**についてだけ）。
  - proxy 型の quote・記録・指紋・journal の行・射影だけが `tls: {mode: "proxy"}` などの欄を持つ（FR-X02・X03・X13）。
  - **欠落を MPC 型と読み替えない**: proxy 型として発行した quote の記録（指紋に proxy を含むもの）に対しては、journal の行・record・attest のどれかで型の欄が欠けていれば
    fail closed（quote なら `quote_changed`、record なら FR-X09）。逆に、MPC 型の quote に proxy 型の record（`tls_mode: "proxy"`）が来ても fail closed。
  - 既存の journal（本増分より前の行）と保存済みの quote は今と同じ意味で読む（すべて MPC 型）。
  - config golden（`proxyProfiles` を持たない設定）と、MPC 型の journal・射影の golden は**更新しない**。proxy 型の golden は新しく足す。
  - バイナリ（`deliveryBinSha256`）の更新は既存の規則（open-items §A-4 A-1-3）どおり指紋を変え、発行済みの quote を `quote_changed` で止める。これは型によらない既存の挙動。
- FR-X14 **バイナリの能力の門**（資金が動く前に止める）: `proxyProfiles` が空でないとき、Router は起動時に `delivery` の能力の宣言（LX-6）を読み、`proxy` を含まなければ
  `ConfigError`（実モードでは起動しない）。宣言を読めないバイナリ（今の lab のバイナリ）も同じ。`proxyProfiles` が空なら能力の門は読まない（MPC 型の起動は今と同じ）。
- FR-X02 **承認対象への開示**（proxy 型の quote だけ）: 秘匿 quote の `private` 欄（基礎要件 FR-Z14）に `tls: {mode: "proxy"}` を足し、`disclosures` に次を足す:
  `routerConnectsToProvider: true`（Router が Provider へ接続し、TLS の暗号文・長さ・時刻を中継する）、`providerSeesRouterAddress: true`
  （Provider から見える送信元は Router の IP で、Provider の IP 制限・遮断・レート制限は Router を使う全利用者に効く）、
  `trustsRouterProviderPath: true`（主張は Router↔Provider のネットワーク経路を信頼する。SR-X2）。
- FR-X03 **型の束縛**: proxy 型の quote は、承認の指紋（`privateAuthoritativeTermsOf`）に `tlsMode: "proxy"` を含め、quote の記録に型を写す。
  設定の変更で型が変わった quote（proxy → MPC、MPC → proxy）は既存の `quote_changed` で止める。Verifier の起動・attest の検査・射影は**記録の型**に従う。
- FR-X04 **上限の開示**: proxy 型の quote の `limits` は MPC 型と同じ値を示す。値の由来を区別して扱う: 要求の大きさの上限 4096 B は lab の要求の組み立ての上限
  （MPC 型の送信予算に由来し、lab の互換のため proxy 型でも続ける。lab `request.rs`）、本文 ≤ 512 B と資格情報の穴 ≤ 64 B は要求束縛の回路の上限、
  **応答本文** ≤ 704 B は配送証明の回路の上限（応答全体ではない。応答ヘッダは別）、TLS 1.2 の対応 suite は上流の制約。値が変わるのは lab が変えたときだけ。

### 4.2 Router の Provider への接続（proxy 型の新しい外向き通信）
- FR-X05 **接続先の固定**: proxy 型の Verifier が接続してよいのは、記録の `target`（host・port 443）を FR-X06 で解決・検査して固定した IP:443 だけ。
  Verifier は Payer から受け取る proxy の設定のサーバー名（上流 `ProxyTlsConfig::server_name`。commit の受付の時点で読める）が記録の host と一致することを、
  **Provider に接続する前に**確かめ、違えば接続せずに拒否する（LX-1）。
- FR-X06 **名前解決・宛先の検査・固定は発行の前**: Router は、発行予約（基礎要件 FR-Z06）の**前**、FR-Z18 の 2 回目の再照合と同じ段で Provider の host を解決し、
  既存の上流の宛先の方針を**そのまま継承**して検査する: `parseUpstreamUrl` と deny list、`src/net/destination-policy.ts` の `classifyAddress`（DENY4・DENY6、
  Router 自身のインターフェースのアドレス `own_address`、loopback・unspecified・special purpose、IPv4-mapped IPv6 の正規化）、`src/net/guarded-fetch.ts` の解決の規則
  （**全回答**を分類し 1 つでも禁止なら拒否、解決の期限と同時数の上限、回答 0 件は失敗）。通った回答のうち 1 つ（選び方は設計で決める）を**固定**して journal に書き、
  Verifier には IP:443 として渡す。Verifier と Router は以後その名前を引き直さない（探りの時と session の時で宛先がすり替わる DNS rebinding を、発行前の解決と固定で防ぐ）。
  検査に通らない・解決できない場合は**発行しない**: 発行予約の前の失敗なので、基礎要件 FR-Z09 の規則どおり `paid_undelivered`（理由 `private_proxy_dial_refused`）。
  試験では、既存の `*ForTest` と同じく合成に注入した試験用の解決だけが loopback の fixture の IP を返せる（実入口 `src/main.ts` は渡さない）。
- FR-X07 **中継の上限**: Verifier は方向ごとの中継バイト数（TLS の記録の暗号文と handshake を含む）に上限を課す。Payer→Provider は要求の上限 4096 B に TLS の handshake と
  記録の余裕を、Provider→Payer は応答（ヘッダ + 本文 ≤ 704 B）に証明書の連鎖と記録の余裕を足した値（具体値は設計で決め、lab に引数で渡す。LX-4）。
  セッション期限（FR-Z15 (b)）は proxy 型にもそのまま効く。
- FR-X08 **発行後の失敗の帰結と通知**: 発行後の Provider への接続の失敗・サーバー名の不一致・中継の上限超過・TLS の途中切断・期限切れは、基礎要件 FR-Z09 のとおり耐久的な
  `unknown`。理由は lab の**固定形の失敗通知**（LX-7）で区別する: `private_proxy_dial_failed`（接続の失敗）、`private_proxy_server_name_mismatch`、`private_proxy_limit`。
  通知が無い・読めない・形が違う終了は既存どおり `private_session_timeout`。Router の期限（`sessionBy`）で子を止めた場合は、通知の有無によらず `private_session_timeout`
  （Router が止めた後に書かれた通知は読まない。順序は設計で固定する）。再起動をまたぐ場合は基礎要件 FR-Z25 の帰結のまま（通知は読まない）。
  どの場合も再接続・再発行・再署名・MPC 型への切り替えはしない（at-most-once）。通知は理由の区別のためだけに使い、資金の結果の証拠として扱わない。

### 4.3 record と attest
- FR-X09 **record の型**: proxy 型の record は `tls_mode: "proxy"` と、Verifier が実際に接続した `provider_addr`（IP:port）を持つ（LX-3）。MPC 型の record は今の形のまま
  （`tls_mode` を持たない）。Router は、proxy 型の購入では `tls_mode === "proxy"` かつ `provider_addr` が FR-X06 で固定した値と一致すること、MPC 型の購入では
  `tls_mode` が無いことを要求する。どちらに外れても、その record は「この購入に束縛されていない record」として扱う（基礎要件の session の終了の処理と同じく保持しない。
  送信レグは `unknown`、理由 `private_session_timeout`）。attest の時点で型が合わない場合は `private_attest_invalid`。
- FR-X10 **主張の検査は同じ**: proxy 型でも FR-Z08 の検査（trust・`target`・`server_name`・`revealed_prefix` の厳密一致・本文/穴のハッシュ・要求束縛証明・
  `verifier-verify`・`200`・領収の規則・期待 tx）をすべて同じ条件で行う。proxy 型だからといって緩めるものは無い。
- FR-X11 **Router が見ないものは同じ**: FR-Z10 の秘匿（要求本文・salt・穴の nonce・Payer 鍵・応答本文・復号鍵が Router に届かない）を proxy 型でも満たす。
  proxy 型で Router が新たに得るのは、TLS の暗号文（Router は鍵を持たず復号できない）・各方向の長さと時刻・Provider の IP だけ。暗号文は record・journal・診断・一般ログ・
  子プロセスの stdout/stderr の保存先・作業ディレクトリのどこにも書かない（lab の Verifier が証明の検証のために内部で持つ分は除く。LX-3）。

### 4.4 Payer の道具
- FR-X12 `tools/private-payer.ts` は quote の `private.tls.mode` に従って executor を起動する（proxy 型では executor は Provider へ直接接続しない）。承認の前の表示に型と
  FR-X02 の開示を出す。proxy 型で `--connect`（fixture への差し替え）は意味を持たないので拒否する（fixture への到達は Router 側の試験用 dial で行う）。

### 4.5 状態・射影・理由コード
- FR-X13 proxy 型の購入の射影の `private` 欄に `tls: {mode: "proxy", providerAddr}` と FR-X02 の開示を足す（MPC 型の射影は不変。FR-X00）。保存と再起動の後も同じ値を読む。
  新しい理由コードは `private_proxy_dial_refused`（発行前、`paid_undelivered`）・`private_proxy_dial_failed`・`private_proxy_server_name_mismatch`・`private_proxy_limit`
  （発行後、`unknown`）の 4 つだけ（固定語。SR-Z3）。既存の状態・理由・journal の行の形は変えない。

## 5. lab の `delivery` に求める契約（依頼の内容。lab の判断で形を変えてよいが、Router はこの意味を前提にする）
- LX-1 `verifier-serve --tls-mode proxy --provider-addr <ip>:443`: Payer の commit が Proxy のときだけ受け付け（MPC を拒否）、`ProxyTlsConfig` のサーバー名を `--expect-host` と
  照合してから `--provider-addr` へ接続する（名前を引き直さない）。`--tls-mode` が無い・`mpc` なら今と同じ挙動（MPC だけ受け付け、Proxy を拒否）。
- LX-2 `executor-session --tls-mode proxy`: Proxy-TLS で commit し、TLS を Verifier 経由で行う（`--connect` は使わない）。要求の組み立て・開示・commitment（要求の
  `X-Lab-Credential` の穴と本文の SENT commitment 2 つ、応答本文の RECV の SHA-256 commitment）は MPC 型と同じ。
- LX-3 proxy 型の record は `tls_mode: "proxy"` と接続した `provider_addr` を持つ。MPC 型の record の形は変えない。`verifier-verify`・`executor-prove`・`payer-decrypt`・回路・SRS は
  型によらず同じであること（§1 の調査は応答本文の RECV commitment の一致だけを示した。POST の SENT commitment 2 つと配送証明・要求束縛証明まで通すことは lab の確認を要する）。
  中継した暗号文を record・stdout・stderr・作業ディレクトリに書かない。
- LX-4 中継の上限（FR-X07）を `verifier-serve` の引数（方向ごと）で受ける。
- LX-5 変更後のバイナリの sha256（`deliveryBinSha256`）を Router に渡す。MPC 型の挙動は変えない（既存の Router の wire がそのまま通ること）。
- LX-6 **能力の宣言**: 副作用の無いサブコマンド（例 `delivery capabilities`）が固定形の JSON（例 `{"tls_modes":["mpc","proxy"]}`、≤ 256 B）を stdout に出す（FR-X14）。
- LX-7 **固定形の失敗通知**: `verifier-serve` は proxy 型の失敗のとき、作業ディレクトリに create-new で `failure.json`（≤ 256 B、`{"reason": "proxy_dial_failed" |
  "proxy_server_name_mismatch" | "proxy_limit"}` の固定語だけ。例外文字列・アドレス・暗号文を含めない）を書いてから非 0 で終了する。record と failure.json は排他（両方は書かない）。

## 6. 安全要件と主張の範囲
- SR-X1 基礎要件の SR-Z1〜SR-Z5 をそのまま満たす。MPC 型の経路の挙動・journal・射影は変えない（`proxyProfiles` に載らないプロファイルは byte 単位で不変）。
- SR-X2 **主張の範囲の差**（承認対象と射影で開示する）: proxy 型の `delivered_private` は、基礎要件 §1 の主張に加えて「Router が接続した Router↔Provider の
  ネットワーク経路を信頼する」前提に立つ。Payer がこの経路上の攻撃者と組めば、Provider ではない相手の応答を証明できる余地がある（上流の proxy 型の安全モデル）。
  MPC 型にはこの前提は無い。この差を `disclosures.trustsRouterProviderPath` と射影の `private.tls.mode` で区別できるようにし、MPC 型と同じ主張として表示しない。
- SR-X3 Router の IP の集中（FR-X02 の `providerSeesRouterAddress`）は開示と記録だけ行い、分散は本増分でしない。Provider が Router の IP を拒否した場合の結果は
  FR-X08（発行後なら `unknown`）で、自動で MPC 型に切り替えたり再試行したりしない。
- SR-X4 proxy 型の外向き接続は FR-X05・FR-X06 の宛先だけ。Payer が中継の先を選べてはならない。

## 7. テスト要件
- TR-X1 単体:
  - 設定: `proxyProfiles` の部分集合の検査、能力の門（宣言に proxy が無い・読めない → `ConfigError`、`proxyProfiles` が空なら門を読まない）、`proxyProfiles` の無い設定で
    config golden と MPC 型の quote・指紋・journal・射影の golden が**更新なしに**通ること。
  - quote: proxy 型の `tls`・`disclosures`・指紋の `tlsMode`。型の変更（proxy ↔ MPC）で `quote_changed`。proxy 型の quote の記録から型の欄を消すと fail closed。
  - 宛先（FR-X06）: deny list、DENY4/DENY6 の各種、Router 自身のアドレス、IPv4-mapped IPv6、回答のうち 1 つだけ禁止、回答 0 件、解決の期限切れ、同時数の上限。
    いずれも発行予約の行を書かず、送信 adapter の `issueCredential` が 0 回、結果は `paid_undelivered`（`private_proxy_dial_refused`）。
  - **固定の維持**: 発行前に固定した IP の後に解決の答えを変えても、Verifier の引数は固定した IP のまま（解決の呼び出し回数を spy で数え、発行後は 0 回）。
  - record・attest: `tls_mode` と `provider_addr` のすり替え・欠落、MPC 型の購入への proxy 型の record、で fail closed。
  - 失敗通知（LX-7）: 3 つの固定語 → 対応する理由コード、通知無し・形違い・大きすぎ → `private_session_timeout`、Router の期限で止めた後の通知は読まない、再起動では読まない。
  - 秘匿: proxy 型の失敗・成功の両方で、射影・journal・診断・保存した子プロセスの出力・作業ディレクトリに本文・暗号文の canary が無いこと。
  - payer 道具: `private.tls.mode` への追従、proxy 型での `--connect` の拒否、承認前の表示に型と開示。
- TR-X2 wire（実プロセス・実 TCP・loopback TLS、試験 trust = synthetic。基礎要件 TR-2 と同じ構成。**proxy 型で実行したことを record の `tls_mode` と Verifier の
  `provider_addr` で確かめる**）: lab の proxy 対応バイナリで、
  - x402 受信 → x402 送信の POST 秘匿本文と GET、SubEtha V2 burn-sale 受信（既存の V2 fixture）→ x402 送信の 1 経路を、proxy 型で全経路（quote → purchase → session →
    attest → record → `payer-decrypt` → status）。各経路で、Router の送信 credential の発行が 1 回、Verifier の Provider への接続が 1 回であること。
  - 否定: サーバー名の不一致は Provider（fixture）への接続が 0 回で `unknown`（`private_proxy_server_name_mismatch`）、中継の上限超過、Provider への接続失敗、型のすり替え。
    いずれも発行は 1 回のまま増えず、再接続・MPC 型への切り替えが無い（fixture の接続回数と Router の発行の数で確かめる）。
  - セッション期限切れ: proxy 型のセッションを `sessionBy` まで完了させない（Payer が Verifier に接続しない場合と、TLS の途中で止まる場合の 2 つ）。どちらも
    `unknown`（`private_session_timeout`）、発行は 1 回、期限の後に Provider（fixture）への接続回数が増えず、MPC 型への切り替えが無いこと。
  - 保存と再起動: proxy 型の購入の射影の `tls.mode`・開示が再起動後も同じ。release 後の再起動で `unknown` のまま、発行・接続が増えない。
  - MPC 型の既存 wire（`tests/wire/private-*.test.ts`）が変更なしに通ること。
  - lab の proxy 対応バイナリが無ければ skip（skip は合格ではない）。
- TR-X3 受入（testnet、実 PKI = `mozilla`）: Provider C（Z1）を proxy 型で 1 件、Provider F（Z2）を proxy 型で 1 件。受信決済・送信決済・秘匿配送・Payer 受領・finality を
  別々のゲートとして記録する（基礎要件 TR-3 と同じ）。所要時間を MPC 型の既存の受入と並べて記録する（判断材料。合否条件ではない）。
  testnet の送金は owner の包括の承認（2026-10-22）の範囲で行い、実行の前に支払いの範囲（Provider・額・回数）を記録する。
- TR-X4 `npm test` と config golden が不変に通ること。

## 8. 非目標・未解決
- proxy 型の attestation（Notary 署名）と、それを使った「紛争のときだけ第三者に開示する」流れ。上流の attestation の例は proxy 型を拒否しており、正式な支持が確認できていない。
- Router が署名する受領証（Agent の委任などで、Router の検証結果を第三者に持ち運ぶ形）。受領証に入れる内容は Router に開示した部分に限られる。
- Router の送信元 IP の分散と、Router↔Provider の経路の強化。
- lab が proxy 型に対応しない・できない場合、本増分は TR-X1 の範囲で止まる（Router 側の実装は MPC 型の挙動を変えないので、入れても害は無い。入れるかは owner の判断）。

## 9. 用語
- **MPC 型**: TLSNotary の MPC-TLS。Payer と Verifier が TLS の鍵を 2 者計算で扱い、Payer が Provider へ直接接続する（基礎要件の方式）。
- **proxy 型**: TLSNotary の Proxy-TLS。Payer が TLS の鍵を持ち、TLS の通信は Verifier が中継する。Verifier は暗号文を記録し、通信の後に Payer が ZK で整合を証明する。
- 他の用語（intent・最終注文・release・record・bundle・attest）は基礎要件 §8 のとおり。

## 10. v1 → v2 の対応（Codex 要件レビュー 1 回目）
| 指摘 | 対応 |
|---|---|
| blocking 1: MPC の byte 不変と型の追加の矛盾 | FR-X00（MPC 型には欄を足さない、増えるのは proxy 型だけ、欠落を MPC と読み替えない、golden の維持と追加の区別）、FR-X14（能力の門）、FR-X03・X09・X13 を proxy 型だけに限定 |
| should 2: `private_proxy_limit` の伝達 | LX-7（固定形の `failure.json`、record と排他）、FR-X08（理由の写像、期限・再起動との順序） |
| should 3: 宛先の防御の継承 | FR-X06（`classifyAddress`・全回答・期限・同時数・自アドレス・IPv4-mapped の継承、解決と固定を発行の前に移して拒否は `paid_undelivered`） |
| should 4: proxy 固有の試験 | TR-X1・TR-X2（固定の維持、発行と接続の回数、fallback 無し、再起動後の型、V2 受信の proxy wire、子プロセス出力と作業ディレクトリの canary、proxy で走ったことの確認） |
| 再レビュー should 4 の残件: proxy の期限切れ試験 | TR-X2 に 2 通りの期限切れ（接続しない・途中で止まる）と回数の条件を追加（v2.1） |
| minor 5: 上限の由来 | FR-X04（4096 B は要求の組み立ての上限、704 B は応答本文、ヘッダは別）、FR-X07 |
