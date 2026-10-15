# Cake の開発ルール

開発・PR作成・QA操作を行う前に、[開発・QA運用手順](docs/development-workflow.md)を読み、その手順に従う。CloudとローカルPCで共通の作業ルール、セットアップ、検証、QA予約・公開・返却、失敗時の対応は、この文書を正本とする。

Cannele連携の切替は同文書の「Canneleへの切替」を確認する。実行方式は取得し直した`origin/main`の`cannele.config.json`で決め、無効時は現行Actions方式を使う。有効時は固定された`sourceRevision`と一致する共通CLI・操作手順・Skillを参照する。作業ブランチの設定だけで方式を切り替えたり、切替前の機能を稼働済みとして扱ったりしない。

機能・UI・API・DBを変更する際は、関連する[基本設計](docs/design.html)と[詳細設計](docs/detail-design.html)も確認する。仕様と実装の意図が不明な場合は関連する実装・テストを調べ、必要な点を利用者に確認する。仕様・運用の変更は関連設計書と開発・QA運用手順へ反映する。

アプリの説明と一般的なローカルセットアップは[README](README.md)を参照する。
