# 開発・PR操作のコマンド

[開発・QA運用手順](development-workflow.md)の各工程を実行するためのコマンド例。
承認範囲・レビュー・正式証拠・Ready条件は同手順に従う。
以下のシェル例はBash用。WindowsのQA操作は[PowerShellの手順](windows-qa-credentials.md)を使う。
`<...>`・`/absolute/path/...`・例のタイトルは、今回の対象へ置き換える。
「対象worktreeで実行」は、そのworktreeのrootで実行することを指す。
現在位置は`git rev-parse --show-toplevel`で確認する。

Git/ghを使う操作にはprovider資格情報を渡さない。
必要なら次の子シェル内で実行する。`exit`すると元のシェルへ戻る。
GitHub認証、proxy、CAの設定は引き継ぎ、global設定は変更しない。
自動実行で子シェルを継続できない場合は、各コマンドへ同じ`env -u ...`の指定を付ける。

```bash
env -u VERCEL_TOKEN -u VERCEL_OIDC_TOKEN -u NEON_API_KEY \
  -u DATABASE_URL -u CAKE_TEST_DATABASE_URL bash --noprofile --norc
```

ほかのprovider資格情報も設定されていれば除外する。値を表示して確認しない。

依存は各worktreeの`npm ci`で準備する。
`gh --version`と`gh api --help`を確認し、`gh api`が`--paginate --slurp`に対応する版を使う。
非対応なら公式配布版を作業用領域へ用意し、そのプロセスだけPATHを補完する。
導入できない場合は阻害として報告し、CI照合を省略しない。

## 計画承認とIssue

[AI-DLC開発フロー](aidlc-workflow.md)に従い、既存仕様・実装を読み取りのみで調べる。
計画提示前に、案件に対応する[Issueテンプレート](../AGENTS.md#issueのテンプレートと本文確認)を実際に読む。
その該当内容と[計画・承認・受入条件](aidlc-workflow.md#計画承認受入条件)の項目を含め、Issue本文へ記載できる具体性・情報量の開発計画をチャット上で提示する。
未確定事項は未確定と明示し、未作成のIssue・PR番号などの事後情報を推測して埋めない。
提示後に、その計画を対象とする利用者の承認を得てから、案件のIssueを作成・更新する。
承認の文言は固定せず、一般的な方針への合意・作業依頼・着手指示を未提示の計画への承認として扱わない。
計画承認前はIssueの作成・更新へ進まない。
専用branch/worktree・Intentの作成、実装、PR作成は、後述のIssue本文の承認も確認してから行う。
既存Issueがあれば同じものを使い、相談や調査だけでは新規Issueを作らない。
承認済みの計画に基づき、Issueの要約・受入条件・計画を`.cake/issue.md`へ用意する。
承認対象となる要件や受入条件を、Issue化時に初めて補わない。
作成・更新前に、対象テンプレートの該当内容・独立した5見出し・受入条件のチェックリストを照合する。

```bash
gh issue create --repo tyask/Cake --title '今回の目的を日本語で記載' --body-file .cake/issue.md
# 既存Issueを更新する場合
gh issue edit <Issue番号> --repo tyask/Cake --body-file .cake/issue.md
```

実際には作成・更新のどちらかを選び、返されたIssue番号とURLを記録する。
続いて保存済み本文を再取得し、項目の欠落・書式の不一致がないことを確認する。

```bash
gh issue view <Issue番号> --repo tyask/Cake --json number,url,title,body
```

保存済み本文とURLをチャットへ提示し、提示後に、そのIssue本文を対象とする利用者の承認を得る。
計画承認をIssue承認へ流用せず、Issue承認前はbranch/worktree・Intentの作成や開発へ進まない。
CLI・APIから作成・更新した場合も、同じ照合・再取得・提示・承認を行う。

計画本文は`.cake/plan.md`等へ、計画に対する実際の承認発言は`.cake/approval.md`等へ保存しておく。
Issue承認は、IssueのURL・提示した本文そのもの・承認者・実際の承認発言・記録日時をまとめて、
別の`.cake/issue-approval.md`等へ保存しておく。
Issue本文は後から変更され得るため、URLや一時ファイルへの参照だけで承認対象を済ませない。
承認文を作成・要約して置き換えたり、利用者の発言日時を推測したりしない。
同じ承認済み計画・Issueで再開する場合は、それぞれの対象の提示と承認発言を照合し、同じ内容の承認を求め直さない。
進捗・検証結果・関連リンクの追記や、検証済み受入条件のチェック更新ではIssue承認を求め直さない。

## タスクの準備

計画承認と、作成・更新して提示したIssue本文の承認を両方確認した後、元のCake checkoutで実行する。
初回cloneで依存がなければ、先にNode版を確認して`npm ci`を行う。
既に作成済みの同一タスクを、同じ名前で作り直さない。

```bash
npm run check:node
npm ci
npm run task:start -- feature-name
```

表示された`cd`を実行し、以後は対象worktreeで実装・検証・PR操作を行う。
作成途中の依存導入が失敗した場合は、`git worktree list`で表示された既存の作業先を確認する。
原因を解消してその作業先の`npm ci`から再開し、元checkoutの変更を移動・破棄しない。

## 案件記録の操作

対象worktreeで、計画承認・Issue承認の両方を確認済みの案件についてIntentを作る。
元checkoutに計画と両方の承認の下書きを置いた場合は、その公開可能な本文だけを対象worktreeの`.cake/`へ用意する。
資格情報・環境ファイルはコピーしない。
`task:intent`の入力ファイルは対象worktree内に限定し、symlinkは使わない。

```bash
npm run task:intent -- init --issue <Issue番号> --name feature-name --plan-file .cake/plan.md
```

表示されたIntent IDを以後の操作に使う。
IDは日本標準時の日付`YYMMDD`と案件名から生成され、同じIssueのIntentを重複作成しない。

```bash
TASK_INTENT_ID='<表示されたIntent ID>'
npm run task:intent -- approve --intent "$TASK_INTENT_ID" \
  --actor 'このチャットの利用者' --reply-file .cake/approval.md
npm run task:intent -- status --intent "$TASK_INTENT_ID"
```

`approve`は計画承認の記録として、承認者・実際の承認文・計画hash・記録日時を保存する。
`--at <ISO日時>`を省略すると現在時刻を記録する。これは発言日時ではなく記録日時である。
チャットで提示した計画と、その後の利用者の承認発言の対応はAgentが確認する。
Issue承認は、上で用意した`.cake/issue-approval.md`を別の工程メモとして記録する。

```bash
npm run task:intent -- progress --intent "$TASK_INTENT_ID" \
  --phase Inception --status running --note-file .cake/issue-approval.md
```

この操作は、Issue承認の対象本文と実際の回答をIntentの監査履歴へ保持する。
Issue承認の発言で`approve`を再実行し、計画承認を上書きしない。
CLIはチャット上の承認の有無や提示順序を自動検証しないため、Agentが実行前に両方の承認を照合する。
CLIへの記録だけを根拠に、未承認の計画・Issueを承認済みとして扱わない。

凍結前の進捗は、現在の工程とメモを記録する。
`status`は読み取りだけで、追跡ファイルを更新しない。

```bash
npm run task:intent -- progress --intent "$TASK_INTENT_ID" \
  --phase Construction --status running --note-file .cake/progress.md
npm run task:intent -- status
```

計画が変わる場合は次で本文を更新する。過去の承認とfreezeは無効になる。
変更後の計画をチャット上で提示して承認を得てからIssueへ反映する。
保存済みIssue本文とURLを再提示してIssue承認を得た後、同じ`approve`手順で計画承認を、
`progress`のInceptionメモでIssue承認を、それぞれ新たに記録して開発を再開する。

```bash
npm run task:intent -- plan --intent "$TASK_INTENT_ID" --plan-file .cake/revised-plan.md
```

最終レビューへ進む前に、計画・実装・進捗を揃えて記録を凍結する。

```bash
npm run task:intent -- freeze --intent "$TASK_INTENT_ID"
git status --short
```

承認hashと計画が一致したfreeze済みの記録を、実装・関連テストとともにcommitする。
以後のレビュー・最終QA・PR・Ready・merge後の結果は、PR・Issue・Actionsへ記録する。
修正のため記録更新を再開する場合は、その理由を用意して実行する。

```bash
npm run task:intent -- reopen --intent "$TASK_INTENT_ID" --note-file .cake/reopen.md
```

計画本文が同じなら承認は維持される。
必要な記録と実装を直し、freeze・commit後の新HEADで再レビュー・必要な検証を行う。
凍結済みIntentのJSON・state・auditを直接書き換えない。

同じ承認済み案件を分割PRで実装する場合は、既存Intentを含む新しいworktreeで現在branchを関連付ける。
関連付けはfreezeを解除するため、そのbranchの作業・記録を確定してfreeze・commitする。

```bash
npm run task:intent -- attach --intent "$TASK_INTENT_ID" --note-file .cake/attach.md
```

計画の対象外となる追加機能は、関連branchの追加だけで承認済みとせず、計画更新と必要な承認へ戻る。

## レビュー対象の記録

対象タスクのworktreeで、実装・関連テスト・自己レビュー・Intentのfreeze・commitを終えてから実行する。
空でない`git status`は作業中の変更を示す。変更を捨てず、レビュー対象を確定してから進める。

```bash
set -e
git fetch origin main
[ -z "$(git status --porcelain)" ]
git rev-parse --show-toplevel
git branch --show-current
git merge-base origin/main HEAD
git rev-parse HEAD
git diff --stat "$(git merge-base origin/main HEAD)" HEAD
```

表示された作業先・branch・比較元SHA・完全HEAD SHAを別Agentへ渡す。
元の要求・Issue・Intent・受入条件・関連設計・適用ルール・検証済み/未実施の範囲も渡す。
Agentの起動は利用しているCodexの別Agent機能で行い、架空のnpmコマンドで代用しない。
実装時の履歴を渡さず、モデル・推論強度は利用者の指定がなければ未指定にする。

## 対象PRとCIの確認

対象worktreeでdraftの`task:pr`を実行したあと、次を使う。
既存の照合関数が、local・remote・OPEN PRの完全SHAと、
現在HEADのpush/PR CIそれぞれの最新run/attemptを確認する。

```bash
node --import tsx --input-type=module <<'JS'
import {
  cleanTaskHead, commandOutput, executeWorkflowCommand, taskPullRequests,
} from './scripts/task/task-workflow.ts';
import { source } from './scripts/preview/preview-model.ts';
import { assertPreviewCi } from './scripts/preview/preview-ready.ts';
const head = await cleanTaskHead(process.cwd());
const prs = await taskPullRequests(head);
if (prs.length !== 1 || prs[0].headRefOid !== head.sha) throw new Error('PR_HEAD_MISMATCH');
const remote = await commandOutput(executeWorkflowCommand, 'git',
  ['ls-remote', '--heads', 'origin', `refs/heads/${head.branch}`], head.cwd);
if (remote !== `${head.sha}\trefs/heads/${head.branch}`) throw new Error('REMOTE_HEAD_MISMATCH');
const current = source(JSON.parse(await commandOutput(executeWorkflowCommand, 'gh',
  ['api', `repos/tyask/Cake/pulls/${prs[0].number}`], head.cwd)));
if (current.sha !== head.sha || current.branch !== head.branch || current.state !== 'open') {
  throw new Error('PR_HEAD_MISMATCH');
}
await assertPreviewCi(current, head.cwd, executeWorkflowCommand);
console.log({ pr: current.pr, sha: head.sha, ci: 'push/PRとも最新attempt成功' });
JS
```

成功は終了コード0と表示された完全SHAで確認する。
CIが未完了なら完了を待ち、失敗なら修正・commit・再レビュー・必要な検証へ戻る。
push直後にPRのSHA反映が遅れた場合も、local・remote・PRを再照合する。
一致を確認してから本文更新を再実行し、Previewを重複deployしない。

報告用のrun ID・URL・時刻は次で取得できる。
同じeventのrunが複数あれば、上記照合に使った最新run/attemptを記録する。
`gh run view`のstepsにはテスト件数が含まれないため、件数が未取得ならその旨を記載する。

```bash
TESTED_SHA=$(git rev-parse HEAD)
gh api --paginate --slurp \
  "repos/tyask/Cake/actions/workflows/ci.yml/runs?head_sha=$TESTED_SHA&per_page=100" \
  --jq '[.[].workflow_runs[] | {id,html_url,event,head_sha,head_branch,run_number,run_attempt,status,conclusion}]'
gh run view <CIのrun ID> --repo tyask/Cake --json url,status,conclusion,jobs
```

自動Previewの成否は当該PRのActionsで確認し、現在資源は正式statusで再照合する。
成功した`qa:status`のあとに、公開項目だけを表示する。

```bash
npm run qa:status
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync('.cake/preview.json', 'utf8'));
if (!r.success || r.action !== 'status' || r.deployment?.phase !== 'application'
  || r.deployment.state !== 'READY') throw new Error('PREVIEW_NOT_READY');
console.log({ pr: r.source.pr, sha: r.source.sha, deployment: r.deployment.id,
  url: r.deployment.url, database: r.database, generation: r.deployment.generation });
JS
```

## control checkoutの準備

Actionsで正式ブラウザ検証する場合に使う。対象worktreeの検証・draft PR・正式statusを先に揃える。
対象worktreeで次を開始し、既存のworktreeと重ならない絶対pathを指定する。
controlは最新mainのdetached checkoutとし、タスクbranchや元のcheckoutを切り替えない。

```bash
set -e
TASK_WORKTREE=$(git rev-parse --show-toplevel)
CONTROL_WORKTREE=/absolute/path/new-cake-control
git fetch origin main
[ "$(git rev-parse origin/main)" = "$(gh api repos/tyask/Cake/branches/main --jq .commit.sha)" ]
git worktree add --detach "$CONTROL_WORKTREE" origin/main
cd "$CONTROL_WORKTREE"
npm ci
[ -z "$(git status --porcelain)" ]
[ "$(git rev-parse HEAD)" = "$(gh api repos/tyask/Cake/branches/main --jq .commit.sha)" ]
mkdir -p .cake
cp "$TASK_WORKTREE/.cake/preview.json" .cake/target-preview.json
cp "$TASK_WORKTREE/.cake/changes.md" .cake/changes.md
cp "$TASK_WORKTREE/.cake/report.md" .cake/report.md
```

コピーするのは公開receiptと説明・報告だけ。環境ファイル・資格情報・node_modulesはコピーしない。
既存controlが現在mainと一致するcleanなcheckoutなら再利用できる。
一致しなければ新しいpathで作り直し、既存controlの変更や成果物をreset・削除しない。

以後はcontrolで実行する。引数は、対象worktreeの正式statusから取得する。
`qa:verify:ci`自身も現在のPR/SHA/Deploymentとcontrolのmain一致を再照合する。

```bash
PR=$(node -p 'JSON.parse(require("node:fs").readFileSync(".cake/target-preview.json", "utf8")).source.pr')
TESTED_SHA=$(node -p 'JSON.parse(require("node:fs").readFileSync(".cake/target-preview.json", "utf8")).source.sha')
DEPLOYMENT=$(node -p 'JSON.parse(require("node:fs").readFileSync(".cake/target-preview.json", "utf8")).deployment.id')
npm run qa:verify:ci -- --pr "$PR" --sha "$TESTED_SHA" --deployment "$DEPLOYMENT"
```

終了コード0と、controlの`.cake/verify-<PR>.json`が今回の成功証拠であることを確認する。
正式検証の結果と現在HEADのレビュー要約をcontrolの`.cake/report.md`へ反映してから実行する。

```bash
npm run task:pr -- \
  --intent '<対象Intent ID>' \
  --title '変更内容を日本語で記載' \
  --changes-file "$CONTROL_WORKTREE/.cake/changes.md" \
  --verification-file "$CONTROL_WORKTREE/.cake/report.md" \
  --remote-proof "$CONTROL_WORKTREE/.cake/verify-$PR.json" \
  --target-worktree "$TASK_WORKTREE" \
  --completes-issue
```

別worktreeの管理には`--target-worktree`を必ず指定する。
mainやPRのHEADが途中で進んだ場合は、CLIの停止理由を確認して対象を揃え直す。
失敗した検証の証拠や、別Deploymentの証拠を使い回さない。

## レビューコメントの作成と更新

親Agentが、別Agentの回答と指摘への対応を日本語で`.cake/review.md`へまとめる。
現在HEADの完全SHA・比較元・完了状況・件数・対応・確認範囲と限界を含める。
対象worktreeから、初回は`CAKE_REVIEW_ACTION=create`で実行する。
再レビュー時は、保存済みIDの同じコメントを更新するため`update`へ変更する。

```bash
CAKE_REVIEW_ACTION=create node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  cleanTaskHead, commandOutput, executeWorkflowCommand, taskPullRequests,
} from './scripts/task/task-workflow.ts';
const head = await cleanTaskHead(process.cwd());
const prs = await taskPullRequests(head);
assert(prs.length === 1 && prs[0].headRefOid === head.sha);
const pr = prs[0].number, action = process.env.CAKE_REVIEW_ACTION;
assert(action === 'create' || action === 'update');
const api = async (path, args = []) => JSON.parse(await commandOutput(
  executeWorkflowCommand, 'gh', ['api', path, ...args], head.cwd));
const actor = await api('user');
const body = readFileSync('.cake/review.md', 'utf8');
assert(body.trim() && body.includes(head.sha));
let endpoint = `repos/tyask/Cake/issues/${pr}/comments`;
if (action === 'create') {
  assert(!existsSync('.cake/review-comment.json'), '既存記録を確認してupdateを使う');
} else {
  const saved = JSON.parse(readFileSync('.cake/review-comment.json', 'utf8'));
  assert(Number.isSafeInteger(saved.id) && saved.id > 0);
  endpoint = `repos/tyask/Cake/issues/comments/${saved.id}`;
  const current = await api(endpoint);
  assert.equal(current.issue_url, `https://api.github.com/repos/tyask/Cake/issues/${pr}`);
  assert.equal(current.html_url, `https://github.com/tyask/Cake/pull/${pr}#issuecomment-${saved.id}`);
  assert.equal(current.user.id, actor.id);
  assert.equal(current.user.id, saved.user.id);
  assert.equal(current.body, saved.body, '前回記録と異なる本文を上書きしない');
}
writeFileSync('.cake/review-request.json', JSON.stringify({ body }));
const result = await api(endpoint,
  ['--method', action === 'create' ? 'POST' : 'PATCH', '--input', '.cake/review-request.json']);
assert.equal(result.issue_url, `https://api.github.com/repos/tyask/Cake/issues/${pr}`);
assert.equal(result.html_url, `https://github.com/tyask/Cake/pull/${pr}#issuecomment-${result.id}`);
assert.equal(result.user.id, actor.id);
assert.equal(result.body, body);
writeFileSync('.cake/review-comment.json', JSON.stringify(result, null, 2) + '\n');
console.log(result.html_url);
JS
```

表示されたURLを`.cake/report.md`のレビュー要約へ載せ、draft PRの本文を`task:pr --draft`で更新する。
旧形式のIDだけの記録を使う場合は、対象・投稿者・前回本文を確認してから同じ形式へ揃える。

投稿の応答が不明な場合は、同じ投稿を繰り返さない。
次で対象PRのコメントを確認し、今回の投稿者・本文に一致するコメントのGET結果を保存する。
候補がない/複数ある場合は停止して状況を報告する。

```bash
PR=$(gh pr view "$(git branch --show-current)" --repo tyask/Cake --json number --jq .number)
gh api --paginate "repos/tyask/Cake/issues/$PR/comments" \
  --jq '.[] | {id,html_url,author:.user.login,body}'
gh api repos/tyask/Cake/issues/comments/<確認したID> > .cake/review-comment.json
```

## 文書のみのReady

対象worktreeで実行する。差分がAGENTS.md・README.md・aidlc/README.md・docs配下の文書、
またはIntentの計画・状態・監査記録だけの場合に限る。
アプリ・script・workflow・依存・実行設定を含む変更は対象外とする。
レビュー・必要な文書検査・現在HEADのCI・自動Preview/statusを先に完了する。
`.cake/report.md`へ正式ブラウザ再検証の省略理由と、現在HEADのレビュー要約・詳細リンクを記載する。

1. `.cake/changes.md`と`.cake/report.md`を最終内容へ更新し、`task:pr --draft --intent <Intent ID>`で関連情報を確定する。
2. `git fetch origin main`と`npm run qa:status`を実行する。
3. 次の例で、最終本文を既存のPR更新処理へ渡す。
4. 更新内容と現在HEADの一致を確認してからReadyにする。

`task:pr --draft`のPreview欄は未検証表示になるため、そのままReadyにしない。
非draftの`task:pr`はアプリの正式ブラウザ証拠を要求する。省略オプションは追加しない。

```bash
node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cleanTaskHead, commandOutput, executeWorkflowCommand, taskPullRequests,
} from './scripts/task/task-workflow.ts';
import { source } from './scripts/preview/preview-model.ts';
import { assertPreviewCi } from './scripts/preview/preview-ready.ts';
import { updateTaskPullRequest } from './scripts/task/task-pr-update.ts';
import { createTaskPrBody } from './scripts/task/task-pr.ts';
const head = await cleanTaskHead(process.cwd());
const prs = await taskPullRequests(head);
assert(prs.length === 1 && prs[0].isDraft && prs[0].headRefOid === head.sha);
const pr = prs[0].number;
const current = source(JSON.parse(await commandOutput(executeWorkflowCommand, 'gh',
  ['api', `repos/tyask/Cake/pulls/${pr}`], head.cwd)));
assert(current.sha === head.sha && current.branch === head.branch && current.state === 'open');
const base = await commandOutput(executeWorkflowCommand, 'git', ['merge-base', 'origin/main', 'HEAD'], head.cwd);
const files = (await commandOutput(executeWorkflowCommand, 'git', ['diff', '--name-only', base, 'HEAD'], head.cwd)).split('\n');
assert(files.length && files.every(file => /^(AGENTS\.md|README\.md|aidlc\/README\.md|docs\/.+\.(md|html)|aidlc\/spaces\/default\/(intents\.json|intents\/[^/]+\/(cake-intent\.json|plan\.md|plans\/[a-f0-9]{64}\.md|aidlc-state\.md|audit\/cake\.md)))$/.test(file)));
const r = JSON.parse(readFileSync('.cake/preview.json', 'utf8'));
assert(r.success && r.action === 'status' && JSON.stringify(r.source) === JSON.stringify(current));
assert(r.deployment?.phase === 'application' && r.deployment.state === 'READY');
assert(r.deployment.sha === head.sha && r.deployment.branch === head.branch && r.deployment.pr === pr);
assert(r.database && JSON.stringify(r.database) === JSON.stringify(r.deployment.database));
await assertPreviewCi(current, head.cwd, executeWorkflowCommand);
const changes = readFileSync('.cake/changes.md', 'utf8').trim();
const report = readFileSync('.cake/report.md', 'utf8').trim();
const review = JSON.parse(readFileSync('.cake/review-comment.json', 'utf8'));
assert.equal(review.html_url, `https://github.com/tyask/Cake/pull/${pr}#issuecomment-${review.id}`);
const published = JSON.parse(await commandOutput(executeWorkflowCommand, 'gh',
  ['api', `repos/tyask/Cake/issues/comments/${review.id}`], head.cwd));
assert.equal(published.body, readFileSync('.cake/review.md', 'utf8'));
assert(published.body.includes(head.sha));
assert(changes && report.includes(head.sha) && report.includes(review.html_url));
const preview = `## Preview\n\n- URL: ${r.deployment.url}\n- 検証commit: ${head.sha}\n`
  + `- Deployment: ${r.deployment.id}\n- DB branch: ${r.database.branchId}\n`
  + `- DB endpoint: ${r.database.endpointId}\n- generation: ${r.deployment.generation}\n`
  + '- 自動Preview/status照合済み。文書のみのため正式ブラウザ再検証を省略。';
const latestPr = JSON.parse(await commandOutput(executeWorkflowCommand, 'gh',
  ['api', `repos/tyask/Cake/pulls/${pr}`], head.cwd));
const title = '変更内容を日本語で記載';
const body = await createTaskPrBody({ head, title, changes, verification: report, preview,
  existingBody: latestPr.body });
await updateTaskPullRequest(head, pr, title, body, executeWorkflowCommand);
assert.deepEqual(await cleanTaskHead(head.cwd), head);
const latest = await taskPullRequests(head);
assert(latest.length === 1 && latest[0].headRefOid === head.sha && latest[0].isDraft);
console.log({ pr, sha: head.sha, body: '更新済み。レビュー完了と省略理由を確認してReadyへ進む' });
JS
```

例のタイトルは実際の変更内容へ置き換える。
直前の`task:pr --draft`が生成したIssue・Intentの関連情報を保持し、metadataを手作り・転載しない。
最後に、PR本文・レビューコメント・検証記録が現在HEADを対象としていることを確認する。

```bash
PR=$(gh pr view "$(git branch --show-current)" --repo tyask/Cake --json number --jq .number)
gh pr view "$PR" --repo tyask/Cake --json url,headRefOid,isDraft,body
gh pr ready "$PR" --repo tyask/Cake
gh pr view "$PR" --repo tyask/Cake --json url,headRefOid,isDraft,state,mergeable
```

終了コード0だけでなく、完全SHA一致・OPEN・`isDraft: false`を確認して結果を報告する。
mergeやcloseは行わず、Preview/DBなど残る資源を記録する。

## Ready後の追加修正

対象worktreeで現在のPR番号・HEAD・状態を確認し、追加修正をpushする前にdraftへ戻す。
利用者がdraft維持を指定した場合は、そのまま維持する。

```bash
PR=$(gh pr view "$(git branch --show-current)" --repo tyask/Cake --json number --jq .number)
gh pr view "$PR" --repo tyask/Cake --json url,state,headRefOid,isDraft
gh pr ready "$PR" --repo tyask/Cake --undo
gh pr view "$PR" --repo tyask/Cake --json headRefOid,isDraft
```

`isDraft: true`を確認してから、次の順に進める。

1. 必要ならIntentをreopenし、修正と記録更新・freeze・commit。
2. 追加差分・影響範囲の再レビュー。
3. 新しい最終SHAの検証。
4. 変更説明・報告を更新し、`task:pr --draft`でpush・PR更新。
5. 同じIDのレビューコメントとPR本文を更新。
6. 新HEADのCI・自動Preview/status・必要な正式検証。
7. アプリ変更または文書のみの手順でReady。

PRがmerge/close済みなら、そのbranchの作業を再開せず、最新mainから別タスクを作る。

## merge後の確認

利用者のmergeによるmainへの`push`で`post-merge.yml`が自動起動する。
pushのcommitとGitHub APIのmerged PRを照合し、関連Intentを持つ案件をPRごとに確認する。
同時に起動した`preview.yml`のmain push cleanupの正式receiptも確認する。
cleanupのjobは`preview-cleanup-<PR番号>`、notice titleは`cake-preview/v1 PR <PR番号>`となる。
1 pushにmerged PRが10件を超えて含まれる場合は、両Workflowともprepareで停止する。
既存のPR番号を指定すると、同じ確認を信頼済みmainから手動で再実行できる。

```bash
gh workflow run post-merge.yml --repo tyask/Cake --ref main -f pr=<PR番号>
gh run list --repo tyask/Cake --workflow post-merge.yml --limit 5 \
  --json databaseId,event,headSha,status,conclusion,url
```

対象PRの最新runを確認してから、詳細・Summary・artifact・Issueの固定コメントを読む。

```bash
gh run view <対象run ID> --repo tyask/Cake --json url,status,conclusion,jobs
gh issue view <Issue番号> --repo tyask/Cake --json url,state,body,comments
```

main CI・対象Productionとalias・常設Preview・専用資源cleanupの4確認を区別する。
PRのHEAD SHAとmerge SHA、各確認対象のrun・receiptを照合する。
全確認が成功し、案件完了指定・手動確認なし・ほかの関連OPEN PRなしの条件が揃った場合にIssueをcloseする。
失敗・timeout・対象変更や手動確認待ちでは、固定コメントの理由を確認してopenのまま対応する。
既にcloseされたIssueを勝手にreopenしない。
手動確認が必要な案件は、利用者または担当者が結果と証拠を記載して完了を判断する。
確認のため本番へ再deployしたり、cleanupを盲目的に再実行したりしない。

## Deployment保持の確認と整理

本番と常設Previewの保持条件・保護対象は[開発・QA運用手順](development-workflow.md#本番常設previewのdeployment保持)を参照する。
既存本人認証済みのghからmainのActionsを実行し、provider tokenをローカルへ移さない。

まず読取のみの計画を確認する。

```bash
gh workflow run deployment-retention.yml --repo tyask/Cake --ref main -f mode=plan
gh run list --repo tyask/Cake --workflow deployment-retention.yml --limit 5 --json databaseId,event,headSha,status,conclusion,url
```

対象run IDを確認してから状態とreceiptを読む。`RUN_ID`は上の一覧から選んだ実際の数値に置き換える。

```bash
RUN_ID='<対象run ID>'
gh run view "$RUN_ID" --repo tyask/Cake --json event,headSha,status,conclusion,jobs,url
gh api "repos/tyask/Cake/actions/runs/$RUN_ID/jobs" --paginate --jq '.jobs[] | {name,check_run_url,conclusion}'
```

取得した対象jobの`check_run_url`を使い、標準notice 1件のrun情報・mode・成否と集約件数を確認する。

```bash
CHECK_RUN_URL='<対象jobのcheck_run_url>'
gh api "$CHECK_RUN_URL/annotations" --paginate --jq '.[] | select(.title == "cake-deployment-retention/v1") | .message'
```

候補・削除要求対象（不在確認前）・削除確認済みの全IDはActions Summaryと公開auditログで確認する。

```bash
gh run view "$RUN_ID" --repo tyask/Cake --log | rg 'Cake retention audit:'
```

対象runのmain SHA・mode・候補と保護対象を照合し、削除の対象・影響が依頼範囲に含まれる場合に`apply`を実行する。
`apply`は実行時点の状態を再取得するため、計画後に参照先が変わったDeploymentを削除しない。

```bash
gh workflow run deployment-retention.yml --repo tyask/Cake --ref main -f mode=apply
```

同じ手順でapplyのrun・notice・Summary・auditログを確認する。
失敗時も、それまでの削除要求対象と削除確認済みIDを確認できる。
stagingの未完了runを検出した場合や、その取得に失敗した場合は整理側が停止する。
次回の日次処理または手動`plan`で状態を再照合する。
失敗や応答不明では削除済み件数を推測せず、対象IDの直接GETと一覧を読み直してから再実行を判断する。
workflowはmainに配置されている版だけを使い、PRのコードを資格情報付きで実行しない。

## 固定コマンドにしない判断

次は単一のコマンドで完了を判定できない。親Agentが対象と根拠を記録する。

| 工程 | 決める内容 | 実行・完了の根拠 |
| --- | --- | --- |
| 設計・自己レビュー・別Agentレビュー | 変更する業務契約と影響範囲 | 元要求・設計・差分・具体的なレビュー結果 |
| 変更に固有のテスト | 境界値、失敗、競合、画面上の期待結果 | 対象に合う既存テストと必要な追加検証。コマンド・SHA・件数・結果を報告 |
| Ready・マージ可否の判断 | 必須検証とレビューが揃い、未解決事項がないか | 現在HEADの証拠と利用者の指定。Readyとmergeは分け、mergeは依頼範囲に従う |
| 実Previewでの業務CRUD | 許可されたworkspace・識別名・作成ID・残存確認 | 変更ごとのPlaywright手順。標準helperは業務POSTを遮断し、qa:cloudの成功だけでは代替できない |
| 本人認証・環境設定 | 対象アカウント、権限、ネットワーク・OSの管理方法 | 各環境の既存手順。不足時は対象と停止段階を値なしで報告し、資格情報を勝手に発行・移動しない |

実PreviewのCRUDを追加する場合は、実装前に対象・許可する更新・テストデータ・後片付けを定義する。
実行時には操作スクリプトのGit外pathまたは既存回帰コマンドと、前後status・残存IDを報告へ残す。
CloudのオンメモリDB検証と、外部Previewに対する業務更新の許可・証拠は分ける。
