# Cannele切替後のQA受入確認

この試験PRでは、Cloud・ローカルPC共通の通常コマンドを使い、Cannele切替後のQAフローを実環境で確認する。結果と対象のPR・SHA・貸出・DeploymentはPR本文へ記録する。

- draft PRを作成してから、QA配置の直前に空き枠を予約する。
- provisioningからNative DBを照合し、applicationを配置する。
- Deployment固有URLでPC/mobile・テストユーザーA/Bの画面操作とAPIを確認する。
- 同じDeploymentを固定QA URLへ公開し、同じ確認を行う。
- 現在HEADのCIと両URLの検証結果を確認してReadyへ進める。
- 利用者のマージ後、closed ActionsからのAPI呼出しで対象資源を削除し、枠の返却を確認する。

QA枠の一覧読取やAPIの起動確認とは別に、この一連の受入結果を記録する。定期監視は追加しない。

## closedイベントの再受入

Cake PR #70のマージで起動した[closed run 38857790783](https://github.com/tyask/Cake/actions/runs/38857790783)は、イベントJSONを読めた後、返却APIの認証で`UNAUTHENTICATED`となった。返却operationは作成されず、このrunをcleanup成功とは扱わない。

Cannele PR #15で秘密情報を含まない固定段階の診断を追加し、新しいmainからの対象限定の回復実行で`REUSABLE_WORKFLOW / POLICY_REJECTED`を確認した。Cannele PR #16は、任意の`job_workflow_ref` / `job_workflow_sha`がある場合、それぞれ必須の署名済みmainの`workflow_ref` / `workflow_sha`と完全一致する場合だけ受け入れる修正である。必須claim・mainの祖先関係・許可済みworkflow blob・GitHubの実行証拠の照合は維持した。両PRは利用者がマージしたが、修正の導入だけで実資源の削除や自動返却を検証済みとはしない。

旧貸出は修正済みmainの対象限定`workflow_dispatch`で回復した。qa1は[run 38868978714](https://github.com/tyask/Cake/actions/runs/38868978714)、qa2は[run 38869234083](https://github.com/tyask/Cake/actions/runs/38869234083)が成功し、対応する返却operationも`succeeded`となった。2026-10-16 16:46:55.401 JSTの認証済みAPI読取で、qa1・qa2は`free`・version 6・貸出なし、qa3は`free`・version 0・貸出なしを確認した。API内部では記録済みDeployment・alias・Native branchと全endpointの消失を確認してから返却しており、これをCloudから独立してNeonへ直接照会した証拠とは区別する。

この回復結果は、新しいPRのclosedイベントの実証と分けて記録する。この試験PRは通常のdraft作成・予約・新しいNative DBの配置・固有/固定URLの画面/API確認・Readyの順で進める。利用者がマージしたときに新規発生するclosed Actionsのrunで、返却APIの完了、記録済み全Deployment・alias・Native branchと全endpointの消失、対象枠の`free`を確認する。過去runの再実行や`workflow_dispatch`の成功を、新しいclosedイベントの成功証拠として代用しない。

この文書を準備した時点では、新しいclosedイベントの受入は未確認である。対象PR・HEAD・貸出・新旧DB identity・Actions runと実測結果は、確認後にPR本文へ記録する。
