Cake の最新 `main` でも、前回の監査で指摘されたバージョンが使われていました。次の計画で更新します。

## 目的・背景

Next.js、sharp、Zod の脆弱性に対応します。あわせて、PostCSS 経由で検出された `nanoid` と `source-map-js` を修正版に更新します。

## 対象範囲・対象外

| 依存関係 | 現在 → 更新候補 |
|---|---|
| `next`、`eslint-config-next` | `16.2.12` → `16.4.6` |
| `sharp` の `overrides` | `0.35.3` → `0.35.5` |
| `zod` | `4.4.3` → `4.6.7` |
| `postcss` の `overrides` | `8.5.25` → `8.5.33` |

最新 `main` を起点に、`package.json` と `package-lock.json` を更新します。React、ESLint・TypeScript のメジャー更新、Node.js・型定義の更新、アプリ仕様・DB スキーマの変更は対象外です。

## 受入条件

- [ ] AC-01: 指定バージョンで `npm ci` が成功し、`npm audit --omit=dev` で今回の対象が検出されない。開発依存も監査し、残る指摘があれば記録する。
- [ ] AC-02: 最終コミットで lint、型チェック、文書参照チェック、自動テスト、ビルドが通る。Cloud のブラウザ QA で PC・モバイルのログイン、画面移動、取引の追加・編集・削除が通る。
- [ ] AC-03: 別エージェントのレビュー、PR の CI、自動 Preview の正式 QA を完了し、条件が揃ったら PR を Ready にする。

## 関連記録

依存関係の更新を **1 Issue・1 Intent・1 PR** で進めます。機能やデータ設計の変更を伴わないため、設計書の改訂は省きます。利用者のマージ後は、既存 Actions で main の CI、本番デプロイ、常設 Preview、PR 専用リソースの削除を確認します。[Cake の開発手順](https://github.com/tyask/Cake/blob/main/docs/aidlc-workflow.md)

## Cloud QA の追加計画

更新前は同じ QA が 4 ケースすべて成功しました。更新後は、Chromium が同一オリジンの GET の再開に `Invalid InterceptionId` を返し、QA が失敗します。途中まで実行したケースでは取引の削除と後片付けを確認できました。

追加計画は、Cloud QA が中断済みの同一オリジン要求に対するこのエラーだけを区別できるよう、検証スクリプトと回帰テストを更新することです。外部通信は遮断し、他の通信エラーは失敗として扱うことをテストします。同じ PR で、当初の監査・ビルド・Cloud QA・CI・正式 Preview QA を最終コミットに対して実行します。
