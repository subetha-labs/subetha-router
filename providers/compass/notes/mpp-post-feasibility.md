# MPP動的POST・本文束縛の限定調査

2026-10-15 / author: Codex / Claude独立再review: **LGTM（必須0・任意3）**。controller read-back済み。実装・採用許可とは別。記録は [mpp-post-feasibility-review.md](mpp-post-feasibility-review.md)。
対象worktree: `compass-gcp-prototype`、branch: `task/compass-gcp-prototype`、base: `10dd7956d1f9944075edce3d24fba361208a8d5a`（前調査と同じ）。開始時statusは `.k5/`、`docs/compass/`、`providers/compass/` が未追跡。worktree一覧を確認し、他worktreeには触れていない。
owner承認はRouter最小変更を含む**調査のみ**。本書だけを編集。実装・既存docs・state/lock・gitへの書込、ネットワーク、取得、秘密探索、署名、試験、外部操作はしていない。依存コードのコピー/vendorなし。
入力: [前調査](feasibility.md)、[前review](feasibility-review.md)、`docs/compass/requirements.md` §3/5、`design.md` §3〜6、`tasks.md` G0a/G1/K01。現採用案・価格・製品制約の自動置換はしない。

## 結論

**単一recipient・固定価格のまま成立しうる束縛候補はSolanaのexternalId→Memo。ただし全体成立は未確定・実装開始不可。** 32 receiverと各seller鍵の代わりに、全文digest Memoと本文照合を使える見込みがある。別fee payer鍵・SOL費用は残る。
次段候補はSolanaの純粋な束縛offline proof。pay-kit 0.13.1の確認した公開口では、固定chargeのverify/共同署名・送出の分離口と、要求ごとのexternalId発行・cache上限制御が未確認で**blocker**。純粋Provider validator→永続CAS→推論→SDK決済という別候補も未設計・未実証であり、分離口未確認だけでSolana全体を不可能とは断定しない。
Tempoは既存attribution経由では56 bitのchallenge束縛とpush先払いが残り、今回の「小さく強い本文束縛」には非推奨。どちらも設計上の簡素化と実購入成立は別であり、実settlement/E2Eの証拠はない。

| 観点 | Tempo動的 | Solana動的 |
|---|---|---|
| 現状 | GET限定、pushのみ | GET限定、pull・別fee payer、読取profileはdevnet |
| 署名への経路 | HMAC付きchallenge ID→7-byte keccak断片→32-byte attribution memo | externalId全文→UTF-8 Memo→payer署名message |
| 本文との結合候補 | metaへ本文digest/URL/method、Provider再計算。ただし支払い署名への橋は56 bit | domain付き束縛digestをexternalIdへ、Router/Provider双方で再計算・Memo完全一致 |
| 主な障害 | truncation、独自memo拒否とSDK上書き、送金後の拒否・障害損失 | 固定charge分離口・要求別externalId発行/cache上限・文脈単位の再購入防止が未確認、既存profileはdevnetのみ、本番変更は別scope、license不明 |

## GET拒否の削除だけでは不足

- 再利用: `src/core/dynamic.ts:53-71,353-364` のstableJson・8 KiB制限・UTF-8 SHA256・保存body、`ports/outbound.ts` のUpstreamTarget(method/body)、既存承認・offer完全一致・期限・unknown処理。Compass固有Unicode/schema/bundle検査は別途必要。
- Tempo: `mpp.ts:424-470` のreadChallenge/estimateFee/payの3拒否点を限定変更し、readChallengeのURLだけへの縮退をやめてtargetを渡す必要がある。`mpp-dynamic.ts:734-765,889-904,1082-1087` のprobe、pay前再probe、finalを同じ保存body文字列から作る。署名はfinal前に発生する。
- Solana: `mpp-solana.ts:461-506,620-678,771-772` のurlOfがmethod/bodyを保持し、baseInit/prepare/preparePaymentのrequest、setCredential、final transportまで同じ保存POST bytes＋application/jsonを渡す。credential生成で本文を再serializeせず、headers追加で本文を落とさない。
- 両方ともscopeの `GET URL` 固定値を選択methodへ変えるだけでは不十分。POSTでは保存URL/method/bodyから期待束縛値を計算し、challenge/承認offerと照合し、署名前にも一致を要求する。scope無しを通す従来GET挙動をPOSTの本文保証に転用しない。
- `net/guarded-fetch.ts:139-163` の1 fetch 1 dispatch（421再送拒否）、SSRF/DNS/redirect禁止、期限、response上限は再利用候補。新transportは不要という見込みだが、3要求のbytes一致は未試験。

## 最小の束縛契約案（未採用）

1. Routerではgenericな保存method・URL・既存bodySha256だけを使う案を優先する。形式例は `bindingHash=SHA256(stableJson({domain:"mpp.http.binding.v1",method,url,bodySha256}))`。Compass schema/bundle/contextをRouterに持ち込まず、Providerが自身のbundle/context/固定URLとcanonical本文を照合する。URLからbindingHashへの一方向とし循環を作らない。ownerの追加許可はRouter最小変更の調査であり、この形式の採用・実装・既存要件置換の承認ではない。
2. externalIdは汎用候補 `mpp.http.v1:`＋小文字hex64の全文。新候補のbyte数は未測定で記載しない（旧Compass候補の実測79 bytesと区別）。固定recipient/asset/amountは署名message内と完全一致させる。networkは明示的なchain ID署名欄ではなく、ProviderのbundleとRouterの承認profile・RPC・blockhash検査を併用する。本文はon-chainへ載せず、hashも秘匿化とは見なさない。
3. Routerは保存した承認対象のmethod/URL/bodySha256から期待externalIdを計算し、challenge・offer terms・message Memoを一致させるPOST専用検査を調査する。Compass固有task/bundleの意味検査はProviderに置き、人間の承認には既存のURL/method・本文digest・rail/network/asset/固定額/recipient/fee上限の手順を維持する。
4. Providerはcanonical対象の本文bytes/digest・bundle/context/固定URL・methodを検査し、期待値を認証済みchallengeと**署名検証済みmessageのMemo全文**へ束縛する。順序候補はHMAC/期限/条件と純粋tx検証（decode・ed25519・送金・Memo・再送検査）→永続CAS→推論→SDK固定charge→receipt保存。pay-kit成功後の照合では既に共同署名・送出済みで遅い。別taskの有効HMACも通りうるため、未署名externalId・外側challenge・到着順だけを信用しない。この全順序の成立は未実証。
5. 同task/body・bundleでも別nonce/blockhash/署名を新規購入として許さない。現設計のcontext.claimedPaymentKeyを保持し、別paymentは拒否する。一文脈一購入・失敗/unknown後もclaim保持は継続し、saltや再購入APIを導入しない。
6. paymentKeyはrail別に認証済み支払いを一意にする（Solanaではpayer公開鍵＋署名対象message/そのhashとpayer署名の対応、Tempoではnetwork＋送出tx hash等を固定）。`(payment,body)`だけの複合キーは禁止。同messageを別challenge IDで包み直しても新しい購入にしない。
7. challenge ID/expires再発行は購入identityではない。再probeの条件が同じ場合だけ継続し、本文/bundle/recipient/額の変化は再承認。Solana termsは既存どおりid/expiresとrecentBlockhash hintを除くがexternalIdを保持する。challenge期限とblockhash鮮度は署名前・送出前に検査し、期限切れ後の再署名でunknownを回避しない。
8. 永続予約は認証済み支払い・context・slot・総予算を原子CAS。推論開始、settle試行前、unknown、結果、receiptと元challenge/payment対応を保存し、再起動でも副作用を繰り返さない。保存不能/不整合で停止。同一証明・同一文脈の再取得は保存receipt/resultを返し、SDKへ再決済を依頼しない。保存済み結果の期限後再取得と新規の期限切れ支払いは区別する。
9. source legとdestination legのidentity/unknown/finalityを別々に維持する。SDK memory replay storeはCompassの永続CASではない。署名・送出後timeout/402を未払いへ丸めず、盲目的な再署名/再送なし。推論前verifyとsettle後のreceipt確認・保存再読取は別gate。
10. Routerで確認済みの `reserveMessage` はmessage hash単位であり、blockhashを変えた再署名は防げない。既存購入identity/unknown保持は再利用候補だが、同文脈を新購入として開き直さない保証は追加照合・永続化の設計と証明が必要で**blocker**。Providerのcontext.claimedPaymentKey/unknown保持は既存設計の要求で、MPP paymentKey・原子CASへの結合は未実証。両者を別々に検証し、汎用の巨大台帳新設で解決しない。

## Tempoの確認結果

- `node_modules/mppx/dist/Challenge.js:78-102,512-545`: IDはHMAC-SHA256の32 bytes（256 bit、base64url）。対象はrealm/method/intent、serialized request、expires、digest、credential header、opaque/meta。これはserverの認証でありpayerの本文署名ではない。
- 同 `tempo/Attribution.js:1-148`: memo計32 bytes＝tag 4、version 1、server hash 10（80 bit）、client hash 10（80 bit）、challenge hash 7（56 bit）。challengeはkeccak256の先頭7 bytesだけを検査する。**7 byteを256 bit本文署名とは呼ばない。** 同realm/clientで選べる有効challenge同士の汎用collision目安は2^28、特定challengeへの一致探索は2^56。発行制限は攻撃量を抑えてもbit長を増やさない。
- このcollision評価はserverが有効なHMAC付きchallengeを発行する前提であり、攻撃者が任意のHMAC値を自由に選べるという意味ではない。
- `tempo/client/Charge.js:101-119,193-226` はattributionを生成してmethodDetails.memoへ上書きし、push送金後hash credentialを返す。Router `mpp-dynamic.ts:157-241` はrequest.externalId/extra、methodDetails.memo等を拒否。allowlistだけ緩めても任意256-bit digestが署名される保証にはならない。
- opaque/metaは候補として通りtermsに入る。そこにbodyHash/URL/methodを載せHMACと結べても、payer署名へ渡る部分は依然56 bit。digest単独はtermsに入らず、受信本文との自動照合も仮定できない。`server/Mppx.js:678-749` のHMAC/現在条件/期限検査と `tempo/server/Charge.js:912-933` のrealm/challenge memo検査だけでは十分でない。
- Provider拒否・推論失敗・通信断の前に送金済みになりうる。verify-before-Provider-settleで資金移動を止めるpull契約は流用できない。push先払い損失の上限・回復・開示には別の製品判断が必要。32 receiver削減だけを理由に採用しない。

## Solanaの確認結果と正式APIの境界

- `mpp-solana.ts:134-161,185-205,687-755` はexternalIdをofferに保持し、期待Memoとしてmessageを構築・検査、message hash予約、署名、signature検証、wire再照合を行う。共用 `x402-svm.ts:67-75` はUTF-8 **1〜256 bytes**・制御文字禁止。SDKの566 bytes上限より厳しい。
- 同共用実装 `:219-224,334-369` はmessage bytesを保存snapshotと完全一致させ、fee payer署名欄が空、payer署名一致、送金/Memoを再検査する。本文/URL/methodを自動で署名する機能ではなく、上記externalId計算・照合の追加が必要。
- `outbound/x402-svm.ts:342-369` → `inbound/x402-svm.ts:119-207` には自作MITの純粋なdecode・2署名欄（fee payerは空）・送金/Memo・再構築bytes一致・ed25519検証があり、reuse候補は存在する。ただし汎用Provider verifier完成の証拠ではない。snapshot/policyを未認証提出値だけから作って自己一致させず、信頼する設定・認証済み条件・独立に確定した本文期待値へ照合し、HMAC/期限/再送/canonical対象も別途検査する。`inbound/mpp-solana.ts:1-10` は署名1つ・payer=feePayer形式で、2署名形式にそのまま流用できない。追加candidateは未設計・未実証、SDK internalsのコピー/vendorは解決策にしない。
- installed `@solana/pay-kit/dist/index.js:930-985` はexternalId全文をTextEncoderで符号化し、Memo instruction bytesと完全一致させる（切詰めなし、566 bytes超過拒否）。chain読戻しもMemo文字列一致。旧79 bytes候補の上限内確認は新候補の実測ではなく、新候補の長さ・transaction全体上限・実wire受理は別確認。
- 既存Provider `providers/mpp-solana-workers/src/index.ts:52-101` はGETのみ、withoutAuthorizationでbodyを保存せず、データ取得を支払い検証前に実行する。`src/paykit.ts:38-56` はGateとpay.fetchのみ。Compassでこの順序を流用するとFR-C17違反になる。
- pay-kit公開 `dist/index.d.ts:264-290,869-880,929-959` はProtocolAdapter.verifyAndSettle、PayKit.requirePayment/fetch。固定gateはrequirePayment成功時点で決済済み。PaymentGranted.settle/withSettlementの遅延決済はusage用で、固定chargeの分離口ではない。
- 実装 `dist/index.js:759-810,8140-8240` はverifyChargeTransaction→共同署名→replay確認/simulate→broadcast→confirmation→chain検証→receiptを一体実行する。名前がverifyでも副作用がある。verifyChargeTransaction等は公開exportsの正式分離APIと確認できず、内部import/コピーによる解決は提案しない。
- `dist/index.js:320-413` のcharge serverとroot mppx `server/Mppx.js:1300-1376` を読む限り、HMACが外側externalIdを保護しても、現在task由来externalIdへの自動pin照合を頼れない（既定pinned項目にはexternalIdなし）。Provider自身の再計算と認証済みmessage照合を省けない。
- pay-kit 0.13.1の公開 `Gate` / `PayKit` / `ProtocolAdapter` を確認した範囲では、要求本文由来externalIdを発行する正式APIは未確認。`dist/index.d.ts:159-202` のGateは構築時固定・不変、`index.js:8163-8168` はgate.externalIdを使用。`:8080-8099,8135-8159` はexternalIdを含むkeyでhandler/Mppx instanceをcacheし、確認範囲に上限・破棄処理はない。request別Gate案には未払いの外部入力で増えるcacheの個数/寿命/受付制限が必要で、正式APIと上限制御の供給元確認まで**blocker**。全版・全公開機能に不存在とは断定しない。

## 差分候補と未確認事項の閉じ方（全て計画のみ）

| 項目 | 再利用／追加・変更候補 | 次の具体的確認1件 |
|---|---|---|
| POST運搬 | Solana選択なら主に `src/adapters/outbound/mpp-solana.ts`。Tempo選択なら `mpp.ts`＋`mpp-dynamic.ts`。core/body保存・guarded transportは再利用 | 署名しないtransport spyでprobe/再probe/finalの保存bytes・method・content-type一致をassert |
| 束縛・純粋validator | Routerはgeneric method/URL/bodySha256、ProviderはCompass照合とMIT検証部品のreuse候補→CAS→推論→SDK | 改変task/bundle/URL/methodを先着させ、HMAC/期限/署名/送金/Memo拒否時にCAS/推論/SDK呼出0となるfixtureを設計 |
| 分離API（blocker） | 固定charge分離口は未確認。純粋Provider validator後にSDKを呼ぶ別候補も未設計・未実証 | 公開 `PayKit` / `ProtocolAdapter` の正式口を供給元確認し、別候補の検査網羅性・副作用順序も独立review |
| 要求別発行（blocker） | Gate固定externalId、外部入力で増えるhandler/Mppx cache | request別externalIdの正式発行口とcache個数/寿命/受付上限を供給元確認 |
| 再発行・期限 | 既存terms比較/期限検査を再利用、保存receiptの元challenge対応を追加 | challenge ID/期限/blockhash hintだけの変化とexternalId変化を分けたfixtureで許可/拒否を検証 |
| 永続性・再購入（blocker） | Routerのmessage予約とProviderの既存context claim設計を区別し、文脈単位の保証を追加検討 | 同文脈別blockhash/新購入、同message別challenge、並行CAS、crash後unknown保持をRouter/Providerそれぞれで証明 |
| 実wire/API・network | Memo全文・単一recipient・固定額・別fee payer、既存profileはdevnetのみ | 採用候補のbyte数とSDK実wire/共同署名前後message不変を許可後検証。未実証はblocker、本番profile変更は別scope |
| 回帰範囲 | `tests/wire/mpp-solana-outbound.test.ts`、`mpp-dynamic-outbound.test.ts`、`tests/unit/dynamic-post.test.ts` を候補とし、Compass側に束縛/永続試験追加 | 従来GET・POST拒否が残る他rail・SSRF/421・offer変更・署名1回・receipt/unknownの回帰を承認後実行 |
| Tempo強度/先払い | 既存memoのまま強度改善なし。独自SDK/汎用frameworkへ拡張しない | Attribution.encode/verifyChallengeBindingの切詰めベクトルをoffline確認し、必要強度と先払い損失をowner判断へ戻す |
| license/版 | 下記installed資料のみ。追加依存なしと断定しない | pay-kit 0.13.1の配布物に対応するlicenseを供給元資料で確認（別途ネットワーク承認後） |

最初の小さなoffline proofは、固定JSONベクトル→保存bytes/bodySha256/URL/method→汎用externalId→未署名Solana message→Memo再読取の一致と改変拒否、Providerのbundle/context/固定URL照合を分けて計画する。鍵生成・署名・SDK server起動・RPCなし（pay-kit未払いchallenge自体もRPCを呼びうるため）。純粋束縛の証拠に限定し、分離API・要求別発行・再購入防止・実購入の証拠にしない。
実装段でもroot config/依存変更はこの調査から許可されない。まず選択railの限定設計・独立reviewを要する。後続API試験に必要なら、固定SDK版/license、専用test payer、fee payer、単一recipient/ATA、MPP challenge secret、RPC/network、額/回数/期限を別操作票へ記録する。既存鍵/財布は探索せず、取得・実署名・送出・クラウドは別承認。

## 来歴・読取の限界

- Router/既存Provider: 上記base commit、root `LICENSE` はMIT。既存Providerは参照のみでCompassへコピーしていない。前調査の行位置も必要箇所を実sourceで追跡した。
- `mppx` installed 0.11.0: `node_modules/mppx/package.json`（wevm/mppx）と `LICENSE`（MIT）。Tempo client/server、Challenge、Attributionを限定読取。前調査のroot lock entryとも同版。ネットワークで完全性を再検証していない。
- `@solana/pay-kit` installed 0.13.1: package.jsonのoriginはsolana-foundation/pay-kit、`typescript/packages/pay-kit`。公開exportsはroot/client。dist内の `../mpp/dist/server/Charge.js` 表示はbundle内部の出所表示であり、別installed @solana/mpp版を確定する証拠にしない。metadataにlicense記載なし、前調査でもLICENSE未確認につき**license不明を維持**。
- pay-kitのmppx依存指定 `>=0.8.15`、前調査記録のroot override 0.13.2指定とroot installed 0.11.0を混同しない。Provider実行時に解決する版の確定は未実施であり、次段の実API検証前に実際のmodule解決先/package metadataを確認するblocker。
- 公式 `@zerc20/sdk` / BUSL sourceは読取・コピーしていない。今回 `.claude_workflow/local/mpp-scope-review.stdout` のresultを読み、追加確認は上記Gate/cacheとMIT検証部品の該当sourceに限定した。本書は候補評価で、修正後の独立reviewとcontroller確認は完了。owner採用判断、実署名、各leg決済、配信/受領、保存再読取、finalityは未完了。
