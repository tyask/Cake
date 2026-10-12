# 固定QA導入設定の検証

2026-10-12。最新origin/main `1877f0ff88b5250225db5d590a06e3c1e656ecb9` から `npm run task:start -- fixed-qa-pool` で独立した `codex/fixed-qa-pool` とworktreeを作成。`.env.local` / `.vercel` / node_modulesはコピーしていない。npm ciは書込可能な `/tmp/cake-npm-cache` で完了。

- lint: 成功。
- test: **285件成功、失敗0、skip0**。別作業PR #33の288件とは異なるmainベースの独立実装であり、#33の変更を取り込んでいない。
- build: 成功。ローカルNextビルドでDB操作は実行しない。
- TypeScript `tsc --noEmit`: 成功。
- `git diff --check`: 成功。
- 回帰: 貸出上書き拒否、世代token照合、返却準備と同じPRの停止記録、壊れた記録拒否、QA endpoint未確認/不一致/本番接続同一endpoint拒否、直接setup/seed起動の接続前停止、秘密値がエラーへ出ないこと。
- 自動デプロイ設定: main/qa1/qa2/qa3だけtrue、スラッシュ付きcodex枝も対象にする`**` deny。規則の重複はtrue優先というVercel公式仕様を確認。実クラウドでの適用は未確認。
- QA Git枝qa1/2/3、管理枝qa-pool-stateは `git ls-remote` で不存在を確認。いずれも作成していない。
- PR #33のremote head `5776adfca96d17d166234c4a38d7c286bb47982a` は保持。元worktreeの変更を行っていない。
- GitHub Environments: 既存Preview/Production、protection_rulesなし。OPEN IssuesにQA管理台帳と分かるものは見つからなかった。変更なし。

## 未実施・ブロッカー

Vercel MCPのfumin1/cake読取は403（そのscopeへの認証権限なし）。同じteam/projectの既存CLI fallbackもユーザー読取404で失敗。Neonの既存API読取ツールは利用できない。認証や権限を変更せず停止した。外部ネットワーク拒否の迂回、資格情報作成、アクセス永続化は行っていない。

そのため実URL/aliasのグローバル衝突、既存本番URLへの影響、Neon Native設定・親枝・DB枝名/ID・endpoint、retention、静的待機deploymentによるDB保持、旧Function/SQL停止、通常PR停止の全枝への適用範囲は未確認。実DB migration/seed、cloud build、PC/モバイルのブラウザ/API操作も未実施。UI変更はない。

このPRは通常codex枝の自動Preview停止を含む導入準備で、従来deploy:previewはそのまま併用しない。専用テストDBとcloud読取が確認できないため、Previewを生成せず、ユーザーの許可範囲でdraft PRを作成する。成功したPreview URLや生成済みDB名を報告しない。

ユーザーの再検討指示に従い、貸出台帳の保存方式は未確定。管理ブランチ、Issue、DB、Environmentを作成/変更せず、保存先に依存しない状態モデルだけを追加した。比較と移行/返却手順は [qa-pool.md](qa-pool.md)。排他保存の実装がないので貸出・配置はまだ開始できない。

既存認証のfumin1/cake読取アクセス、Neon test project読取、保持方式、台帳保存先が確認できた後、別段階でQA枠を配置して実検証する。新資格情報・永続アクセス・課金/権限/ネットワーク変更・不可逆resetが必要なら別承認。mainへのmerge・Production適用は行わない。
