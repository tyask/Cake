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

## タスクの準備

元のCake checkoutで実行する。初回cloneで依存がなければ、先にNode版を確認して`npm ci`を行う。
既に作成済みの同一タスクを、同じ名前で作り直さない。

```bash
npm run check:node
npm ci
npm run task:start -- feature-name
```

表示された`cd`を実行し、以後は対象worktreeで実装・検証・PR操作を行う。
作成途中の依存導入が失敗した場合は、`git worktree list`で表示された既存の作業先を確認する。
原因を解消してその作業先の`npm ci`から再開し、元checkoutの変更を移動・破棄しない。

## レビュー対象の記録

対象タスクのworktreeで、実装・関連テスト・自己レビュー・commitを終えてから実行する。
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
元の要求・関連設計・適用ルール・検証済み/未実施の範囲も渡す。
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
  --title '変更内容を日本語で記載' \
  --changes-file "$CONTROL_WORKTREE/.cake/changes.md" \
  --verification-file "$CONTROL_WORKTREE/.cake/report.md" \
  --remote-proof "$CONTROL_WORKTREE/.cake/verify-$PR.json" \
  --target-worktree "$TASK_WORKTREE"
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

対象worktreeで実行する。差分がAGENTS.md・README.md・docs配下の文書だけの場合に限る。
レビュー・必要な文書検査・現在HEADのCI・自動Preview/statusを先に完了する。
`.cake/report.md`へ正式ブラウザ再検証の省略理由と、現在HEADのレビュー要約・詳細リンクを記載する。

1. `.cake/changes.md`と`.cake/report.md`を最終内容へ更新する。
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
const head = await cleanTaskHead(process.cwd());
const prs = await taskPullRequests(head);
assert(prs.length === 1 && prs[0].isDraft && prs[0].headRefOid === head.sha);
const pr = prs[0].number;
const current = source(JSON.parse(await commandOutput(executeWorkflowCommand, 'gh',
  ['api', `repos/tyask/Cake/pulls/${pr}`], head.cwd)));
assert(current.sha === head.sha && current.branch === head.branch && current.state === 'open');
const base = await commandOutput(executeWorkflowCommand, 'git', ['merge-base', 'origin/main', 'HEAD'], head.cwd);
const files = (await commandOutput(executeWorkflowCommand, 'git', ['diff', '--name-only', base, 'HEAD'], head.cwd)).split('\n');
assert(files.length && files.every(file => /^(AGENTS\.md|README\.md|docs\/.+\.(md|html))$/.test(file)));
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
const preview = `- URL: ${r.deployment.url}\n- 検証commit: ${head.sha}\n`
  + `- Deployment: ${r.deployment.id}\n- DB branch: ${r.database.branchId}\n`
  + `- DB endpoint: ${r.database.endpointId}\n- generation: ${r.deployment.generation}\n`
  + '- 自動Preview/status照合済み。文書のみのため正式ブラウザ再検証を省略。';
const body = `## 変更内容\n\n${changes}\n\n## Preview\n\n${preview}\n\n## 検証結果\n\n${report}\n`;
await updateTaskPullRequest(head, pr, '変更内容を日本語で記載', body, executeWorkflowCommand);
assert.deepEqual(await cleanTaskHead(head.cwd), head);
const latest = await taskPullRequests(head);
assert(latest.length === 1 && latest[0].headRefOid === head.sha && latest[0].isDraft);
console.log({ pr, sha: head.sha, body: '更新済み。レビュー完了と省略理由を確認してReadyへ進む' });
JS
```

例のタイトルは実際の変更内容へ置き換える。
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

1. 修正とcommit。
2. 追加差分・影響範囲の再レビュー。
3. 新しい最終SHAの検証。
4. 変更説明・報告を更新し、`task:pr --draft`でpush・PR更新。
5. 同じIDのレビューコメントとPR本文を更新。
6. 新HEADのCI・自動Preview/status・必要な正式検証。
7. アプリ変更または文書のみの手順でReady。

PRがmerge/close済みなら、そのbranchの作業を再開せず、最新mainから別タスクを作る。

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
