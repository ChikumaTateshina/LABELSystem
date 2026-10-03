// LABELSystem 管理UI。ローカルAPI（/api/*）のみを利用し、DBやレンダラーには直接触れない。

const STATUS_LABELS = { draft: 'Draft', confirmed: 'Confirmed', exported: 'Exported' };
const FORMAT_LABELS = { svg: 'SVG', pdf: 'PDF', png: 'PNG', html: 'HTML' };

const state = {
  events: [],
  eventId: null,
  templates: [],
  entries: [],
  selected: new Set(),
  statusFilter: '',
  sheetConfigured: false,
};

const $view = document.getElementById('view');
const $dialog = document.getElementById('dialog');
const $toast = document.getElementById('toast');
const $eventSelect = document.getElementById('event-select');

// ---- 共通ユーティリティ ---------------------------------------------------

/** DOM生成ヘルパ。文字列は必ずテキストノードとして挿入する（innerHTMLは使わない）。 */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === false || value == null) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key in el && key !== 'list' && key !== 'form') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === false || child == null) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

async function api(path, options = {}) {
  const init = { method: options.method ?? 'GET', headers: {} };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Error('サーバへ接続できません。サーバが起動しているか確認してください。');
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error ?? `エラーが発生しました (${response.status})`);
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  $toast.textContent = message;
  $toast.className = isError ? 'toast error' : 'toast';
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.hidden = true), isError ? 6000 : 3000);
}

function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      toast(error.message, true);
    }
  };
}

function openDialog(...content) {
  $dialog.replaceChildren(...content);
  if (!$dialog.open) $dialog.showModal();
}

function closeDialog() {
  if ($dialog.open) $dialog.close();
}

function currentEvent() {
  return state.events.find((event) => event.id === state.eventId) ?? null;
}

function templateOptions(selected, emptyLabel) {
  return [
    h('option', { value: '' }, emptyLabel),
    ...state.templates.map((t) => h('option', { value: t.id, selected: t.id === selected }, `${t.name} (${t.id})`)),
  ];
}

function field(label, control, hint) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return h('div', { class: 'field' }, h('label', { htmlFor: id }, label), control, hint && h('div', { class: 'sub' }, hint));
}

// ---- データ読み込み -------------------------------------------------------

async function loadBase() {
  const [{ events, currentEventId }, { templates }, config] = await Promise.all([
    api('/api/events'),
    api('/api/templates'),
    api('/api/config'),
  ]);
  state.sheetConfigured = Boolean(config.sheet?.configured);
  state.events = events;
  state.templates = templates;
  if (!state.events.some((event) => event.id === state.eventId)) state.eventId = currentEventId;
  $eventSelect.replaceChildren(
    ...events.map((event) =>
      h(
        'option',
        { value: event.id, selected: event.id === state.eventId },
        `${event.name}${event.status === 'archived' ? '（アーカイブ）' : ''}`,
      ),
    ),
  );
}

async function loadEntries() {
  const { entries } = await api(`/api/entries?eventId=${encodeURIComponent(state.eventId)}`);
  state.entries = entries;
  const ids = new Set(entries.map((entry) => entry.id));
  for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
}

// ---- 一覧画面（仕様 §21） -------------------------------------------------

async function renderList() {
  await loadEntries();
  const visible = state.entries.filter((entry) => !state.statusFilter || entry.status === state.statusFilter);
  const allChecked = visible.length > 0 && visible.every((entry) => state.selected.has(entry.id));

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('a', { class: 'btn btn-primary', href: '#/new' }, '＋ 手動登録'),
    h('button', { class: 'btn', type: 'button', onclick: showImportDialog }, 'インポート'),
    state.sheetConfigured &&
      h('button', { class: 'btn', type: 'button', onclick: guard(runSheetSync) }, 'シートから同期'),
    h('a', { class: 'btn', href: `/api/data/entries.json?eventId=${state.eventId}` }, 'JSON出力'),
    h('a', { class: 'btn', href: `/api/data/entries.csv?eventId=${state.eventId}` }, 'CSV出力'),
    h('button', { class: 'btn', type: 'button', onclick: guard(runBackup) }, 'バックアップ'),
    h('span', { class: 'spacer' }),
    h(
      'select',
      {
        'aria-label': 'ステータスで絞り込み',
        onchange: (event) => {
          state.statusFilter = event.target.value;
          guard(renderList)();
        },
      },
      h('option', { value: '' }, 'すべてのステータス'),
      ...Object.entries(STATUS_LABELS).map(([value, label]) =>
        h('option', { value, selected: state.statusFilter === value }, label),
      ),
    ),
    h(
      'button',
      { class: 'btn btn-primary', type: 'button', disabled: state.entries.length === 0, onclick: showExportDialog },
      state.selected.size > 0 ? `選択した${state.selected.size}件を出力` : '全作品を一括出力',
    ),
  );

  const table =
    visible.length === 0
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'div',
            { class: 'empty' },
            state.entries.length === 0
              ? '登録された作品はまだありません。ブラウザ拡張から登録するか、「手動登録」「インポート」を利用してください。'
              : '条件に一致する作品はありません。',
          ),
        )
      : h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            {},
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                h(
                  'th',
                  { class: 'check' },
                  h('input', {
                    type: 'checkbox',
                    checked: allChecked,
                    'aria-label': 'すべて選択',
                    onchange: (event) => {
                      for (const entry of visible) {
                        if (event.target.checked) state.selected.add(entry.id);
                        else state.selected.delete(entry.id);
                      }
                      guard(renderList)();
                    },
                  }),
                ),
                h('th', {}, 'No.'),
                h('th', {}, 'Title'),
                h('th', {}, 'User'),
                h('th', {}, 'Status'),
                h('th', {}, '更新'),
              ),
            ),
            h(
              'tbody',
              {},
              visible.map((entry) =>
                h(
                  'tr',
                  { onclick: () => (location.hash = `#/entries/${entry.id}`) },
                  h(
                    'td',
                    { class: 'check', onclick: (event) => event.stopPropagation() },
                    h('input', {
                      type: 'checkbox',
                      checked: state.selected.has(entry.id),
                      'aria-label': `${entry.displayNumber} を選択`,
                      onchange: (event) => {
                        if (event.target.checked) state.selected.add(entry.id);
                        else state.selected.delete(entry.id);
                        guard(renderList)();
                      },
                    }),
                  ),
                  h('td', { class: 'num' }, entry.displayNumber),
                  h('td', {}, entry.title || h('span', { class: 'untitled' }, '（タイトル未入力）')),
                  h('td', {}, entry.userDisplayName, h('div', { class: 'sub' }, entry.userId)),
                  h('td', {}, h('span', { class: `badge badge-${entry.status}` }, STATUS_LABELS[entry.status])),
                  h('td', { class: 'sub' }, new Date(entry.updatedAt).toLocaleString('ja-JP')),
                ),
              ),
            ),
          ),
        );

  const event = currentEvent();
  $view.replaceChildren(
    h('h1', {}, `${event?.name ?? ''} — 作品一覧（${state.entries.length}件）`),
    toolbar,
    table,
  );
}

// ---- 編集・手動登録画面（仕様 §10, §35, §50） ------------------------------

async function renderEditor(entryId) {
  const isNew = !entryId;
  const entry = isNew ? null : await api(`/api/entries/${entryId}`);
  if (entry && entry.eventId !== state.eventId) {
    state.eventId = entry.eventId;
    $eventSelect.value = entry.eventId;
  }

  const inputs = {
    title: h('input', { type: 'text', value: entry?.title ?? '', autocomplete: 'off' }),
    userDisplayName: h('input', { type: 'text', value: entry?.userDisplayName ?? '', autocomplete: 'off' }),
    userId: h('input', { type: 'text', value: entry?.userId ?? '', placeholder: '@example', autocomplete: 'off' }),
    comment: h('textarea', { value: entry?.comment ?? '' }),
    entryNumber: h('input', {
      type: 'text',
      value: entry?.entryNumber ?? '',
      placeholder: isNew ? '自動採番' : '',
      autocomplete: 'off',
    }),
    status: h(
      'select',
      {},
      Object.entries(STATUS_LABELS).map(([value, label]) =>
        h('option', { value, selected: (entry?.status ?? 'draft') === value }, label),
      ),
    ),
    templateId: h('select', {}, templateOptions(entry?.templateId, 'イベントの既定テンプレート')),
    sourcePostUrl: h('input', { type: 'url', value: '', placeholder: 'https://x.com/…/status/…', autocomplete: 'off' }),
  };

  const values = () => ({
    title: inputs.title.value,
    userDisplayName: inputs.userDisplayName.value,
    userId: inputs.userId.value,
    comment: inputs.comment.value,
    entryNumber: inputs.entryNumber.value.trim(),
    status: inputs.status.value,
    templateId: inputs.templateId.value || null,
  });

  // --- プレビュー ---
  const previewImage = h('img', { alt: 'キャプションのプレビュー' });
  const notes = h('ul', { class: 'notes' });
  let previewUrl = null;
  let previewSeq = 0;
  let dirty = false;

  const updatePreview = async () => {
    const seq = ++previewSeq;
    try {
      const result = await api('/api/preview', {
        method: 'POST',
        body: { ...values(), id: entry?.id, eventId: state.eventId },
      });
      if (seq !== previewSeq) return;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }));
      previewImage.src = previewUrl;
      notes.replaceChildren(
        ...(result.warnings.length === 0
          ? [h('li', { class: 'note-ok' }, 'レイアウト上の問題は検出されませんでした。')]
          : result.warnings.map((w) => h('li', { class: `note-${w.level}` }, w.message))),
      );
    } catch (error) {
      if (seq === previewSeq) notes.replaceChildren(h('li', { class: 'note-warning' }, error.message));
    }
  };
  let previewTimer;
  const schedulePreview = () => {
    dirty = true;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 250);
  };
  for (const input of Object.values(inputs)) {
    if (input !== inputs.sourcePostUrl && input !== inputs.status) input.addEventListener('input', schedulePreview);
  }
  inputs.status.addEventListener('input', () => (dirty = true));

  // --- 保存・削除・出力 ---
  const save = async () => {
    if (isNew) {
      const created = await api('/api/entries', {
        method: 'POST',
        body: {
          ...values(),
          entryNumber: values().entryNumber || undefined,
          eventId: state.eventId,
          sourcePostUrl: inputs.sourcePostUrl.value.trim() || undefined,
          sourcePlatform: inputs.sourcePostUrl.value.trim() ? undefined : 'manual',
        },
      });
      toast(`${created.displayNumber} を登録しました。`);
      location.hash = `#/entries/${created.id}`;
      return created;
    }
    const updated = await api(`/api/entries/${entry.id}`, { method: 'PUT', body: values() });
    dirty = false;
    toast('保存しました。');
    return updated;
  };

  const download = async (format) => {
    if (dirty) await save();
    const template = inputs.templateId.value;
    const link = h('a', {
      href: `/api/entries/${entry.id}/caption.${format}?download=1${template ? `&template=${encodeURIComponent(template)}` : ''}`,
    });
    document.body.append(link);
    link.click();
    link.remove();
  };

  const remove = async () => {
    if (!confirm(`${entry.displayNumber}「${entry.title || '無題'}」を削除します。元に戻せません。`)) return;
    await api(`/api/entries/${entry.id}`, { method: 'DELETE' });
    toast('削除しました。');
    location.hash = '#/';
  };

  const form = h(
    'form',
    {
      class: 'panel',
      onsubmit: (event) => {
        event.preventDefault();
        guard(save)();
      },
    },
    field('タイトル', inputs.title),
    field('ユーザ名', inputs.userDisplayName),
    field('ユーザID', inputs.userId),
    field('コメント', inputs.comment),
    h(
      'div',
      { class: 'field-row' },
      field('管理番号', inputs.entryNumber, entry ? `表示: ${entry.displayNumber}` : null),
      field('ステータス', inputs.status),
    ),
    field('テンプレート', inputs.templateId),
    isNew
      ? field('元投稿URL（任意）', inputs.sourcePostUrl, 'Xを介さない登録の場合は空欄で構いません。')
      : h(
          'div',
          { class: 'field' },
          h('div', { class: 'label' }, '元投稿'),
          entry.source?.postUrl
            ? h('a', { href: entry.source.postUrl, target: '_blank', rel: 'noopener noreferrer' }, entry.source.postUrl)
            : h('span', { class: 'sub' }, '（手動登録）'),
          entry.source?.originalText &&
            h(
              'details',
              { class: 'source' },
              h('summary', {}, '元投稿の本文（変更されません）'),
              h('pre', {}, entry.source.originalText),
            ),
        ),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn btn-primary', type: 'submit' }, isNew ? '登録' : '保存'),
      h('a', { class: 'btn', href: '#/' }, '戻る'),
      h('span', { class: 'spacer' }),
      !isNew && h('button', { class: 'btn btn-danger', type: 'button', onclick: guard(remove) }, '削除'),
    ),
  );

  const preview = h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'プレビュー'),
    h('div', { class: 'preview-frame' }, previewImage),
    notes,
    h(
      'div',
      { class: 'actions' },
      isNew
        ? h('span', { class: 'sub' }, '登録するとファイルとして出力できます。')
        : Object.entries(FORMAT_LABELS).map(([format, label]) =>
            h('button', { class: 'btn', type: 'button', onclick: guard(() => download(format)) }, `${label}出力`),
          ),
    ),
  );

  $view.replaceChildren(
    h('h1', {}, isNew ? '作品の手動登録' : `${entry.displayNumber} の編集`),
    h('div', { class: 'editor' }, form, preview),
  );
  await updatePreview();
  dirty = false;
}

// ---- ダイアログ ----------------------------------------------------------

function showExportDialog() {
  const targetIds = [...state.selected];
  const formatChecks = Object.entries(FORMAT_LABELS).map(([value, label]) =>
    h('label', {}, h('input', { type: 'checkbox', value, checked: value === 'pdf' }), label),
  );
  const combined = h('input', { type: 'checkbox' });
  const template = h('select', {}, templateOptions('', '各作品の設定に従う'));
  const result = h('div', { class: 'result', hidden: true });
  const run = h('button', { class: 'btn btn-primary', type: 'button' }, '出力する');

  run.addEventListener(
    'click',
    guard(async () => {
      const formats = formatChecks.map((l) => l.firstChild).filter((c) => c.checked).map((c) => c.value);
      if (formats.length === 0) throw new Error('出力形式を1つ以上選択してください。');
      run.disabled = true;
      run.textContent = '出力中…';
      try {
        const data = await api('/api/export', {
          method: 'POST',
          body: {
            eventId: state.eventId,
            entryIds: targetIds.length > 0 ? targetIds : undefined,
            formats,
            templateId: template.value || undefined,
            combined: combined.checked,
          },
        });
        result.hidden = false;
        result.replaceChildren(
          h('div', {}, `${data.files.length}個のファイルを出力しました。`),
          h('div', { class: 'sub' }, data.directory),
          data.warnings.length > 0 && h('div', {}, '確認が必要な作品:'),
          data.warnings.length > 0 &&
            h(
              'ul',
              {},
              data.warnings.flatMap((item) =>
                item.warnings.map((w) => h('li', {}, `${item.displayNumber}: ${w.message}`)),
              ),
            ),
        );
      } finally {
        run.disabled = false;
        run.textContent = '出力する';
      }
    }),
  );

  openDialog(
    h('h2', {}, targetIds.length > 0 ? `選択した${targetIds.length}件を出力` : `全作品（${state.entries.length}件）を一括出力`),
    h('div', { class: 'field' }, h('div', { class: 'label' }, '出力形式'), h('div', { class: 'checks' }, formatChecks)),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'checks' }, h('span', {}, combined, ' 1ファイルにまとめたPDF / HTML（captions-all）も作成する')),
    ),
    field('テンプレート', template),
    result,
    h(
      'div',
      { class: 'actions' },
      run,
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => {
            closeDialog();
            guard(route)();
          },
        },
        '閉じる',
      ),
    ),
  );
}

function showImportDialog() {
  const file = h('input', { type: 'file', accept: '.csv,.json,text/csv,application/json' });
  const result = h('div', { class: 'result', hidden: true });

  const run = guard(async () => {
    const selected = file.files[0];
    if (!selected) throw new Error('ファイルを選択してください。');
    const content = await selected.text();
    const format = /\.csv$/i.test(selected.name) ? 'csv' : 'json';
    const data = await api('/api/import', { method: 'POST', body: { format, content, eventId: state.eventId } });
    result.hidden = false;
    result.replaceChildren(
      h('div', {}, `${data.created}件を登録しました。`),
      data.skipped.length > 0 && h('div', {}, `${data.skipped.length}件をスキップしました:`),
      data.skipped.length > 0 && h('ul', {}, data.skipped.map((s) => h('li', {}, `${s.row}件目: ${s.reason}`))),
    );
  });

  openDialog(
    h('h2', {}, '作品のインポート'),
    h(
      'p',
      { class: 'sub' },
      'CSVまたはJSONから作品を登録します。スプレッドシートはCSV（UTF-8）で保存してください。',
      '1行目は列名です: entry_number, title, user_display_name, user_id, comment, source_post_url',
    ),
    h('div', { class: 'field' }, file),
    result,
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: run }, 'インポート'),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => {
            closeDialog();
            guard(route)();
          },
        },
        '閉じる',
      ),
    ),
  );
}

async function runSheetSync() {
  toast('スプレッドシートを確認しています…');
  const result = await api('/api/sheet/sync', { method: 'POST', body: {} });
  if (result.skipped.length > 0) {
    openDialog(
      h('h2', {}, 'シートから同期'),
      h('div', {}, `${result.created}件を取り込みました（登録済み ${result.unchanged}件）。`),
      h('div', { class: 'result' }, `${result.skipped.length}件を取り込めませんでした:`, h('ul', {}, result.skipped.map((s) => h('li', {}, `${s.row}件目: ${s.reason}`)))),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: closeDialog }, '閉じる')),
    );
  } else {
    toast(`${result.created}件を取り込みました（登録済み ${result.unchanged}件）。`);
  }
  await renderList();
}

async function runBackup() {
  const { directory } = await api('/api/backup', { method: 'POST', body: {} });
  toast(`バックアップを作成しました: ${directory}`);
}

function showEventsDialog() {
  const name = h('input', { type: 'text', autocomplete: 'off' });
  const year = h('input', { type: 'number', value: new Date().getFullYear() });
  const prefix = h('input', { type: 'text', placeholder: 'PC2027', autocomplete: 'off' });
  const template = h('select', {}, templateOptions('', '設定ファイルの既定'));

  const refresh = async () => {
    await loadBase();
    showEventsDialog();
  };

  const create = guard(async () => {
    const created = await api('/api/events', {
      method: 'POST',
      body: {
        name: name.value,
        year: year.value || null,
        entryNumberPrefix: prefix.value,
        defaultTemplateId: template.value || null,
      },
    });
    state.eventId = created.id;
    state.selected.clear();
    toast(`イベント「${created.name}」を作成しました。`);
    await refresh();
  });

  const setStatus = (event, status) =>
    guard(async () => {
      await api(`/api/events/${event.id}`, { method: 'PUT', body: { status } });
      await refresh();
    });

  openDialog(
    h('h2', {}, 'イベント管理'),
    h(
      'ul',
      { class: 'event-list' },
      state.events.map((event) =>
        h(
          'li',
          {},
          h(
            'span',
            { class: 'name' },
            event.name,
            h('div', { class: 'sub' }, [event.year, event.entryNumberPrefix].filter(Boolean).join(' / ')),
          ),
          h('span', { class: `badge badge-${event.status === 'active' ? 'confirmed' : 'draft'}` }, event.status),
          event.status === 'active'
            ? h('button', { class: 'btn', type: 'button', onclick: setStatus(event, 'archived') }, 'アーカイブ')
            : h('button', { class: 'btn', type: 'button', onclick: setStatus(event, 'active') }, '再開'),
        ),
      ),
    ),
    h('h2', {}, '新しいイベントを作成'),
    field('イベント名', name),
    h('div', { class: 'field-row' }, field('年度', year), field('管理番号の接頭辞', prefix)),
    field('既定テンプレート', template),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: create }, '作成'),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => {
            closeDialog();
            guard(route)();
          },
        },
        '閉じる',
      ),
    ),
  );
}

// ---- ルーティング --------------------------------------------------------

async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const entryMatch = /^\/entries\/([^/]+)$/.exec(hash);
  if (hash === '/new') await renderEditor(null);
  else if (entryMatch) await renderEditor(decodeURIComponent(entryMatch[1]));
  else await renderList();
}

window.addEventListener('hashchange', guard(route));
$eventSelect.addEventListener(
  'change',
  guard(async () => {
    state.eventId = $eventSelect.value;
    state.selected.clear();
    if (location.hash && location.hash !== '#/') location.hash = '#/';
    else await route();
  }),
);
document.getElementById('manage-events').addEventListener('click', showEventsDialog);

guard(async () => {
  await loadBase();
  await route();
})();
