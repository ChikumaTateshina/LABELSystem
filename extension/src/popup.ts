/**
 * 拡張機能ボタンから開く登録確認画面。
 *
 * Xの投稿ページから読み取った内容を確認・修正し、Google スプレッドシートへ1行として転記する。
 * 送信先は、接続設定に入力したGASウェブアプリのみ。送信するのは画面に表示している項目だけで、
 * Cookieやログイン情報には触れない。
 */
import { formatPostDate, normalizeUserId, parsePostText } from '../../src/parser.ts';
import { SheetClient } from '../../src/sheet.ts';
import type { NewRow, SheetRow, SourcePost } from '../../src/types.ts';
import { EXTRACT_MESSAGE, ext, loadStored, saveStored, type Stored } from './browserApi.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('form');
const message = $<HTMLDivElement>('message');
const extra = $<HTMLDivElement>('extra');
const submit = $<HTMLButtonElement>('submit');
const settings = $<HTMLDetailsElement>('settings');

const FIELDS = ['theme', 'category', 'title', 'username', 'userid', 'comment', 'date', 'postUrl'] as const;
const inputs = Object.fromEntries(FIELDS.map((name) => [name, $<HTMLInputElement>(name)])) as Record<
  (typeof FIELDS)[number],
  HTMLInputElement | HTMLTextAreaElement
>;

let stored: Stored;

function showMessage(text: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  message.textContent = text;
  message.className = `message ${kind}`;
  message.hidden = false;
}

function setExtra(...nodes: HTMLElement[]): void {
  extra.replaceChildren(...nodes);
  extra.hidden = nodes.length === 0;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

function showForm(values: NewRow): void {
  for (const name of FIELDS) inputs[name].value = values[name] ?? '';
  form.hidden = false;
  (inputs.title.value ? inputs.comment : inputs.title).focus();
}

function showDuplicate(existing: SheetRow): void {
  form.hidden = true;
  showMessage(`この投稿は既に登録されています。\n\nNo. ${existing.no}\n${existing.title}`, 'info');
  setExtra();
}

/** 表示中のタブの投稿を取得する。取得できない場合は理由を Error として返す。 */
async function extractFromActiveTab(): Promise<SourcePost> {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  let response: { ok: boolean; post?: SourcePost; error?: string } | undefined;
  try {
    response = await ext.tabs.sendMessage(tab.id, { type: EXTRACT_MESSAGE });
  } catch {
    throw new Error('このページからは投稿を取得できません。Xの投稿ページを開き、読み込み直してからお試しください。');
  }
  if (!response?.ok || !response.post) {
    throw new Error(
      `投稿情報を取得できませんでした。\n${response?.error ?? ''}\n\nXのページ構造が変更された可能性があります。`,
    );
  }
  return response.post;
}

/** 投稿を、スプレッドシートの1行（確認画面の初期値）へ変換する。 */
function toRow(post: SourcePost): NewRow {
  const { title, comment } = parsePostText(post.text);
  return {
    theme: stored.theme,
    category: stored.category,
    title,
    username: post.userDisplayName.trim(),
    userid: normalizeUserId(post.userId),
    comment,
    date: formatPostDate(post.postedAt),
    postUrl: post.postUrl ?? '',
  };
}

async function start(): Promise<void> {
  stored = await loadStored();
  $<HTMLInputElement>('sheetUrl').value = stored.sheet.url;
  $<HTMLInputElement>('sheetToken').value = stored.sheet.token;
  if (!stored.sheet.url || !stored.sheet.token) {
    settings.open = true;
    showMessage('最初に「接続設定」へ、LABELSystem と同じウェブアプリのURLとトークンを入力してください。');
    return;
  }

  let post: SourcePost;
  try {
    post = await extractFromActiveTab();
  } catch (error) {
    // 取得に失敗しても、手動入力で登録を続けられるようにする
    showMessage((error as Error).message, 'error');
    setExtra(
      button('手動入力', () => {
        message.hidden = true;
        setExtra();
        showForm({ theme: stored.theme, category: stored.category });
      }),
    );
    return;
  }

  const row = toRow(post);
  showMessage('スプレッドシートを確認しています…');
  const existing = row.postUrl ? await new SheetClient(stored.sheet).find(row.postUrl) : null;
  if (existing) {
    showDuplicate(existing);
    return;
  }
  message.hidden = true;
  showForm(row);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  submit.disabled = true;
  submit.textContent = '登録しています…';
  void (async () => {
    try {
      const row = Object.fromEntries(FIELDS.map((name) => [name, inputs[name].value.trim()])) as NewRow;
      row.userid = normalizeUserId(row.userid ?? '');
      const result = await new SheetClient(stored.sheet).append([row]);
      // 次の登録のために、テーマと部門を覚えておく
      await saveStored({ theme: row.theme ?? '', category: row.category ?? '' });
      if (result.added.length > 0) {
        form.hidden = true;
        showMessage(`No. ${result.added[0].no} として登録しました。`, 'success');
      } else if (result.skipped[0]?.existing) {
        showDuplicate(result.skipped[0].existing);
      } else {
        showMessage(result.skipped[0]?.reason ?? '登録できませんでした。', 'error');
      }
    } catch (error) {
      showMessage((error as Error).message, 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'スプレッドシートへ登録';
    }
  })();
});

$('cancel').addEventListener('click', () => window.close());

$('saveSettings').addEventListener('click', () => {
  void (async () => {
    const sheet = {
      url: $<HTMLInputElement>('sheetUrl').value.trim(),
      token: $<HTMLInputElement>('sheetToken').value.trim(),
    };
    try {
      showMessage('接続を確認しています…');
      await new SheetClient(sheet).ping();
      await saveStored({ sheet });
      location.reload();
    } catch (error) {
      showMessage((error as Error).message, 'error');
    }
  })();
});

start().catch((error: Error) => showMessage(error.message, 'error'));
