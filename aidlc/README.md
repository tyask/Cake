# CakeのAI-DLC運用記録

CakeはAI-DLC Workflows v2の考え方と記録構成に沿う運用層を持つ。
既存のCodex・GitHub Actions・Vercel・Neonを使い、計画承認後はPR Readyまで進める。
公式AI-DLCエンジン、Codex用hooks、公式stage gateは接続していない。
Cakeの記録を公式エンジンのstateや承認receiptとして扱わない。

公式エンジンは採用stageごとの承認を基本とする。
将来接続する場合は、Cakeの承認範囲、記録凍結、最終SHAの検証との整合を確認する。
公式の承認履歴を捏造したり、Cakeの承認を公式receiptへ読み替えたりしない。

## 記録構成

- `spaces/default/memory/`：案件をまたぐ規約と合意した学び。
- `spaces/default/knowledge/`：既存の設計・運用資料への参照。
- `spaces/default/intents/`：Issueに対応する案件記録。

案件ごとの機械正本は `cake-intent.json`。
`plan.md` は承認対象の計画本文、`aidlc-state.md` と `audit/cake.md` は機械正本からの表示用出力である。
承認は利用者の実際の回答・承認者の説明・記録日時・計画本文のSHA-256に結び付ける。
承認時点の計画本文は案件内の `plans/<SHA-256>.md` に保存し、計画変更後も保持する。
同じIssueの分割PRは、承認済み範囲の別branchをattachして同じIntentへ対応付ける。
これはAgentが転記する運用記録で、発言者の本人性を暗号学的に証明する仕組みではない。
記録日時と利用者の発言日時を区別する。

## 更新と凍結

開始・承認・計画変更・進捗・阻害・再開を `task:intent` で記録する。
計画更新は承認を無効にし、更新後の計画への再承認を必要とする。
計画の直接編集もSHA-256照合で検出する。
通常の実装修正で計画が変わらない場合は、その範囲の承認を保持できる。

最終レビュー・最終SHAの検証を始める前に記録をfreezeしてcommitする。
以後の検証・Ready・本番反映・cleanupの結果はIssue・PR・Actionsへ記録し、
Actionsからmainへ記録用commitを直接追加しない。
凍結後の修正でGitの記録更新が必要ならreopenし、再度freeze・commitした最終SHAで必要な検証を揃える。

操作手順とIssue・PRの役割は[AI-DLC開発手順](../docs/aidlc-workflow.md)を参照する。
`.cake/`は引き続きGit管理対象外である。

## 公式資料

- [AI-DLC Workflows](https://github.com/awslabs/aidlc-workflows)
- [Spaces and Intents](https://github.com/awslabs/aidlc-workflows/blob/main/docs/guide/03-spaces-and-intents.md)
- [State and Audit](https://github.com/awslabs/aidlc-workflows/blob/main/docs/guide/10-state-and-audit.md)
