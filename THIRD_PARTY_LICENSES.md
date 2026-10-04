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
| [@resvg/resvg-wasm](https://github.com/yisibl/resvg-js) | SVG → PNG 変換（WASM） | MPL-2.0 |
| [tsx](https://github.com/privatenumber/tsx) | TypeScriptの実行 | MIT |

配布する `LABELSystem.exe` には、上記のライブラリに加えて [Node.js](https://nodejs.org/)（MIT License。
同梱する第三者コードのライセンスは Node.js の LICENSE を参照）が含まれます。
`@resvg/resvg-wasm`（MPL-2.0）は改変せずに同梱しており、ソースコードは上記リンク先で入手できます。

## 開発時のみ使用

| パッケージ | 用途 | ライセンス |
| --- | --- | --- |
| [typescript](https://github.com/microsoft/TypeScript) | 型チェック | Apache-2.0 |
| [esbuild](https://github.com/evanw/esbuild) | ブラウザ拡張のビルド | MIT |
| [eslint](https://github.com/eslint/eslint) / [typescript-eslint](https://github.com/typescript-eslint/typescript-eslint) | Lint | MIT |
| [linkedom](https://github.com/WebReflection/linkedom) | ブラウザ拡張のテスト用DOM | ISC |
| [postject](https://github.com/nodejs/postject) | 単一実行ファイルの生成 | MIT |

## フォント・素材

フォントファイルは本リポジトリに含めていません。サンプルテンプレートが指定する
Noto Sans JP（SIL Open Font License 1.1）は、利用者自身が導入してください。
`templates/` に同梱しているテンプレートのデザインは、本リポジトリと同じ MIT License です。
本番用テンプレートに外部素材・フォントを使う場合は、それぞれのライセンス条件を確認してください。
