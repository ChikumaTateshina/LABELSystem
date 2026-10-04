/** scripts/build-exe.mjs が生成する、exeへ埋め込むファイル群（パス → base64）。 */
declare module 'label-embedded' {
  export const files: Record<string, string>;
}
