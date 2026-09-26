# 決定: Router に CORS を足さない（2026-09-26）

## 結論

**足さない。** ハッカソン提出時点では、ブラウザから Router を直接読ませない。

## 背景

サイト（`subethalabs.com/router/`）の route 一覧に「MPP は署名＝送金」と
**静的な文面**で書いている。これを Router のライブ値
（`subject.fundsMoveOnCredential`）から出せれば、文面と実態がずれない。

## 実測（2026-09-26）

```
OPTIONS https://router.subethalabs.com/mcp  → 405（allow: GET, POST, DELETE）
POST    （origin ヘッダ付き）               → 200、ただし access-control-* なし
```

`src/**` にも `tools/remote-mcp.ts` にも CORS の実装は**無い**。
実ブラウザからは `Failed to fetch` で塞がれる（peer セッションが本番ページで確認）。

## なぜ足さないか

1. **必要性が低い。** 文面対応で正しく伝わっている。ライブ化は「ずれ得る」問題の予防であって、
   いまずれているわけではない
2. **支払い口を持つサービスのブラウザ露出**を増やす判断は、
   ハッカソン締切前にやる変更としては重い
3. **ハッカソンの主張に効かない。** 審査員の体験は MCP クライアント経由であり、
   ブラウザから Router を叩く導線は想定していない

## もし将来やるなら

**未課金の読み取りに限って**許可する。`tools/list` と `list_routes`、`quote` は無料なので
ここだけを対象にし、`x-payment` を伴うリクエストには **`access-control-*` を一切付けない**
（ブラウザから支払いを試みる経路を開かない）。

Provider 側（provider-x402 / provider-mpp）は同じ考え方で実装済みで、
`authorization` / `payment-signature` が無いリクエストにだけ許可を返している。
実装する場合はその形を踏襲する。

**再検討の契機**: ブラウザ UI から Router の状態を見せたくなったとき。
