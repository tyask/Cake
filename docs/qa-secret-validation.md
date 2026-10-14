# Secret変更後のQA検証

PreviewのDB接続情報8項目をSecretへ変更した後の実環境検証用PR。
最新mainのアプリを使い、予約、専用DBの準備、ビルド、固有・固定URLでの
ログイン・画面・API、設定変更の保存、Secret設定の保持、close後の返却を確認する。
アプリ・設定・DBのコード変更はない。この試験PRはmainへマージしない。
