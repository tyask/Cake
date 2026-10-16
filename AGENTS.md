# Cake の開発ルール

開発・PR作成・QA操作の前に、[開発・QA運用手順](docs/development-workflow.md)を読む。CloudとローカルPCで同じコマンドを使う。

QAはCake単体で運用する。PRごとのVercel Deployment固有URLとNeon Native Preview DBを使う。Cannele、固定QA URL、QA枠、旧台帳・旧Actions方式へのfallbackは使わない。

機能・UI・API・DBを変更する際は、関連する[基本設計](docs/design.html)と[詳細設計](docs/detail-design.html)を確認する。仕様・運用の変更はこれらと運用手順へ反映する。

最新mainから `npm run task:start -- <task-name>` で専用worktreeを作る。利用者の依頼範囲を守り、未コミット変更を保持する。mainへのmergeとProductionの手動操作は利用者の明示依頼時だけ行う。

アプリ説明とローカルセットアップは[README](README.md)を参照する。
