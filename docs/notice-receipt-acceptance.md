# notice receipt実機受入計画

このdraft PRは実機受入の対象を固定するための文書だけを追加する。Preview作成・更新、DB変更、ブラウザQA、cleanupはまだ実行しない。実行前にこのPR番号と最新の完全HEADを提示して承認範囲を確認する。

## mainへの導入確認

- PR #74は2026-10-16にmergeされ、mainは`afd71e0bda65f2303ee9144243380d771b7cb90d`。
- [main CI 38920819607](https://github.com/tyask/Cake/actions/runs/38920819607)はattempt 1で成功。
- mainの`receiptTransport: github-actions-notice/v1`、必須`controlSha`入力、専用notice step、artifact依存の撤去を確認した。
- mergeで既存のclosed triggerが起動した[run 38920820251](https://github.com/tyask/Cake/actions/runs/38920820251)も成功。Cloudの既存gh認証で正式cleanup notice 366 bytesを読み、run/attempt/job/check/suite、PR #74 closed、main control SHAを照合した。operationはnull、Deployment/DBを含まないreceiptだった。これは受信経路の正式な実測であり、資源がある場合の削除検証ではない。準備担当が新たにdispatchしたrunではない。

## 受入対象

| 項目 | 対象 |
| --- | --- |
| Repository / PR | `tyask/Cake`のこのOPEN draft PR。番号と完全HEADはPR本文で確定 |
| 試験branch | `codex/notice-receipt-acceptance` |
| QA slot / URL | 固定slotなし。このPR専用の新しい固有Preview URL。まだ未発行 |
| Vercel project / team | `fumin1/cake` / `prj_Z37vquodhpRd08ZTAtYnP0qa59jD` / `team_D1Mcx2TdFWPKcypfu8KzNMub` |
| Neon Preview project | `misty-meadow-88903426` |
| Neon親branch | `br-lively-frog-b3y2mauu`。親自体を更新・削除しない |
| Native branch候補 | `preview/codex/notice-receipt-acceptance` |
| DB branch / endpoint ID | 未割当。作成後に正確なID・generation・host digestを照合する |
| provider資格情報 | Actionsの既存`VERCEL_TOKEN`・`NEON_API_KEY`。Cloudへの移動・追加発行なし |

成功した上記main runは、両named Secretsが非空であることのpreflightとVercel/Neon project・parentのGET照合を通過した。これは実行時の利用可否の証拠である。Secrets設定一覧の読取はHTTP 403だったため、登録metadataの現在値は未確認で、別認証で再試行していない。Cloud側にNeon tokenがないことを理由にActionsフローが利用不能とは扱わない。

## 既存資源と自動起動

読取時点でVercel projectには全46 Deploymentがあり、現行`cake-preview/v1` metadataを持つPreviewはなかった。既存の旧QAはPR #71のbranchに属するREADYの`dpl_ERpnzP1QTDRAg6EBnFXTvXW3yhB3`（`cake-3igtlzycc-fumin1.vercel.app`）とERRORの`dpl_2z2SxsEF7Xns4VbzLoadXihrk7db`。これらと本番、旧Cannele資源は今回の受入対象ではなく、利用・更新・削除しない。Neon全branch一覧はCloudから直接取得しておらず、既存DBの完全棚卸し済みとは主張しない。

`vercel.json`の`**: false / main: true`は維持する。pushとdraft PRのopen/synchronizeは通常CIだけを起動し、Preview作成はmainへの明示dispatchに限る。mainへのmergeは本番Git deploy、PRのmerge/closeはcleanupを起動し得るため、この試験PRを無断でmerge/closeしない。

## 承認後の手順と影響

1. 現在のOPEN PR・完全HEAD、最新main/CI、config、provider binding、既存Deploymentと候補Native branchを全件照合する。候補名の未管理DBや他PR/本番との一致、所属不明があれば作成前に停止する。
2. `npm run deploy:preview`で初回作成する。想定は最大2つのPreview Deployment（Native作成用provisioningとapplication）、専用Neon branch 1件とread-write endpoint 1件。初回application buildで新しい専用DBだけへmigration/seedを行う。provisioning buildは接続前guardで停止する設計。失敗時も資源を無断削除・再作成せず、runと正確なIDを報告する。
3. Cloudがnoticeから正式deploy receiptを受け取り、READYの固有URL、PR/HEAD、operation/run/attempt/control SHA、generation、DB branch/endpointとhost digestを確認する。`npm run qa:status`も同じ経路で読む。
4. `npm run qa:verify`でPC/mobileのA/Bログイン・16回の実クリック・session/app GET・runtime proofを確認する。既存のテスト用A/Bと専用DBだけを使用し、実データや本番ログインは使用しない。通常の業務書込を伴うfixture追加は別に承認範囲を確認する。
5. この試験branchへ受入checkpointの文書commitを1件追加し、通常CI確認後にapplication Previewを追加配置する。同じNeon branch/endpoint・generationを保持し、DB markerと初回seed/承認済み入力の保持、正式receiptの新HEAD一致、A/B QAを再確認する。想定追加資源はapplication Deployment 1件で、新DBは作らない。
6. cleanupは今回の作成/更新/QA承認に含めず、作成されたDeployment IDとNeon branch/endpoint、generation、削除影響を提示してから別に承認を求める。承認前はPRをOPENのまま残す。承認された場合だけ対象を閉じ、全対象不在を直接GETで確認する。

既存資源への移行・接続先変更・データコピー、親DBや本番DBへのSQL、credential/security設定変更は予定しない。応答不明・401/403・receiptの欠落/重複/切詰め/マスク・所属不一致では停止し、盲目的な再dispatchや別経路へのfallbackをしない。

## Cloud接続設定の確認

ユーザーが削除した「接続許可URL」の保存箇所・保存値は未確認。既に起動中のcontainerの実効設定と、Cloudに保存された設定や将来の新container設定は分けて扱う。設定は今回変更しない。

現行フローではCloudがGitHub API/HTTPS Git、npm、必要時のVercel API、発行されたPR固有Preview originへ接続する。providerのNeon APIやDB通信はActions/Vercel側で行い、CloudへNeon tokenやDB接続先を追加しない。旧qa1固定URLやartifact ZIP配信hostを復活させる前提にはしない。新URLが出た後、ネットワーク許可、タスク上のURL承認、Vercel保護認証を区別して確認し、TLS/proxy/保護を弱めずに接続する。

| 用途 | 保存設定を確認するhost |
| --- | --- |
| Git / GitHub API・notice | `github.com`、`api.github.com` |
| npm依存 | `registry.npmjs.org` |
| Preview画面 | 正式receiptで確認したPR固有の完全hostname。まだ未発行 |
| 既存OIDCがない場合の既定経路 | `api.vercel.com` |
| Chromiumを新規取得する場合だけ | `cdn.playwright.dev`、`playwright.download.prss.microsoft.com`。redirect先は未測定 |

現在のcontainerには`/usr/bin/chromium`があるため、browser download先は直近の必須追加対象ではない。接続切断通知後にもcommand実行と既存gh認証のGitHub API GETが成功した。現在のcontainerの実効policyは`unrestricted`で、Vercel project metadata GETも成功している。ただし、保存済み設定・新taskの接続可否や、切断通知と削除した設定の因果関係を証明しない。

保存設定の確認場所はSettings → Codex Cloud → Environments → 対象環境の「…」→ Edit。`Allow Codex to access internet`と`Additional allowed domains`を確認し、変更する場合は保存・Republish後の新taskで検証する。[公式手順](https://learn.chatgpt.com/docs/environments/cloud-environments#connect-to-services)ではroot domainの登録だけで`www`以外のsubdomainは許可されないため、GitHub APIやPR固有hostを別に確認する。今回、設定変更・新規資格情報取得は行わない。

現時点で承認を求める対象は、このPR専用の初回Preview/DB作成・初回migration/seed、同じDBを保持する追加配置1回、PC/mobile A/B QAである。実行対象PR番号とHEADは承認依頼時に再確認する。cleanupと設定変更は別扱いとする。
