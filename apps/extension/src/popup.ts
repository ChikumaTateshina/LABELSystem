/**
 * 拡張機能ボタンから開く登録確認画面（仕様 §10）。
 * 投稿の解析（タイトル抽出など）と重複確認はローカルサーバ側で行い、
 * 拡張機能は「X投稿 → 構造化データ」の変換と確認画面の表示だけを担当する。
 */
import type { EntryDraft, SourcePost } from '../../../packages/shared-types/index.ts';
import { EXTRACT_MESSAGE, ext, getServerUrl, setServerUrl } from './browserApi.ts';

interface ExistingEntry {
  id: string;
  displayNumber: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('form');
const message = $<HTMLDivElement>('message');
const extra = $<HTMLDivElement>('extra');
const submit = $<HTMLButtonElement>('submit');
const fields = {
  title: $<HTMLInputElement>('title'),
  userDisplayName: $<HTMLInputElement>('userDisplayName'),
  userId: $<HTMLInputElement>('userId'),
  comment: $<HTMLTextAreaElement>('comment'),
  sourcePostUrl: $<HTMLInputElement>('sourcePostUrl'),
};

let serverUrl = '';
let draft: EntryDraft | null = null;

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

function openAdmin(path = ''): void {
  void ext.tabs.create({ url: `${serverUrl}/${path}` });
}

function showForm(values: Partial<EntryDraft>): void {
  fields.title.value = values.title ?? '';
  fields.userDisplayName.value = values.userDisplayName ?? '';
  fields.userId.value = values.userId ?? '';
  fields.comment.value = values.comment ?? '';
  fields.sourcePostUrl.value = values.sourcePostUrl ?? '';
  form.hidden = false;
  (fields.title.value ? fields.comment : fields.title).focus();
}

function showDuplicate(existing: ExistingEntry): void {
  form.hidden = true;
  showMessage(`この投稿は既に登録されています。\n\nEntry:\n${existing.displayNumber}`, 'info');
  setExtra(button('登録済み作品を開く', () => openAdmin(`#/entries/${existing.id}`)));
}

async function request<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      `キャプションサーバ（${serverUrl}）へ接続できません。\nサーバを起動してから、もう一度お試しください。`,
    );
  }
  return { status: response.status, data: (await response.json().catch(() => ({}))) as T };
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

async function start(): Promise<void> {
  serverUrl = await getServerUrl();
  $<HTMLInputElement>('serverUrl').value = serverUrl;

  let post: SourcePost;
  try {
    post = await extractFromActiveTab();
  } catch (error) {
    // 取得に失敗しても、手動入力で登録を続けられるようにする（仕様 §49）
    showMessage((error as Error).message, 'error');
    setExtra(
      button('手動入力', () => {
        message.hidden = true;
        setExtra();
        showForm({});
      }),
    );
    return;
  }

  const { status, data } = await request<{ draft: EntryDraft; existing: ExistingEntry | null; error?: string }>(
    '/api/parse',
    { post },
  );
  if (status !== 200) throw new Error(data.error ?? 'サーバでエラーが発生しました。');
  if (data.existing) {
    showDuplicate(data.existing);
    return;
  }
  draft = data.draft;
  showForm(draft);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  submit.disabled = true;
  void (async () => {
    try {
      const sourcePostUrl = fields.sourcePostUrl.value.trim();
      // 送信するのは、投稿から取得した情報と運営者が入力した情報のみ（仕様 §47）
      const { status, data } = await request<ExistingEntry & { error?: string; existing?: ExistingEntry }>(
        '/api/entries',
        {
          title: fields.title.value,
          userDisplayName: fields.userDisplayName.value,
          userId: fields.userId.value,
          comment: fields.comment.value,
          sourcePostUrl: sourcePostUrl || undefined,
          sourcePostId: draft && sourcePostUrl === draft.sourcePostUrl ? draft.sourcePostId : undefined,
          originalPostText: draft?.originalPostText,
          sourcePlatform: draft?.sourcePlatform ?? (sourcePostUrl ? undefined : 'manual'),
        },
      );
      if (status === 409 && data.existing) {
        showDuplicate(data.existing);
      } else if (status !== 201) {
        showMessage(data.error ?? '登録に失敗しました。', 'error');
      } else {
        form.hidden = true;
        showMessage(`${data.displayNumber} として登録しました。`, 'success');
        setExtra(button('管理画面で開く', () => openAdmin(`#/entries/${data.id}`)));
      }
    } catch (error) {
      showMessage((error as Error).message, 'error');
    } finally {
      submit.disabled = false;
    }
  })();
});

$('cancel').addEventListener('click', () => window.close());

$('saveSettings').addEventListener('click', () => {
  void (async () => {
    await setServerUrl($<HTMLInputElement>('serverUrl').value.trim());
    location.reload();
  })();
});

start().catch((error: Error) => showMessage(error.message, 'error'));
