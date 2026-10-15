# MPP限定調査のレビュー記録

- owner許可: Router最小変更も含む、MPP動的POSTと本文・支払い束縛の限定調査のみ。実装・方式採用・要件置換・クラウド・実署名/送金は未承認。
- author: Codex。独立reviewer: Claude Code `claude-opus-5-5`。
- 初回: NEEDS_FIX、必須2・任意4。要求別externalId発行/handler cacheと、RouterへのCompass固有情報持込みを修正。Provider独立検証、network、文脈単位の再購入防止、56bitの脅威前提も整理。
- controller追加: 既存MIT純粋checkerを利用する別案を候補として確認。SDKにverify-only分離口が未確認であることを、Solana全体の不可能性と混同しない。1署名のMPP受信checkerと2署名形式を区別。
- 再review: **LGTM（必須0・任意3）**。result本文と `subtype=success` / `is_error=false` / `permission_denials=[]` を確認。
- controller: 文書全文、RouterのMemo/署名予約/wire照合、pay-kitの公開型と共同署名/送出順序・Memo照合、Tempoの切詰め処理をread-back。修正対象文書以外の既存承認資料hash不変、tracked product diffなし。再review後は状態表示のみ更新。
- 実行証拠: 本調査はsource/docレビュー。実装、署名、SDK server/RPC、実モデル、cloud/settlement試験は未実施。旧prefix長のcontroller計算は新候補の実wire成立を意味しない。

## 任意3件 — 次段への引継ぎ（未検証）

1. 既存2署名checkerはRouter builderの狭い形式（命令順・個数・lookup tableなし）向け。再利用候補はRouter経由に限定し、一般SDK payer互換とはしない。
2. 推論後にSDK決済する候補は、推論中のblockhash失効で計算費用を失う可能性がある。寿命・期限・費用上限を設計で確認。durable nonceへの拡張は別scope。
3. Router保存URLとProviderが見るURLの一致（proxy/host/query正規化）は未確認。束縛proofで一致と改変拒否を確認する。

生レビュー: gitignored `.claude_workflow/local/mpp-scope-review.stdout` / `mpp-scope-review-final.stdout`。本記録は文書レビューの証拠であり、正式API適合・実購入成立・ownerの方式採用承認ではない。
