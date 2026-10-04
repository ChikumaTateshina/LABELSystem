/**
 * Xのページ内で動くコンテンツスクリプト。
 * ポップアップから要求されたときだけ、表示中の投稿を SourcePost へ変換して返す。
 * ページの変更・自動巡回・Cookie等へのアクセスは行わない。
 */
import { XPostExtractor } from './xPostExtractor.ts';
import { EXTRACT_MESSAGE, ext } from './browserApi.ts';

ext.runtime.onMessage.addListener(
  (message: { type?: string }, _sender: unknown, sendResponse: (response: unknown) => void) => {
    if (message?.type !== EXTRACT_MESSAGE) return false;
    new XPostExtractor(document, location.href)
      .extract()
      .then((post) => sendResponse({ ok: true, post }))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
    return true; // 非同期で応答する
  },
);
