# コードと秘密情報の自動検査

GitHubへの更新・プルリクエスト時に、無料のOpengrep 1.33.1でコードと追加コミット内の秘密情報を検査します。有料契約・追加アカウントは不要で、ソースや検出内容を外部の解析サービスへ送りません。既存の部品検査は維持します。

- 現行GitHubトークン形式は公式資料に基づく補完ルールでも検査します。https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github
- コードはCI向け`p/ci`と`p/secrets`の確認済みルール。取得元はhttps://semgrep.dev/c/p/ci とhttps://semgrep.dev/c/p/secrets（2026-11-06取得）。ライセンス等の元情報はルール内に保持しています。ルールは圧縮保存し、SHA-256を確認して一時展開します。検出用の例文を実際の鍵と誤認しないよう、検査用ルール自体はコード検査の対象にしません。
- 公式配布のOpengrepはSHA-256を確認して実行します。Pythonの追加部品やMCPサーバーは導入しません。
- 実装コードを毎回検査。過去の取得応答・検証記録はコード検査から除きますが、その場所に新たに追加された内容も秘密情報検査の対象です。新しい複数コミットで鍵を追加してから削除した場合も検査します。
- 検出・解析失敗・時間切れは失敗にし、種類と場所だけを表示します。鍵や該当行の値はログ・添付に出しません。結果はリポジトリのActionsの「Code security」、失敗はGitHubの通知欄で確認します。
- 2MBを超えるソース・未対応言語等の検査限界は結果に残します。成功を全脆弱性の不存在とは扱いません。
- cooldown未指定を禁止する推奨ルールだけは除外。現行GitHubは未指定でも通常更新を既定3日待機し、脆弱性修正には待機を適用しないため、勝手に7日待機へ変更しません。公式: https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#cooldown
- 点検時にOpengrepの配布元・最新版・既知脆弱性とルール更新を確認します。検査を緑にするための一括除外・エラー無視・既存修正の巻き戻しはしません。
- このPCのソフト追加・復元前は`/home/hikaru1x7/other/security/README.md`と`security-audit/current.json`を読み、対処で削除・無効化したものを自動復元しません。
