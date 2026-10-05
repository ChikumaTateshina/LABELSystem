// LABELSystem の画面。本体（exe）とは window.labelSend / window.__labelReceive で直接やり取りする（src/window.ts）。

const FORMAT_LABELS = { svg: 'SVG', pdf: 'PDF', png: 'PNG', html: 'HTML' };

/** スプレッドシートの列（表示順）。一覧にはすべての列を表示する。 */
const COLUMNS = [
  { key: 'no', label: 'No.', variable: 'no' },
  { key: 'theme', label: 'テーマ', variable: 'theme' },
  { key: 'category', label: '部門', variable: 'category' },
  { key: 'title', label: 'タイトル', variable: 'title' },
  { key: 'username', label: 'ユーザ名', variable: 'username' },
  { key: 'userid', label: 'ユーザID', variable: 'userid' },
  { key: 'comment', label: 'コメント', variable: 'comment', wide: true },
  { key: 'date', label: '投稿日', variable: 'date' },
  { key: 'imageUrl', label: '画像url(GoogleDrive)', link: true },
  { key: 'postUrl', label: '元投稿URL(Twitter)', link: true },
  { key: 'award', label: '賞など', variable: 'award' },
  { key: 'note', label: '備考', variable: 'note', wide: true },
];

const TEMPLATE_FILES = [
  { key: 'json', name: 'template.json', hint: 'サイズ・フォント・各項目の表示領域（最大行数・文字サイズなど）' },
  { key: 'svg', name: 'template.svg', hint: 'SVG / PDF / PNG のデザイン。<text ...>{{変数}}</text> は自動改行されます' },
  { key: 'html', name: 'template.html', hint: 'HTML出力の中身（任意）。空にすると、SVGを埋め込んだHTMLを出力します' },
  { key: 'css', name: 'template.css', hint: 'HTML出力のスタイル（任意）' },
];

/** スプレッドシートに行が無いときにプレビューへ使う見本 */
const SAMPLE_ROW = {
  no: '1',
  theme: 'テーマ',
  category: '部門',
  title: '作品タイトル',
  username: 'ユーザ名',
  userid: '@userid',
  comment: 'ここにコメントが入ります。\n長い文章は自動で折り返されます。',
  date: '2026/01/01',
  award: '賞',
  note: '備考',
};

const state = {
  configured: false,
  sheetUrl: '',
  templates: [],
  template: '',
  rows: [],
  selected: new Set(),
  current: null,
  filter: '',
  formats: new Set(['pdf']),
  combined: false,
  rangeFrom: '',
  rangeTo: '',
  lastChecked: null,
  embedFonts: false,
  fonts: null,
};

const $view = document.getElementById('view');
const $toast = document.getElementById('toast');

// ---- 本体の呼び出し ---------------------------------------------------------

const waiting = new Map();
let sequence = 0;
let busy = 0;

window.__labelReceive = (json) => {
  const message = JSON.parse(json);
  const entry = waiting.get(message.id);
  if (!entry) return;
  waiting.delete(message.id);
  if (message.error) entry.reject(new Error(message.error));
  else entry.resolve(message.result);
};

/** 本体との接続は、ウィンドウが開いた直後に準備される。それまで待つ。 */
function ready() {
  return new Promise((resolve) => {
    const check = () => (typeof window.labelSend === 'function' ? resolve() : setTimeout(check, 30));
    check();
  });
}

async function call(method, params = {}, quiet = false) {
  await ready();
  if (!quiet && ++busy) document.body.classList.add('busy');
  try {
    return await new Promise((resolve, reject) => {
      const id = ++sequence;
      waiting.set(id, { resolve, reject });
      window.labelSend(JSON.stringify({ id, method, params }));
    });
  } finally {
    if (!quiet && --busy === 0) document.body.classList.remove('busy');
  }
}

// ---- 共通ユーティリティ -----------------------------------------------------

/** DOM生成ヘルパ。文字列は必ずテキストノードとして挿入する（innerHTMLは使わない）。 */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === false || value == null) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === false || child == null) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

let toastTimer;
function toast(message, isError = false) {
  $toast.textContent = message;
  $toast.className = isError ? 'toast error' : 'toast';
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.hidden = true), isError ? 7000 : 3000);
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

function field(label, control, hint) {
  control.id ||= `f-${Math.random().toString(36).slice(2, 9)}`;
  return h('div', { class: 'field' }, h('label', { htmlFor: control.id }, label), control, hint && h('div', { class: 'sub' }, hint));
}

function svgDataUrl(svg) {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

function warningList(warnings) {
  return warnings.length === 0
    ? [h('li', { class: 'note-ok' }, 'レイアウト上の問題は検出されませんでした。')]
    : warnings.map((w) => h('li', { class: `note-${w.level}` }, w.message));
}

function externalLink(url) {
  return h(
    'a',
    {
      href: '#',
      title: url,
      onclick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        guard(() => call('openUrl', { url }))();
      },
    },
    url,
  );
}

function applyState(next) {
  state.configured = next.configured;
  state.sheetUrl = next.sheetUrl;
  state.templates = next.templates;
  if (!state.templates.some((t) => t.id === state.template)) state.template = next.template;
}

function currentRow() {
  return state.rows.find((row) => row.row === state.current) ?? null;
}

// ---- 接続設定 ---------------------------------------------------------------

function renderSetup() {
  const url = h('input', {
    type: 'url',
    value: state.sheetUrl,
    placeholder: 'https://script.google.com/macros/s/…/exec',
    autocomplete: 'off',
  });
  const token = h('input', { type: 'text', autocomplete: 'off', placeholder: 'setup を実行したときのログに表示された文字列' });
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, '接続して保存');

  const submit = guard(async () => {
    save.disabled = true;
    save.textContent = '接続を確認しています…';
    try {
      applyState(await call('saveSettings', { url: url.value, token: token.value }));
      toast('スプレッドシートへ接続しました。');
      await loadRows();
    } finally {
      save.disabled = false;
      save.textContent = '接続して保存';
    }
  });

  $view.replaceChildren(
    h(
      'div',
      { class: 'panel setup' },
      h('h1', {}, state.configured ? '接続設定' : '初期設定'),
      h('p', {}, '作品の一覧が入った Google スプレッドシートへ接続します。最初に一度だけ、次の準備をしてください。'),
      h(
        'ol',
        {},
        h('li', {}, 'スプレッドシートを開き、メニューの「拡張機能」→「Apps Script」を開く。'),
        h('li', {}, 'エディタの内容を、LABELSystem.exe と同じフォルダにある ', h('code', {}, 'gas/Code.gs'), ' の内容で置き換えて保存する。'),
        h('li', {}, '関数 ', h('code', {}, 'setup'), ' を選んで実行し、実行ログに表示されたトークンを控える。'),
        h('li', {}, '「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」。「次のユーザーとして実行: 自分」「アクセスできるユーザー: 全員」でデプロイし、URLを控える。'),
        h('li', {}, '下の欄へURLとトークンを入力する。ブラウザ拡張にも同じ2つを設定する。'),
      ),
      h(
        'form',
        {
          onsubmit: (event) => {
            event.preventDefault();
            submit();
          },
        },
        field('ウェブアプリのURL', url),
        field('トークン', token, state.configured ? '設定済みのトークンは表示されません。変更・再接続する場合はもう一度入力してください。' : null),
        h(
          'div',
          { class: 'actions' },
          save,
          state.configured && h('button', { class: 'btn', type: 'button', onclick: () => renderMain() }, '戻る'),
        ),
      ),
      h('p', { class: 'sub' }, 'URLとトークンは、このPCの data/config.json にのみ保存されます。スプレッドシートへのアクセス手段になるため、他の人へ渡さないでください。'),
    ),
  );
}

// ---- 一覧・プレビュー・出力 -------------------------------------------------

async function loadRows() {
  state.rows = await call('rows');
  const rows = new Set(state.rows.map((row) => row.row));
  for (const row of state.selected) if (!rows.has(row)) state.selected.delete(row);
  if (!state.rows.some((row) => row.row === state.current)) state.current = state.rows[0]?.row ?? null;
  renderMain();
}

function visibleRows() {
  const words = state.filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return state.rows;
  return state.rows.filter((row) => {
    const text = COLUMNS.map((column) => row[column.key]).join(' ').toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** No. の数値部分（「A-041」→ 41）。数字を含まない場合は NaN。 */
function numberOf(no) {
  const match = /(\d+)\s*$/.exec(String(no ?? ''));
  return match ? Number(match[1]) : NaN;
}

/** No. が from 〜 to の行（表示中のもの）をまとめて選択する。 */
function selectRange() {
  const from = numberOf(state.rangeFrom);
  const to = numberOf(state.rangeTo);
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error('範囲の開始と終了を、No. の数字で入力してください。');
  const [low, high] = from <= to ? [from, to] : [to, from];
  const hits = visibleRows().filter((row) => numberOf(row.no) >= low && numberOf(row.no) <= high);
  if (hits.length === 0) throw new Error(`No. ${low} 〜 ${high} に該当する行がありません。`);
  for (const row of hits) state.selected.add(row.row);
  syncSelection();
  toast(`No. ${low} 〜 ${high} の ${hits.length} 行を選択しました。`);
}

/** チェックボックスの操作。Shift を押しながらクリックすると、前回クリックした行との間をまとめて切り替える。 */
function toggleRow(row, checked, shiftKey, visible) {
  const targets = [row];
  const last = visible.findIndex((item) => item.row === state.lastChecked);
  const here = visible.findIndex((item) => item.row === row.row);
  if (shiftKey && last >= 0 && here >= 0) targets.push(...visible.slice(Math.min(last, here), Math.max(last, here) + 1));
  for (const target of targets) {
    if (checked) state.selected.add(target.row);
    else state.selected.delete(target.row);
  }
  state.lastChecked = row.row;
  syncSelection();
}

let previewSequence = 0;

/**
 * 一覧画面のうち、行の選択やチェックに応じて書き換える部分。
 * 行をクリックするたびに一覧全体を作り直すと、スクロール位置が先頭へ戻ってしまうため、
 * 一覧はそのままにして、必要な部分だけをその場で更新する。
 */
let mainParts = null;

function outputTargets() {
  return state.rows.filter((row) => state.selected.has(row.row));
}

/** チェックの状態・件数・出力ボタンを、現在の選択に合わせる。 */
function syncSelection() {
  if (!mainParts) return;
  const { rows, visible, headerCheck, counter, clearButton, run } = mainParts;
  for (const [id, part] of rows) part.checkbox.checked = state.selected.has(id);
  if (headerCheck) headerCheck.checked = visible.length > 0 && visible.every((row) => state.selected.has(row.row));
  counter.textContent = `${visible.length} / ${state.rows.length} 行・${state.selected.size} 件選択中`;
  clearButton.disabled = state.selected.size === 0;
  const count = outputTargets().length;
  run.disabled = count === 0;
  run.textContent = count === 0 ? '出力する行を選択してください' : `選択した ${count} 件を出力`;
}

/** 行を選んでプレビューを切り替える。 */
function selectCurrent(id) {
  state.current = id;
  if (!mainParts) return;
  for (const [rowId, part] of mainParts.rows) part.tr.classList.toggle('current', rowId === id);
  drawPreview();
}

/** 右側のプレビュー欄を、選択中の行とテンプレートで描き直す。 */
function drawPreview() {
  if (!mainParts) return;
  const current = currentRow();
  const image = h('img', { alt: 'キャプションのプレビュー' });
  const notes = h('ul', { class: 'notes' });
  const edited = current?.original ? Object.keys(current.original).length : 0;
  mainParts.previewHost.replaceChildren(
    h('div', { class: 'label spaced' }, current ? `プレビュー: No.${current.no} ${current.title}` : 'プレビュー'),
    current ? h('div', { class: 'preview-frame' }, image) : h('div', { class: 'empty' }, '行をクリックするとプレビューを表示します。'),
    notes,
    current &&
      h(
        'div',
        { class: 'actions tight' },
        h('button', { class: 'btn', type: 'button', onclick: () => drawRowEditor(current) }, 'この行の内容を修正'),
        edited > 0 &&
          h(
            'button',
            { class: 'btn', type: 'button', onclick: guard(async () => replaceRow(await call('clearEdit', { row: current }))) },
            'スプレッドシートの内容に戻す',
          ),
        edited > 0 && h('span', { class: 'sub' }, `${edited} 項目をこのPCで修正しています（スプレッドシートは変更されません）`),
      ),
  );
  if (current) loadPreview(current, image, notes);
}

function loadPreview(row, image, notes) {
  const mine = ++previewSequence;
  call('preview', { row, templateId: state.template }, true)
    .then((result) => {
      if (mine !== previewSequence) return;
      image.src = svgDataUrl(result.svg);
      notes.replaceChildren(...warningList(result.warnings));
    })
    .catch((error) => mine === previewSequence && notes.replaceChildren(h('li', { class: 'note-warning' }, error.message)));
}

/** 行の内容が変わったとき、一覧のその行とプレビューだけを描き直す（一覧は作り直さない）。 */
function replaceRow(row) {
  state.rows = state.rows.map((item) => (item.row === row.row ? row : item));
  if (!mainParts) return;
  const index = mainParts.visible.findIndex((item) => item.row === row.row);
  if (index >= 0) mainParts.visible[index] = row;
  const part = mainParts.rows.get(row.row);
  if (part) part.tr.replaceWith(mainParts.buildRow(row));
  syncSelection();
  drawPreview();
}

/**
 * 行の内容を、このPCの中だけで加筆修正する。
 * スプレッドシートは変更せず、修正した内容はプレビューと出力に使われる。
 */
function drawRowEditor(row) {
  const draft = { ...row };
  const image = h('img', { alt: 'キャプションのプレビュー' });
  const notes = h('ul', { class: 'notes' });
  let timer;
  const inputs = COLUMNS.filter((column) => column.variable && column.key !== 'no').map((column) => {
    const control = column.wide
      ? h('textarea', { value: draft[column.key] ?? '', rows: column.key === 'comment' ? 5 : 2 })
      : h('input', { type: 'text', value: draft[column.key] ?? '', autocomplete: 'off' });
    control.addEventListener('input', () => {
      draft[column.key] = control.value;
      clearTimeout(timer);
      timer = setTimeout(() => loadPreview(draft, image, notes), 250);
    });
    const sheetValue = row.original?.[column.key];
    return field(column.label, control, sheetValue !== undefined ? `スプレッドシートの値: ${sheetValue || '（空欄）'}` : null);
  });

  const save = guard(async () => {
    clearTimeout(timer);
    const changes = Object.fromEntries(COLUMNS.filter((column) => column.variable && column.key !== 'no').map((column) => [column.key, draft[column.key] ?? '']));
    replaceRow(await call('saveEdit', { row, changes }));
    toast('修正を保存しました（このPCの中だけに保存されます）。');
  });

  mainParts.previewHost.replaceChildren(
    h('div', { class: 'label spaced' }, `No.${row.no} の内容を修正`),
    h('div', { class: 'preview-frame' }, image),
    notes,
    h('div', { class: 'sub' }, 'ここでの修正はスプレッドシートには書き込まれません。このPCに保存され、プレビューと出力に使われます。'),
    h('div', { class: 'row-editor' }, inputs),
    h(
      'div',
      { class: 'actions tight' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: save }, '修正を保存'),
      h('button', { class: 'btn', type: 'button', onclick: () => drawPreview() }, 'キャンセル'),
    ),
    h('hr'),
  );
  loadPreview(draft, image, notes);
}

/** 編集中のテンプレートに未保存の変更があるか。画面を切り替える前に確認する。 */
let hasUnsaved = () => false;

/** 編集画面を開いている間だけ有効な、キー操作の処理。 */
let editorKeys = null;
document.addEventListener('keydown', (event) => editorKeys?.(event));

function canLeave() {
  if (hasUnsaved() && !confirm('保存していない変更があります。破棄して移動しますか？')) return false;
  hasUnsaved = () => false;
  editorKeys = null;
  return true;
}

function renderMain() {
  // 絞り込みやテンプレートの変更で画面を作り直すときも、一覧と右側の欄のスクロール位置は保つ
  const scrolled = ['.table-wrap', '.side'].map((selector) => {
    const el = $view.querySelector(selector);
    return { selector, top: el?.scrollTop ?? 0, left: el?.scrollLeft ?? 0 };
  });
  const visible = visibleRows();
  const rowParts = new Map();
  const headerCheck = h('input', {
    type: 'checkbox',
    'aria-label': '表示中の行をすべて選択',
    onchange: (event) => {
      for (const row of visible) {
        if (event.target.checked) state.selected.add(row.row);
        else state.selected.delete(row.row);
      }
      syncSelection();
    },
  });

  /** 一覧の1行を作る。このPCで加筆修正した項目には印を付ける。 */
  const buildRow = (row) => {
    const checkbox = h('input', {
      type: 'checkbox',
      'aria-label': `No.${row.no} を選択`,
      onclick: (event) => toggleRow(row, event.target.checked, event.shiftKey, visible),
    });
    const tr = h(
      'tr',
      { class: row.row === state.current ? 'current' : '', onclick: () => selectCurrent(row.row) },
      h('td', { class: 'check', onclick: (event) => event.stopPropagation() }, checkbox),
      COLUMNS.map((column) => {
        const value = row[column.key] ?? '';
        const edited = row.original && column.key in row.original;
        const kind = column.link ? 'link' : column.wide ? 'wide' : column.key === 'no' ? 'num' : '';
        return h(
          'td',
          {
            class: edited ? `${kind} edited` : kind,
            title: edited ? `このPCで修正しています。スプレッドシートの値: ${row.original[column.key] || '（空欄）'}` : null,
          },
          column.link && value ? externalLink(value) : value,
        );
      }),
    );
    rowParts.set(row.row, { tr, checkbox });
    return tr;
  };

  // --- 左: スプレッドシートの行（すべての列） ---
  const search = h('input', {
    type: 'search',
    value: state.filter,
    placeholder: '絞り込み（すべての列から検索）',
    'aria-label': '絞り込み',
    oninput: (event) => {
      state.filter = event.target.value;
      const position = event.target.selectionStart;
      renderMain();
      const again = document.querySelector('input[type="search"]');
      again.focus();
      again.setSelectionRange(position, position);
    },
  });

  const table =
    visible.length === 0
      ? h('div', { class: 'empty' }, state.rows.length === 0 ? 'スプレッドシートに行がありません。' : '条件に一致する行はありません。')
      : h(
          'table',
          { class: 'sheet' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { class: 'check' }, headerCheck),
              COLUMNS.map((column) => h('th', {}, column.label)),
            ),
          ),
          h(
            'tbody',
            {},
            visible.map(buildRow),
          ),
        );

  // --- 右: テンプレート・プレビュー・出力 ---
  const template = h(
    'select',
    {
      onchange: (event) => {
        state.template = event.target.value;
        renderMain();
      },
    },
    state.templates.map((t) => h('option', { value: t.id, selected: t.id === state.template }, `${t.name} (${t.id})`)),
  );
  const importInput = h('input', {
    type: 'file',
    multiple: true,
    hidden: true,
    accept: '.json,.svg,.html,.css',
    onchange: guard((event) => importTemplate(event.target.files)),
  });

  const result = h('div', { class: 'result', hidden: true });
  const run = h('button', { class: 'btn btn-primary', type: 'button' });
  const counter = h('span', { class: 'sub' });
  const previewHost = h('div', {});
  const clearButton = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: () => {
        state.selected.clear();
        syncSelection();
      },
    },
    '選択を解除',
  );
  run.addEventListener(
    'click',
    guard(async () => {
      const targets = outputTargets();
      run.disabled = true;
      run.textContent = '出力中…';
      try {
        const data = await call('output', {
          rows: targets,
          formats: [...state.formats],
          templateId: state.template,
          combined: state.combined,
          embedFonts: state.embedFonts,
        });
        result.hidden = false;
        result.replaceChildren(
          h('div', {}, `${data.files.length} 個のファイルを出力しました。`),
          h('div', { class: 'sub' }, data.directory),
          data.notes.map((note) => h('div', { class: 'note-warning note-inline' }, note)),
          data.warnings.length > 0 && h('div', {}, '確認が必要な作品:'),
          data.warnings.length > 0 &&
            h('ul', {}, data.warnings.flatMap((item) => item.messages.map((m) => h('li', {}, `No.${item.no} ${item.title}: ${m}`)))),
        );
      } finally {
        syncSelection();
      }
    }),
  );

  $view.replaceChildren(
    h(
      'div',
      { class: 'workspace' },
      h(
        'section',
        { class: 'column' },
        h('div', { class: 'list-tools' }, search, counter),
        h(
          'form',
          {
            class: 'list-tools range',
            onsubmit: (event) => {
              event.preventDefault();
              guard(selectRange)();
            },
          },
          h('span', { class: 'sub' }, 'No.'),
          h('input', { type: 'text', inputMode: 'numeric', value: state.rangeFrom, placeholder: '開始', 'aria-label': '範囲の開始 No.', oninput: (event) => (state.rangeFrom = event.target.value) }),
          h('span', { class: 'sub' }, '〜'),
          h('input', { type: 'text', inputMode: 'numeric', value: state.rangeTo, placeholder: '終了', 'aria-label': '範囲の終了 No.', oninput: (event) => (state.rangeTo = event.target.value) }),
          h('button', { class: 'btn', type: 'submit' }, '範囲を選択'),
          clearButton,
          h('span', { class: 'sub' }, 'Shift + クリックでも範囲を選択できます'),
        ),
        h('div', { class: 'table-wrap' }, table),
      ),
      h(
        'section',
        { class: 'column side panel' },
        field('テンプレート', template),
        h(
          'div',
          { class: 'actions tight' },
          h('button', { class: 'btn', type: 'button', onclick: guard(() => openEditor(false)) }, '編集・コードを確認'),
          h('button', { class: 'btn', type: 'button', onclick: guard(() => openEditor(true)) }, '複製して新規作成'),
          h('button', { class: 'btn', type: 'button', onclick: () => importInput.click() }, 'インポート'),
          importInput,
        ),
        previewHost,
        h('hr'),
        h(
          'div',
          { class: 'field' },
          h('div', { class: 'label' }, '出力形式'),
          h(
            'div',
            { class: 'checks' },
            Object.entries(FORMAT_LABELS).map(([value, label]) =>
              h(
                'label',
                {},
                h('input', {
                  type: 'checkbox',
                  checked: state.formats.has(value),
                  onchange: (event) => (event.target.checked ? state.formats.add(value) : state.formats.delete(value)),
                }),
                label,
              ),
            ),
          ),
        ),
        h(
          'label',
          { class: 'checks' },
          h('span', {}, h('input', { type: 'checkbox', checked: state.combined, onchange: (event) => (state.combined = event.target.checked) }), ' 1ファイルにまとめたPDF / HTML（captions-all）も作成する'),
        ),
        h(
          'label',
          { class: 'checks' },
          h('span', {}, h('input', { type: 'checkbox', checked: state.embedFonts, onchange: (event) => (state.embedFonts = event.target.checked) }), ' フォントを埋め込む'),
        ),
        h('div', { class: 'sub' }, 'PDFには常に埋め込まれます。チェックすると、SVGは文字を図形（アウトライン）にし、HTMLはフォントファイルを内包します（ファイルが大きくなります）。'),
        h('div', { class: 'actions' }, run),
        result,
      ),
    ),
  );

  mainParts = { rows: rowParts, visible, buildRow, headerCheck: visible.length > 0 ? headerCheck : null, counter, clearButton, run, previewHost };
  syncSelection();
  drawPreview();

  for (const { selector, top, left } of scrolled) {
    const el = $view.querySelector(selector);
    if (el) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  }
}

// ---- テンプレートのインポート・作成・編集 -----------------------------------

/**
 * テキストファイルを、文字コードを判定して読む。
 * UTF-8 以外（メモ帳などで保存した Shift_JIS や UTF-16）で保存されたファイルを UTF-8 として読むと、
 * 日本語の部分だけが壊れて表示されなくなるため、取り込むときに判定して変換する。
 */
async function readTextFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes);
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes);
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('shift_jis').decode(bytes);
    }
  }
  // 取り込んだ後は UTF-8 で保存するので、XML宣言の文字コードも合わせておく
  return text.replace(/^(<\?xml[^>]*?encoding=)(["'])[^"']*\2/, '$1$2UTF-8$2');
}

/** 選択されたファイル（template.json / .svg / .html / .css）をテンプレートとして取り込む。 */
async function importTemplate(fileList) {
  const files = { json: '', svg: '', html: '', css: '' };
  for (const file of fileList) {
    const key = TEMPLATE_FILES.find((item) => file.name.toLowerCase().endsWith(`.${item.key}`))?.key;
    if (key) files[key] = await readTextFile(file);
  }
  if (!files.json || !files.svg) {
    throw new Error('template.json と template.svg の両方を選択してください（template.html / template.css は任意です）。');
  }
  const next = await call('saveTemplate', { files });
  applyState(next);
  state.template = next.saved;
  toast(`テンプレート「${next.saved}」をインポートしました。`);
  renderMain();
}

/** 既存のidと重ならない、複製用のidを作る。 */
function copyId(id) {
  const used = new Set(state.templates.map((t) => t.id));
  for (let n = 1; ; n++) {
    const candidate = `${id}-${n === 1 ? 'copy' : `copy${n}`}`;
    if (!used.has(candidate)) return candidate;
  }
}

async function openEditor(asCopy) {
  const source = await call('templateFiles', { templateId: state.template });
  // PC内のフォント一覧（初回の取得には少し時間がかかるため、一度だけ取得する）
  state.fonts ??= await call('fonts');
  const files = { json: source.json, svg: source.svg, html: source.html ?? '', css: source.css ?? '' };
  if (asCopy) {
    const meta = JSON.parse(files.json);
    meta.id = copyId(meta.id);
    meta.name = `${meta.name ?? meta.id} のコピー`;
    files.json = JSON.stringify(meta, null, 2) + '\n';
  }
  renderEditor(files, asCopy);
}

/**
 * テンプレートの編集画面。
 * 左で4つのファイルを編集すると、右のプレビュー（SVG / HTMLの見た目 / 出力されるHTMLのコード）が
 * 保存前でもその場で更新される。
 */
function renderEditor(files, isNew) {
  const row = currentRow() ?? SAMPLE_ROW;
  let tab = 'blocks';
  let mode = 'svg';
  let dirty = isNew;
  let latest = null;
  let timer;
  let request = 0;

  const editor = h('textarea', { class: 'code', spellcheck: false, wrap: 'off', 'aria-label': 'テンプレートのコード' });
  const hint = h('div', { class: 'sub' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const modes = h('div', { class: 'tabs', role: 'tablist' });
  const stage = h('div', { class: 'stage' });
  const notes = h('ul', { class: 'notes' });
  const image = h('img', { alt: 'SVGのプレビュー' });
  // HTMLのプレビューではスクリプトを実行させない
  const frame = h('iframe', { class: 'html-preview', title: 'HTML出力のプレビュー' });
  // スクリプトは実行させない。allow-same-origin は、表示倍率を合わせるために中身の幅を測る目的で付けている
  frame.setAttribute('sandbox', 'allow-same-origin');
  // 用紙が欄より広い場合は、全体が見えるように縮小する。
  // 左右の余白と、縦スクロールバーの幅の分を見込んでおく（見込まないと右端が切れる）
  const PREVIEW_MARGIN = 16;
  const SCROLLBAR = 18;
  const fitHtmlPreview = () => {
    const doc = frame.contentDocument;
    const caption = doc?.querySelector('.caption');
    if (!caption) return;
    // 余白と地の色はプレビューだけのもの。出力されるHTMLには入れない
    doc.body.style.padding = `${PREVIEW_MARGIN}px`;
    doc.body.style.background = '#e8e8e4';
    const available = frame.clientWidth - SCROLLBAR;
    const needed = caption.offsetWidth + PREVIEW_MARGIN * 2;
    doc.documentElement.style.zoom = String(Math.min(1, available / needed));
  };
  frame.addEventListener('load', fitHtmlPreview);
  // ウィンドウの大きさを変えたときも合わせ直す
  new ResizeObserver(fitHtmlPreview).observe(frame);
  const code = h('textarea', { class: 'code', readOnly: true, spellcheck: false, wrap: 'off', 'aria-label': '出力されるHTMLのコード' });
  const editArea = h('div', { class: 'edit-area' });
  // ブロックでの編集とコードでの編集は、同じ files を書き換える
  const blockEditor = window.BlockEditor({
    files,
    fonts: state.fonts ?? [],
    notify: (message) => toast(message, true),
    onChange: () => {
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(refresh, 120);
    },
  });

  const showPreview = () => {
    if (!latest) return;
    if (mode === 'svg') {
      image.src = svgDataUrl(latest.svg);
      // 「ブロック」タブでは、プレビューの上にドラッグ用の枠を重ねる
      stage.replaceChildren(h('div', { class: 'preview-frame' }, h('div', { class: 'canvas' }, image, tab === 'blocks' && blockEditor.overlay)));
    } else if (mode === 'html') {
      frame.srcdoc = latest.html;
      stage.replaceChildren(frame);
    } else {
      code.value = latest.html;
      stage.replaceChildren(
        h('div', { class: 'sub' }, 'HTML出力で実際に書き出される内容です（CSSを含む1ファイル）。左の template.html / template.css を編集すると更新されます。'),
        code,
      );
    }
  };

  const refresh = async () => {
    const mine = ++request;
    try {
      const result = await call('previewTemplate', { row, files }, true);
      if (mine !== request) return;
      latest = result;
      notes.replaceChildren(...warningList(result.warnings));
      showPreview();
    } catch (error) {
      // 入力途中で書式が崩れている間は、直前のプレビューを残したままエラーだけを示す
      if (mine === request) notes.replaceChildren(h('li', { class: 'note-warning' }, error.message));
    }
  };

  const drawTabs = () => {
    const items = [
      { key: 'blocks', name: 'ブロック', hint: '項目・文字・線・四角を追加し、右のプレビュー上でドラッグして配置します。細かい調整はコードのタブでも行えます。' },
      ...TEMPLATE_FILES,
    ];
    tabs.replaceChildren(
      ...items.map((item) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: item.key === tab ? 'tab active' : 'tab',
            onclick: () => {
              tab = item.key;
              drawTabs();
              showPreview();
            },
          },
          item.name,
        ),
      ),
    );
    hint.textContent = items.find((item) => item.key === tab).hint;
    if (tab === 'blocks') {
      blockEditor.reload(); // コードのタブで編集された内容を反映する
      editArea.replaceChildren(blockEditor.panel);
    } else {
      editor.value = files[tab];
      editArea.replaceChildren(editor);
    }
  };

  const drawModes = () => {
    modes.replaceChildren(
      ...[
        ['svg', 'SVG / PDF / PNG の見た目'],
        ['html', 'HTML の見た目'],
        ['code', 'HTML の出力コード'],
      ].map(([value, label]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: value === mode ? 'tab active' : 'tab',
            onclick: () => {
              mode = value;
              drawModes();
              showPreview();
            },
          },
          label,
        ),
      ),
    );
  };

  editor.addEventListener('input', () => {
    files[tab] = editor.value;
    // HTML / CSS を直接編集した場合は、ブロックとの連動を止める（次にブロックを動かしたときに上書きされないように）
    if ((tab === 'html' || tab === 'css') && blockEditor.isHtmlLinked()) {
      blockEditor.unlinkHtml();
      toast('HTML / CSS を直接編集したため、ブロックとの連動を止めました。「ブロック」タブで再び連動させられます。');
    }
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
  });
  // Tabキーで字下げできるようにする（Shift+Tab は通常どおりフォーカスを移動する）
  editor.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
    editor.dispatchEvent(new Event('input'));
  });

  const save = guard(async () => {
    const next = await call('saveTemplate', { files });
    applyState(next);
    state.template = next.saved;
    dirty = false;
    toast(`テンプレート「${next.saved}」を保存しました。`);
  });

  hasUnsaved = () => dirty;
  // 「ブロック」タブでは Ctrl+Z / Ctrl+Shift+Z をブロックエディタの履歴に使う（コードのタブでは入力欄の標準の動作）
  editorKeys = (event) => tab === 'blocks' && blockEditor.handleKey(event);
  const back = () => {
    if (!canLeave()) return;
    clearTimeout(timer);
    renderMain();
  };

  $view.replaceChildren(
    h(
      'div',
      { class: 'workspace editor' },
      h(
        'section',
        { class: 'column panel' },
        h('h2', {}, isNew ? 'テンプレートの新規作成' : 'テンプレートの編集'),
        tabs,
        hint,
        editArea,
        h(
          'div',
          { class: 'sub' },
          '使える変数: ',
          COLUMNS.filter((column) => column.variable).map((column) => `{{${column.variable}}} ${column.label}`).join(' / '),
        ),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: save }, '保存'),
          h('button', { class: 'btn', type: 'button', onclick: back }, '戻る'),
          h('span', { class: 'sub' }, 'template.json の "id" を変えて保存すると、別のテンプレートとして保存されます。'),
        ),
      ),
      h(
        'section',
        { class: 'column panel' },
        h('div', { class: 'label' }, `プレビュー: No.${row.no} ${row.title}`),
        modes,
        stage,
        notes,
      ),
    ),
  );
  drawTabs();
  drawModes();
  refresh();
}

// ---- 起動 -------------------------------------------------------------------

document.getElementById('reload').addEventListener(
  'click',
  guard(async () => {
    if (!state.configured || !canLeave()) return;
    applyState(await call('state'));
    await loadRows();
    toast('スプレッドシートの最新の内容を読み込みました。');
  }),
);
document.getElementById('open-output').addEventListener('click', guard(() => call('openOutput')));
document.getElementById('open-settings').addEventListener('click', () => canLeave() && renderSetup());

guard(async () => {
  applyState(await call('state'));
  if (!state.configured) {
    renderSetup();
    return;
  }
  try {
    await loadRows();
  } catch (error) {
    renderMain(); // 読み込めなくても画面は表示し、再読み込み・接続設定を使えるようにする
    throw error;
  }
})();
