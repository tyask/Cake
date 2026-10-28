# CakeのAI-DLC運用記録

CakeはAI-DLC Workflows v2の考え方と記録構成に沿う運用層を持つ。
既存のCodex・GitHub Actions・Vercel・Neonを使い、計画承認後にIssueを作成・更新する。
保存済みのIssue本文とURLを提示し、別途その本文への承認を得てからbranch/worktreeを作り、開発・PR Readyまで進める。
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
計画承認は利用者の実際の回答・承認者の説明・記録日時・計画本文のSHA-256に結び付ける。
計画承認時点の本文は案件内の `plans/<SHA-256>.md` に保存し、計画変更後も保持する。
`task:intent approve`は計画承認の記録であり、Issue本文承認の記録と兼用しない。
Issue本文承認は、承認後に作成したIntentのInception工程へ`task:intent progress`で別に記録する。
メモにはIssue URL・承認された本文の写し・承認者・実際の承認文・記録日時を残す。
具体的な操作は[案件記録の操作](../docs/development-commands.md#案件記録の操作)に従う。
同じIssueの分割PRは、承認済み範囲の別branchをattachして同じIntentへ対応付ける。
これはAgentが転記する運用記録で、発言者の本人性を暗号学的に証明する仕組みではない。
記録日時と利用者の発言日時を区別する。

## 更新と凍結

開始・承認・計画変更・進捗・阻害・再開を `task:intent` で記録する。
計画更新は計画承認を無効にし、更新後の計画への再承認を必要とする。
計画の直接編集もSHA-256照合で検出する。
目的・範囲・受入条件・重要な実装方針が変わる場合は、計画の再承認後にIssueへ反映し、その本文への承認を得る。
同じ承認対象の計画・Issueで再開する場合は、既存の両方の承認を参照して保持できる。
通常の実装修正や、進捗・検証結果・リンクの追記だけでは承認を求め直さない。
テンプレートの参照、Issue本文の書式と作成更新前後の照合は、[計画・承認・受入条件](../docs/aidlc-workflow.md#計画承認受入条件)に従う。

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
