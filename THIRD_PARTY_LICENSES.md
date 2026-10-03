# Third Party Licenses

本システムが直接利用しているライブラリです。各ライブラリのライセンス全文は、
`npm install` 後の `node_modules/<パッケージ名>/` に含まれています。
依存ライブラリを追加・更新した場合は、この一覧も更新してください。

## 実行時に使用

| パッケージ | 用途 | ライセンス |
| --- | --- | --- |
| [pdfkit](https://github.com/foliojs/pdfkit) | PDF生成・フォント埋め込み | MIT |
| [svg-to-pdfkit](https://github.com/alafr/SVG-to-PDFKit) | SVG → PDF 変換 | MIT |
| [fontkit](https://github.com/foliojs/fontkit) | フォント探索・文字幅の計測 | MIT |
| [@resvg/resvg-js](https://github.com/yisibl/resvg-js) | SVG → PNG 変換 | MPL-2.0 |
| [tsx](https://github.com/privatenumber/tsx) | TypeScriptの実行 | MIT |

## 開発時のみ使用

| パッケージ | 用途 | ライセンス |
| --- | --- | --- |
| [typescript](https://github.com/microsoft/TypeScript) | 型チェック | Apache-2.0 |
| [esbuild](https://github.com/evanw/esbuild) | ブラウザ拡張のビルド | MIT |
| [eslint](https://github.com/eslint/eslint) / [typescript-eslint](https://github.com/typescript-eslint/typescript-eslint) | Lint | MIT |
| [linkedom](https://github.com/WebReflection/linkedom) | X Extractor のテスト用DOM | ISC |

## フォント・素材

フォントファイルは本リポジトリに含めていません。サンプルテンプレートが指定する
Noto Sans JP（SIL Open Font License 1.1）は、利用者自身が導入してください。
`templates/example/` のデザインは本リポジトリと同じ MIT License です。
本番用テンプレートに外部素材・フォントを使う場合は、それぞれのライセンス条件を確認してください。
