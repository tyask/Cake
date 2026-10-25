# WSL開発・ブラウザ検証

## Linux環境とツール

WSL2内で [.node-version](../.node-version) と同じ完全版のLinux版Node.js・npm・Git・ghを使う。
Windows側のNode/npm、 `qa:windows` 、token受渡しexeは使わない。
作業先はWSLのLinuxファイルシステム内を推奨する。
`/tmp` のツールやcheckoutは再起動などで消える一時配置なので、継続利用する配置とは区別する。

```bash
uname -r
command -v node npm git gh
node -p 'process.platform'
node --version
npm --version
gh --version
gh auth status --hostname github.com
```

実行環境は次を確認する。

- カーネルがWSL2で、Nodeのplatformが `linux` であること。
- `npm run check:node` で版が一致すること。npmがWindows側を参照する場合はそのまま続けない。

ツールがなければLinux公式配布を確認し、承認された作業用の場所へ導入する。PATHの補完はそのターミナル/プロセスだけに限定する。

DNS失敗やlocalhost待受のEPERMは、WSLの設定と実行環境の制限を切り分ける。
制限が原因なら、許可された実行経路で同じ操作を行う。
DNS・CA・proxy・権限を勝手に変更して回避しない。
通常実行と承認された実行で結果が異なった場合も報告する。

## 基本検証

基本検証は次の順で準備し、実行する。

1. [開発手順](development-workflow.md)に従い、最新mainから専用worktreeを作る。
   `task:start` が依存を導入済みなら `npm ci` の再実行は不要。
2. 公式Chromiumを準備する。
3. commit済みのcleanな対象で次を実行する。

```bash
npx --no-install playwright install chromium
set -e
[ -z "$(git status --porcelain)" ]
TESTED_SHA=$(git rev-parse HEAD)
time npm run check:node
time npm run lint
time npm run typecheck
time npm run check:docs
time npm test
time npm run build
[ "$(git rev-parse HEAD)" = "$TESTED_SHA" ]
[ -z "$(git status --porcelain)" ]
```

編集中は `npm run check:fast` または `npm run test:architecture` 等の領域別コマンドで確認できる。
最終検証では上記をすべて実行し、成否と時間はコマンドごとに記録する。
失敗後に原因を直した場合は、最終SHAで必要な検証を揃える。
`npm test` のChromiumはローカルfixtureであり、実Cakeの業務操作を検証したとは扱わない。

未ログインのローカルCake表示はDBなしでも確認できる。
認証設定が不足した場合の `MissingSecret` などは別に報告し、ログイン後の動作まで成功したとしない。
localhostでのログイン後E2Eには、承認された隔離DB・認証・migration/seedが必要。

## GitHubとVercelの本人認証

GitHubはWSL側の既存gh認証で `gh api repos/tyask/Cake --jq .full_name` を確認する。
認証がなければ本人が `gh auth login` を行う。
Git pushだけが既存gh認証を利用できない場合は、global設定を変えず、当該コマンドのGit credential helperとして既存ghを指定する。

```bash
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0=credential.helper \
GIT_CONFIG_VALUE_0='!gh auth git-credential' \
npm run task:pr -- --draft --title '変更内容を日本語で記載' --changes-file /absolute/path/changes.md --verification-file /absolute/path/report.md
```

通常の変更依頼では、[既定の依頼範囲](../AGENTS.md#開発依頼の完了条件)に当該PRの作成/更新と自動Preview・専用DB操作を含める。
利用者の明示した制限と対象を確認し、範囲内の操作は追加確認せず進める。

VercelはWSL側の本人認証を使う。
未認証・失効時は、本人がWSLターミナルで `npx --yes vercel@latest login` を実行し、ブラウザで公式のDevice Flowを承認する。
Cakeを所有するteam/projectにアクセスできるアカウントを使う。
Windowsの暗号化storeや他環境のtokenをコピーしない。

認証確認は `preview.config.json` のproject/teamに固定して、project GETとdevelopment OIDC取得GETを行う。
`whoami` の403だけではproject scopeの不足/失効を断定しない。
期限・ `invalidToken` ・projectへのアクセスを別々に確認し、必要な場合は本人へ再ログインを依頼する。
CLIの更新による認証の有効化と、Cakeの権限付与を同一視しない。

`qa:verify` 自体はVercel CLIの保存済みログインを直接読まない。
WSLでは以下のように既存helperへ認証を明示的に渡し、Git/ghには渡さない。
`vercel env pull` や `.env` へのtoken保存、tokenをコマンド引数にする方法は使わない。

## 実Previewの正式ブラウザ検証

自動deploy成功後、正式ブラウザ検証は次の順で進める。

1. 対象worktreeで `npm run qa:status` を実行し、
   PR番号・完全SHA・Deployment ID・固有URL・DB branch/endpoint・generationを確認する。
2. 確認したPR番号・SHA・Deploymentを、以下の `PR` ・ `TESTED_SHA` ・ `DEPLOYMENT` に設定する。
3. ブラウザ前後に同じ資源を再照合する。

この例は標準Linux Vercel CLI保存先の本人認証をメモリ内だけで読む。
独自の保存先を使う場合は、本人が確認したWSL内の保存先を明示する。
別プロファイルやWindows storeを探索しない。
親shellへVercel tokenをexportしない。

```bash
node --import tsx --input-type=module - "$PR" "$TESTED_SHA" "$DEPLOYMENT" <<'JS'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { source } from './scripts/preview/preview-model.ts';
import { cleanTaskHead } from './scripts/task/task-workflow.ts';
import { requestReceipt } from './scripts/preview/preview-command.ts';
import { verifyBrowser, sameVerifiedDeployment, BrowserVerificationError } from './scripts/preview/preview-browser.ts';

let proof;
const cwd = process.cwd(), directory = join(cwd, '.cake');
try {
  const [pr, sha, deploymentId] = process.argv.slice(2);
  assert.match(pr, /^[1-9][0-9]*$/);
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.match(deploymentId, /^dpl_[A-Za-z0-9]+$/);
  assert.ok(!process.env.VERCEL_TOKEN && !process.env.VERCEL_OIDC_TOKEN);
  await mkdir(directory, { recursive: true });
  await rm(join(directory, 'verification.json'), { force: true });
  const raw = JSON.parse(execFileSync('gh', ['api', `repos/tyask/Cake/pulls/${pr}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const expected = source(raw), head = await cleanTaskHead(cwd);
  assert.equal(expected.state, 'open');
  assert.equal(expected.sha, sha);
  assert.equal(head.sha, sha);
  assert.equal(head.branch, expected.branch);
  const before = await requestReceipt('status', expected, cwd);
  assert.equal(before.deployment?.id, deploymentId);
  assert.ok(before.database);
  const auth = JSON.parse(await readFile(join(homedir(), '.local/share/com.vercel.cli/auth.json'), 'utf8'));
  assert.equal(typeof auth.token, 'string');
  proof = await verifyBrowser(expected, before.deployment, cwd,
    { ...process.env, VERCEL_TOKEN: auth.token });
  const after = await requestReceipt('status', expected, cwd);
  assert.ok(after.deployment && sameVerifiedDeployment(before.deployment, after.deployment));
  const finalHead = await cleanTaskHead(cwd);
  assert.equal(finalHead.sha, sha);
  assert.equal(finalHead.branch, expected.branch);
  await writeFile(join(directory, 'wsl-status-check.json'), JSON.stringify({ before, after }, null, 2));
  console.log('WSLの正式ブラウザ検証・前後照合に成功しました。');
} catch (error) {
  if (proof) {
    proof.success = false;
    await writeFile(join(directory, 'verification.json'), JSON.stringify(proof, null, 2));
  }
  const stage = error instanceof BrowserVerificationError ? error.stage : '対象・認証・status・前後照合';
  console.error(`WSLブラウザ検証に失敗しました。段階: ${stage}。秘密値や生例外は出力しません。`);
  process.exitCode = 1;
}
JS
```

`developmentToken` が同一project/team・development・期限を確認し、 `verifyBrowser` が通常のTLS通信とorigin限定OIDCを使う。
ブラウザ子プロセスにはprovider tokenを渡さない。
画面画像と公開証跡は `.cake` へ保存し、Cookie・token・生の認証応答は保存しない。
前後不一致なら成功証拠を無効にする。

明細の追加・編集・削除はこのhelperでは遮断されるため、[開発手順の業務操作テスト](development-workflow.md#明細の追加編集削除)に従って別に行う。
業務更新を許可する場合もOIDCのorigin制限と作成済み明細IDの制限を維持する。

## close後のstatus再照合

close前後は次の順で確認する。

1. close前に全Deployment・DB branch/endpoint・generationを保存する。
2. close後の自動cleanup成功と、記録したIDの直接GET不在を確認する。
   Neon側の直接GETは既存Actions資格情報で実行されるcleanup内の照合を利用できる。
   ローカルへNeon tokenを持ち込まない。

次はclosed PRに対してprovider一覧を再照合する例。 `PR` に対象番号を指定する。statusは管理APIのGETだけであり、cleanupの再実行ではない。

```bash
node --import tsx --input-type=module - "$PR" <<'JS'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { source } from './scripts/preview/preview-model.ts';
import { requestReceipt } from './scripts/preview/preview-command.ts';
try {
  const [pr] = process.argv.slice(2);
  assert.match(pr, /^[1-9][0-9]*$/);
  const raw = JSON.parse(execFileSync('gh', ['api', `repos/tyask/Cake/pulls/${pr}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const expected = source(raw);
  assert.equal(expected.state, 'closed');
  const receipt = await requestReceipt('status', expected, process.cwd());
  assert.ok(!receipt.deployment && !receipt.database);
  await mkdir('.cake', { recursive: true });
  await writeFile(`.cake/cleanup-status-${pr}.json`, JSON.stringify(receipt, null, 2));
  console.log('closed PRのDeployment・DBがprovider一覧に存在しないことを確認しました。');
} catch {
  console.error('削除後の再照合を確認できません。秘密値や生例外は出力しません。');
  process.exitCode = 1;
}
JS
```

削除後の確認と報告では次を守る。

- 正式statusの不在だけで、削除前に記録した各IDの直接GET確認を省略しない。
- ローカルでのVercel直接GETも、本人認証をメモリ内で読み、固定teamの `/v13/deployments/<記録済みID>` にGETして404だけを記録する。
  資格情報・レスポンス本文は表示しない。
- Neonについては「Actions内で確認」と「WSLから直接確認」を区別して報告する。
