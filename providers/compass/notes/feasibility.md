# K01: 既存railの短いsource比較

作成日: 2026-10-15。author: Codex。Claude独立reviewのNEEDS_FIX（必須1件・任意2件）を修正し、独立再reviewは **LGTM（文書のみ）**。controllerが実sourceと差分をread-back。記録は [feasibility-review.md](feasibility-review.md)。
base commit: `10dd7956d1f9944075edce3d24fba361208a8d5a`。
対象: `compass-gcp-prototype` / `task/compass-gcp-prototype`。開始時の未追跡 `docs/compass/` は入力として読み、変更していない。
本書だけを作成・レビュー修正。source読取のみで、試験・ネットワーク・署名・購入・クラウド操作・git書込は実施していない。
**どの候補もCompassの実settlement・実モデル・実E2Eは未実行。** 過去のfixtureや文書上の仕様を今回の実行証拠としない。

## 結論

今回の限定source比較では、32 receiver案より小さい代替の成立を確認できていない。代替が存在しないとの網羅的結論ではない。reviewer提案の単一recipient・文脈ごとの一意amount永久割当は未確認候補として比較に追加するが、実証済み案でも採用案でもない。
x402/EVMだけが対象実装の動的POSTに対応する。一方、そのpayer署名には本文・HTTP method・URLが入らない。
MPP Tempoのchallenge帰属memo、MPP SolanaのexternalId→Memoは調査候補だが、どちらも現在のRouterはGET限定。名称がMPPでも署名・送出・検証方式は異なる。
したがって32 receiver／一文脈一購入を直ちに実装するとの結論でもない。G1でownerが現案の制約を採用するか、要件・設計へ戻すか判断する。
本比較では未確認を残して終了し、salt、prepare API、任意memo、別facilitator等の推測による回避策を製品仕様にしない。

## 比較（根拠番号は後段）

ここでpayerはRouterのdestination支払い署名者。利用者→Routerのsource legとは別である。

| 候補・経路 | 実Router POST対応 | payerが実際に署名する対象 | HTTP body/method/URL束縛 | challenge nonce/replay | Provider側が安全に照合できるもの | 同taskの再購入 | receiver/proof運用 | 実対応profile制限 |
|---|---|---|---|---|---|---|---|---|
| x402/EVM動的（現Arc案） | 対応。未払いprobe・pay前再probe・有料要求で同じPOST本文 [X1] | EIP-712 token domainとEIP-3009のfrom/to/value/validAfter/validBefore/nonce [X2] | Routerはresource URL完全一致とoffer再一致を検査。本文は保存文字列を送るが、3項目とも送金署名にはない [X1,X2] | nonceは署名対象、SDK提供値の形と期限を検査。文脈nonceではない。chain消費済み判定の実API挙動は未確認。Provider永続重複防止は別途必要 [X2] | accepted一致＋facilitator verifyによる支払い検査。本文との結び付けは別途必要。現案は署名toと不変receiver→context台帳を照合 [P1,D] | railの署名項目はtask単位の禁止を持たないが、現設計は別nonce・後日でも同body/bundleを拒否 [D] | Circle seller proofは別の売り手署名。proofのpayTo=signer.addressのため、Compass側に各receiver addressのseller署名鍵（署名手段）が必要。32 receiver登録・各proof適合は未確認 [P2,D] | v2/exact、EIP-155、固定asset/domain/額上限。permit2不可、独自extra digest不可。Arc採用案と一般EVMパーサ能力を区別 [X3] |
| x402/EVM・単一recipient＋一意amount（reviewer提案、未確認） | 同じ動的POST経路を使う候補 [X1] | X2のvalue=offer.amountを文脈識別に使う | 本文自体は署名されない。認証済みtuple(network,asset,payTo,value)と不変context台帳の照合を想定するが未実証 | nonceは支払い識別用。amountの永久非再利用と永続replay/CASは別途必要 | Compassがcontext割当額との完全一致を強制し、facilitatorがそのvalueの署名を検証する前提。実APIのamount判定は未確認 [X2,X3,A] | 一意amountだけでは再購入禁止を実現しない。現一文脈一購入claimとの整合・再購入制限は未確認 [D,A] | 単一recipientのseller署名鍵・登録/proofが必要。複数鍵を減らせる可能性は未実証 [P2] | 額上限内でも価格固定・bundle・UIでの人間承認との整合は未確認。現承認内の採用案ではない [A] |
| MPP Tempo動的 | 非対応。入口でPOST拒否、実送出もGET [M1] | Tempo取引のchain/call（token・recipient・amount・memo）、feeToken・手数料・nonce/nonceKey・validBefore等。SDKはchallenge由来memoを付けpush送金 [M2,S1] | scopeは存在すればGET URL一致、無ければ不問。署名はHTTP要求そのものではなく、memo→challengeへの間接束縛。body照合の成立は未確認 [M1,S1,S2] | challenge IDはHMAC、memo内challenge hashは7 bytes。SDKにtx hash重複claimあり、既定memory store。永続at-most-onceの代用不可 [S2] | SDKはHMAC、現在条件、transferとrealm/challenge帰属memoを検査。Compassの受信本文→challenge対応検査は未実装 [S2] | 別取引を同taskへ結ぶ設計は未確認。現x402のcontext claimをそのまま移せば禁止も残る。再購入可能と断定しない | 読んだ経路にCircle seller proofなし。単一recipientを使う方式だがRPC・challenge secret・永続台帳が必要。送金はProvider要求より先なので失敗時の有料化を再設計 [M2,S2] | tempo/charge、push、real-key/local account、chain対応のplain HTTP RPC、feeAsset/maxFee必須。externalId・任意memo・splitsは動的challengeで拒否 [M1,M2] |
| MPP Tempo静的 | GETのみ [M3] | SDKのTempo charge署名。静的wrapperは期限を検査するが、動的の取引再構築guardと同一ではない [M3] | GET URL scope必須。body付き経路なし [M3] | SDKのchallenge/取引検証を使う。Compassの永続replay運用は未確認 | scopeとoffer条件をRouterが照合。Provider独自body束縛の証拠にはならない | 可変POST taskの候補外 | Circle proofとの互換性を仮定しない | 設定済みURL向け。静的能力・modeを動的push限定と同一視しない [M3] |
| MPP Solana静的／動的 | 両方GET。動的POSTは拒否 [L1] | Routerが構築・検査したSolana message全体。SPL送金、blockhash、fee payer等、externalIdがあればMemoを含む。payer署名後、fee payer署名欄は空で渡すpull [L2] | externalIdは署名Memoへ入るが、URL/body/methodは自動で入らない。scopeはあればGET URL照合。context digestをexternalIdと対応させる案は未設計 [L1,L2] | challenge ID自体をpayerが署名するとの証拠なし。Routerは署名前message hash予約・期限・blockhash鮮度を検査。Providerの永続replayは不明 [L2,P3] | receiver ATA・mint・amount・Memoを検査する材料はある。既存handlerはpay-kitに検証/共同署名/送出を委譲。externalIdと本文の安全な照合APIは未確認 [P3] | 別blockhash/署名を同taskへ許す運用は未確認。Memo付きだけで再購入の安全性を主張しない | Circle proofなし。recipient/ATAに加え別fee payer鍵・SOL費用・MPP secretが必要。既存handlerは推論前verifyの実装ではない [P3] | solana/charge、pullのみ、feePayer=trueと別公開鍵必須、固定mint/decimals/token program。読んだnetwork label対応はdevnetのみ [L1] |

x402/SVMもEVMとは別経路で、動的POSTは拒否される（`src/adapters/outbound/x402-svm.ts:554,581,694`）。EVMのPOST対応をSolanaへ一般化しない。
静的x402の可変POST対応は本比較では独立確認していない。現要件の入力経路は動的POSTであり、静的へ迂回する案は採用しない。

## 混同してはならない四つの境界

| 境界 | 確認できたこと／できないこと |
|---|---|
| Router intent/bodyHash | `src/core/intent.ts:104-110,153-156`は保存型、`:172-184`はstableJson。`:186-188`のfingerprintOfはoffer等のcanonical JSONの指紋（sha256:接頭辞付き）で、本文bodySha256の計算箇所ではない。本文は`src/core/dynamic.ts:53-71,353-364`で正規化文字列のUTF-8 SHA256（hex）を計算して保存欄へ渡す。型だけでは実行時検証を証明しない。X1の送出実装とTのassertionを併せても、Providerにpayer署名済み本文hashが届くことにはならない |
| payer送金署名 | X2はtoken domainと送金欄。M2はTempo取引。L2はSolana message。HTTP封筒やaccepted全体が署名されるとの読み替えは禁止 |
| seller proof | P2のbodyHashは**facilitatorへ送る支払い検証/決済JSON文字列のkeccak256**。Compass taskのcanonical SHA256ではない。売り手署名でありpayerによるtask同意の代わりにならない |
| Provider照合 | 入力からcontextを再計算し、認証済み支払いと不変対応を照合してから原子予約する必要がある。単なるURL hash、未署名accepted、最初の到着本文を台帳へ記録するだけでは改変先取りを防げない |

## source根拠

パスはworktree root基準。行範囲は読取時点。依存コードは位置と要約だけを記載し、転載していない。

- D: `docs/compass/tasks.md:25,44,68`（G1/K01/S1）、`requirements.md:59-67,82,92-94,104-115`（同ディレクトリ、要件全文を参照）、`design.md:50-65,105-123`。receiverを永久専用化し、context claimを別に一回取得する**未実装設計**。
- A: `docs/compass/requirements.md:82,85-86,93,100`は人間承認・購入条件照合・提示条件一致・額制約、`design.md:62-63,107-123`はfee条件を含む固定bundleと提案価格・不変offer・receiver割当・一文脈一購入。下流catalogの固定価格条件（`design.md:91-103`）とCompass自身の提案価格は区別する。文脈ごとの可変額がこれらと整合する証拠はない。
- X1: `src/adapters/outbound/x402-dynamic.ts:526-543,562-575,618-628,654-682`。実POST組立、URL一致、offer再probe、支払い要求一回。
- X2: 同 `:190-207,349-445`。署名欄の完全一致とRouterによる再構築。nonce/期限以外のSDK入力を無条件に署名しない。
- X3: 同 `:252-314,501-508`。asset/domain/network/金額とextra許可集合。`assetTransferMethod=eip3009`だけ例外許可。
- M1: `src/adapters/outbound/mpp.ts:424-470`、`mpp-dynamic.ts:157-241,734-765`（同ディレクトリ）。POST拒否、GET、動的scope任意、challenge欄の制限。
- M2: `src/adapters/outbound/mpp-dynamic.ts:254-310,396-477,612-647,704-713,1043-1087`。取引guardとpush能力・profile制限。guardはmemoの独自context値を強制していない。
- M3: `src/adapters/outbound/mpp.ts:65-85,136-150,416-454,511-557`。静的は期限wrapper、scope/条件の照合。動的のguardより広いSDK委譲を同一保証にしない。
- L1: `src/adapters/outbound/mpp-solana.ts:134-161,400-420,461-484,771-772`、`src/adapters/inbound/mpp-solana.ts:43`。GET、pull条件、devnet labelとprofile照合。
- L2: `src/adapters/outbound/mpp-solana.ts:682-741,753-755`。externalIdを期待Memoにし、構築済みmessageの検査・予約・署名・wire再検査。外側challenge IDの一致検査と署名対象は別。
- P1: `providers/x402-workers/src/index.ts:131-187`。acceptedのmatch、verify、settle、receipt確認。データ取得はverifyより前で、Compassの高価な推論へ順序をそのまま流用できない。
- P2: 同package `src/seller-proof.ts:13-23,44-45,69-84`、`src/facilitator-client.ts:128-141`。seller署名の対象と送出JSON。`seller-proof.ts:81,83-84`はproofのpayToをsigner.addressにしてそのsignerで署名するため、現receiver案では各receiverに対応するseller署名鍵・署名手段がCompass側の運用前提（モデルや下流購入の署名権限とは別）。Circle側登録API・多receiver適合・実際の拒否条件はローカルclientだけでは確定不能。
- P3: `providers/mpp-solana-workers/src/index.ts:60-101`、`src/paykit.ts:38-56`（同package）。GET固定、データ先行、devnet pay-kit wrapper。pay-kit内部のverify分離API、Memo照合、永続replayは本比較では未読・不明。
- S1: `node_modules/mppx/dist/tempo/client/Charge.js:101-119,193-226`。challenge/realmからmemoを作り、push取引後hash credentialを返す。`tempo/Attribution.js:130-148`はchallenge hashの先頭7 bytes照合。
- S2: 同 `dist/Challenge.js:78-102,512-545`（HMAC対象）、`dist/server/Mppx.js:678-749`（発行者・現在条件・期限検査）、`dist/tempo/server/Charge.js:35-39,368-377,912-933`（memory既定、hash claim、realm/challenge memo照合）。HMACが正しくても受信本文との一致は別検査。SDKのreplay保存をCompass永続台帳と同一視しない。
- T: `tests/unit/dynamic-post.test.ts:7-58`はcanonical body/hash・binding・保存形のassertion。`tests/wire/x402-dynamic-outbound.test.ts:424-434`は3回のPOST bytes一致と署名回数をassert。`tests/wire/mpp-dynamic-outbound.test.ts:260-273`はPOST拒否と送信/署名ゼロをassert。**今回未実行**で、実装根拠はX1/M1。wire試験のfixtureを実chain settlementと数えない。

## 固定版とlicenseの出所

root `package.json`の宣言、下記lock entry、installed package metadataを読み合わせた。ネットワークで来歴・完全性を再検証していない。

| 読んだ依存・資料 | exact版 | license出所・読取の限界 |
|---|---|---|
| Router／既存Provider source | base commit上記、各package 0.1.0 | root `LICENSE:1-8`はMIT、rootと両Providerの`package.json`もMIT。PoCコードのコピー・再利用はしていない |
| mppx（署名/検証実装を限定読取） | 0.11.0 | `node_modules/mppx/package.json:4,6`、`LICENSE:1-8`はMIT。root `package-lock.json:9382` entryにregistry tarball/integrity/版/license |
| @x402/core・evm・fetch（metadataのみ、内部署名検証未読） | 各2.28.0 | 各installed `package.json`はApache-2.0、root lock `:5094,5103,5114`も一致。署名範囲の根拠はRouterのX2 |
| viem／root ox（metadataのみ） | 2.54.0／0.14.29 | installed `package.json:4,240`／`:4,34`はMIT、root lock `:10178,9598`。mppx自身のox依存指定は0.14.33（lock `:9382`配下）でroot oxと混同しない。serializer内部は未読 |
| @solana/pay-kit（metadataと既存wrapperのみ） | 0.13.1 | installed `package.json:3`、root lock `:1422`。両metadataにlicense表記を確認できず、installed LICENSEも見つからないため**license不明**。Provider自身のMITを転用しない。rootのmppx override 0.13.2指定はmppx 0.11.0の検証根拠と分離 |

公式`@zerc20/sdk`／BUSL sourceは読取・コピー・vendor・再配布していない。追加依存の取得もしていない。

## reviewer提案の一意amount候補に残る未確認事項

X3の `x402-dynamic.ts:270-272` は正の整数amountとprofile上限を検査し、`:273-282`はpayToの形式・禁止先を検査する（受取先の許可リストではない）。X2の`:367,411,444`はoffer.amountをvalueとして検査・再構築して署名する。この静的根拠から、単一recipientでcontextごとに一意amountを永久割当し、署名済みvalueとそのcontextの割当額を照合する候補を記録する。改変本文の先取りを拒否できるという見込みは、以下の前提がすべて成立する場合に限る。reviewerの具体的amount例は実料金・採用値として用いず、本書で額や範囲を決定しない。

- **facilitator実API**: amount完全一致のverify挙動（過払い等を許容するかを含む）、認証済みauthorization.valueと提示額の対応、settleまで同じ条件が保たれるかは未確認。Compass自身も署名検証されたvalueと割当額の完全一致を強制する必要がある。未署名acceptedの一致だけでは代用できない。
- **価格・bundle・承認UI**: Aの価格固定・提示条件と、contextごとに額が違うこととの整合は未確認。fee条件を含むbundleHashからcontextHashを作るため、額の割当規則とbundleの関係も未設計。quoteごとの正確な額・network・asset・payToと文脈をUIに示し、人間が承認する手順の適合も未確認。固定価格要件と矛盾するなら条件変更のowner承認と要件・設計の再reviewが必要であり、**現承認内の案ではない**。Routerの額上限検査を通りうることは製品条件変更の許可ではない。
- **永久割当と有限性**: tuple(network,asset,payTo,value)→contextの一意で不変な対応を全期間・再起動・デプロイ・catalog/bundle/設定の版を跨いで保持し、一度割り当てたtupleを別contextに再利用しない保証は未実装・未確認。並行割当の原子性、台帳喪失/不整合時の停止、許容価格範囲内のamount空間の枯渇、未払いprobeによる割当消費とDoS・上限・停止条件も未設計。期間や版を変えて割当をリセットしてよいとはしない。
- **再購入・運用**: 一意amountは支払いnonceやcontext claimの代わりにならない。同じtask/body・bundleの再購入制限、失敗/unknown後のclaim保持、同一証明の結果再取得、verify-before-settle・at-most-onceとの整合は未確認。単一receiverの登録/proof適合も未実証であり、鍵管理削減の可能性だけで採用・実装・G1通過としない。

## G1と後続に残す判断

1. 現x402案を維持するなら、32 receiverの永久割当・未払いpool枯渇・一文脈一購入・有限予算をownerが判断する。G1採用決定は本書で行わない。
2. MPPへ戻すなら、FR-C1/C9のPOSTまたはroot変更禁止との不整合を先に解消する設計変更と独立reviewが必要。Tempoはpush決済先行による損失/回復設計も変更対象。Solanaはfee payer共同署名と検証/settle分離APIが未確認。GET化やprepare APIを無断追加しない。
3. K09b/G5: x402のreceiver登録・seller signer一致・proof API実適合、または代替railの具体的profile・RPC・登録要否・鍵役割を限定操作票で固定する。秘密値や既存財布を探索せず、必要鍵・署名範囲・額/回数/期間は実操作前の承認に残す。
4. 新しいAPI/SDK取得・license不明の解消はG0a等の別範囲。Providerの本文照合、同支払いの改変先取り、再購入、永続replay/CAS、unknown保持を設計・試験で確認するまで成立とはしない。
5. Claude独立再reviewとcontroller確認は完了。ownerのG1判断、実署名、source/destination各settlement、実モデル、配信/受領、保存再読取/finalityは未完了。本source比較で代用しない。
