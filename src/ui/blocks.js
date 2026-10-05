/* global h */
// テンプレートのブロックエディタ。
//
// template.svg の直下にある <text> / <line> / <rect> / <image> を「ブロック」として扱い、
// 追加・削除・並べ替え・ドラッグでの配置・フォームでの設定変更を行う。
// 編集結果は template.svg と template.json へそのまま書き戻すため、コードのタブと行き来できる。
// ブロックとして扱えない要素（<g> の中身など）は変更せずに残す。

const SVG_NS = 'http://www.w3.org/2000/svg';
const FIELD_PATTERN = /^\s*\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/;
const UNIT_TO_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96 };

const VARIABLES = [
  ['title', 'タイトル'],
  ['username', 'ユーザ名'],
  ['userid', 'ユーザID'],
  ['comment', 'コメント'],
  ['no', 'No.'],
  ['theme', 'テーマ'],
  ['category', '部門'],
  ['date', '投稿日'],
  ['award', '賞など'],
  ['note', '備考'],
];

function toMm(length) {
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(mm|cm|in|pt|px)?\s*$/.exec(String(length ?? ''));
  return match ? Number(match[1]) * UNIT_TO_MM[match[2] ?? 'px'] : NaN;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * files: { json, svg, html, css }（編集画面と共有する。ここを書き換える）
 * onChange: 内容を変更したときに呼ぶ（プレビューの更新用）
 * fonts: このPCで利用できるフォントのファミリ名
 * notify: 利用者へ知らせたいメッセージがあるときに呼ぶ
 */
/** テンプレートと埋め込みSVGに含まれる外部参照を列挙する。参照先へのアクセスは行わない。 */
window.templateReferences = function templateReferences(files) {
  const found = new Map();
  const visited = new Set();
  const scan = (source, origin, depth = 0) => {
    if (depth > 8) return;
    const add = (raw) => {
      const value = raw.trim().replace(/&amp;/g, '&');
      if (!value || value.startsWith('#')) return;
      if (/^data:/i.test(value)) {
        if (/^data:image\/svg\+xml[;,]/i.test(value) && !visited.has(value)) {
          visited.add(value);
          try {
            const comma = value.indexOf(',');
            const body = value.slice(comma + 1);
            const text = /;base64/i.test(value.slice(0, comma))
              ? new TextDecoder().decode(Uint8Array.from(window.atob(body), (c) => c.charCodeAt(0)))
              : decodeURIComponent(body);
            scan(text, origin + ' → 埋め込みSVG', depth + 1);
          } catch { /* 壊れたデータURLは読み飛ばす */ }
        }
        return;
      }
      found.set(origin + '\n' + value, { origin, value });
    };
    for (const m of source.matchAll(/(?:href|src)\s*=\s*(["'])(.*?)\1/gi)) add(m[2]);
    for (const m of source.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) add(m[2]);
    for (const m of source.matchAll(/@import\s+(["'])(.*?)\1/gi)) add(m[2]);
  };
  for (const key of ['svg', 'html', 'css']) scan(files[key] ?? '', 'template.' + key);
  return [...found.values()];
};

window.BlockEditor = function BlockEditor({ files, onChange, fonts = [], notify = () => {} }) {
  const panel = h('div', { class: 'blocks' });
  const overlay = h('div', { class: 'overlay' });

  // ---- 元に戻す・やり直し ---------------------------------------------------

  const history = [];
  let position = -1;
  let lastTag = null;
  let lastTime = 0;
  const undoButton = h('button', { class: 'btn', type: 'button', title: 'Ctrl+Z', onclick: () => undo() }, '元に戻す');
  const redoButton = h('button', { class: 'btn', type: 'button', title: 'Ctrl+Shift+Z', onclick: () => redo() }, 'やり直す');

  function updateHistoryButtons() {
    undoButton.disabled = position <= 0;
    redoButton.disabled = position >= history.length - 1;
  }

  /**
   * 現在の内容を履歴へ積む。
   * 同じ入力欄での連続した入力（tag が同じで1秒以内）は、1回分の操作としてまとめる。
   */
  function record(tag = null) {
    const snap = { json: files.json, svg: files.svg, html: files.html, css: files.css };
    const top = history[position];
    if (top && ['json', 'svg', 'html', 'css'].every((key) => top[key] === snap[key])) return;
    const now = Date.now();
    if (tag && tag === lastTag && now - lastTime < 1000 && position === history.length - 1 && position > 0) {
      history[position] = snap;
    } else {
      history.splice(position + 1);
      history.push(snap);
      if (history.length > 200) history.shift();
      position = history.length - 1;
    }
    lastTag = tag;
    lastTime = now;
    updateHistoryButtons();
  }

  function restore(index) {
    if (index < 0 || index >= history.length) return;
    position = index;
    lastTag = null;
    Object.assign(files, history[position]);
    load();
    draw();
    updateHistoryButtons();
    onChange();
  }

  /** 矢印キーでの連続した移動を、履歴の上で1回分にまとめるための印 */
  const nudgeTag = {};
  const undo = () => restore(position - 1);
  const redo = () => restore(position + 1);
  let doc = null;
  let root = null;
  let meta = null;
  let selected = null;
  let problem = '';

  // ---- 読み込みと書き戻し ---------------------------------------------------

  function load() {
    problem = '';
    doc = root = meta = null;
    try {
      meta = JSON.parse(files.json);
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) throw new Error('オブジェクトではありません');
    } catch (error) {
      problem = `template.json を解析できません（${error.message}）。template.json のタブで修正してください。`;
      return;
    }
    const parsed = new DOMParser().parseFromString(files.svg, 'image/svg+xml');
    if (parsed.querySelector('parsererror') || parsed.documentElement?.localName !== 'svg') {
      problem = 'template.svg を解析できません。template.svg のタブで修正してください。';
      return;
    }
    doc = parsed;
    root = parsed.documentElement;
    meta.fields ??= {};
    if (!blocks().some((block) => block.el === selected)) selected = null;
  }

  function commit(tag = null) {
    files.svg = new XMLSerializer().serializeToString(doc) + '\n';
    files.json = JSON.stringify(meta, null, 2) + '\n';
    // HTML出力にも、同じ配置を反映する
    if (htmlLinked()) Object.assign(files, buildHtml());
    record(tag);
    onChange();
  }

  // ---- ブロックの読み取り ---------------------------------------------------

  const num = (el, name, fallback = 0) => {
    const value = Number.parseFloat(el.getAttribute(name) ?? '');
    return Number.isFinite(value) ? value : fallback;
  };

  function viewBox() {
    const parts = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
    return parts.length === 4 && parts.every(Number.isFinite) ? { w: parts[2], h: parts[3] } : { w: 1480, h: 1050 };
  }

  function describe(el) {
    const tag = el.localName;
    if (tag === 'text') {
      const match = FIELD_PATTERN.exec(el.textContent);
      if (match) return { el, type: 'field', name: match[1] };
      return { el, type: 'text' };
    }
    if (tag === 'line') return { el, type: 'line' };
    if (tag === 'image') return { el, type: 'image' };
    const box = viewBox();
    const background = num(el, 'x') <= 0 && num(el, 'y') <= 0 && num(el, 'width') >= box.w && num(el, 'height') >= box.h;
    return { el, type: 'rect', background };
  }

  function blocks() {
    if (!root) return [];
    return Array.from(root.children)
      .filter((el) => ['text', 'line', 'rect', 'image'].includes(el.localName))
      .map(describe);
  }

  function labelOf(block) {
    if (block.type === 'field') {
      const known = VARIABLES.find(([name]) => name === block.name);
      return `項目: ${known ? known[1] : block.name}`;
    }
    if (block.type === 'text') return `文字: ${block.el.textContent.trim().slice(0, 12) || '（空）'}`;
    if (block.type === 'line') return '線';
    if (block.type === 'image') return '画像';
    return block.background ? '背景' : '四角';
  }

  /** フィールドの設定（template.json）。無ければ作る。 */
  function spec(block) {
    return (meta.fields[block.name] ??= {});
  }

  function fontSizeOf(block) {
    return block.type === 'field' ? (spec(block).fontSize ?? num(block.el, 'font-size', 40)) : num(block.el, 'font-size', 40);
  }

  /** プレビュー上に描く枠（viewBox単位）。 */
  function boxOf(block) {
    const { el } = block;
    if (block.type === 'rect' || block.type === 'image') {
      return { x: num(el, 'x'), y: num(el, 'y'), w: num(el, 'width'), h: num(el, 'height') };
    }
    if (block.type === 'line') {
      const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((name) => num(el, name));
      const pad = 8;
      return { x: Math.min(x1, x2) - pad, y: Math.min(y1, y2) - pad, w: Math.abs(x2 - x1) + pad * 2, h: Math.abs(y2 - y1) + pad * 2 };
    }
    const size = fontSizeOf(block);
    const x = num(el, 'x');
    const anchor = el.getAttribute('text-anchor') ?? 'start';
    let width;
    let height = size * 1.35;
    if (block.type === 'field') {
      const s = spec(block);
      const total = viewBox().w;
      const auto = anchor === 'middle' ? 2 * Math.min(x, total - x) : anchor === 'end' ? 2 * x - total : total - 2 * x;
      width = s.maxWidth ?? (auto > 0 ? auto : total);
      height = size * (1.35 + ((s.maxLines ?? 1) - 1) * (s.lineHeight ?? 1.5));
    } else {
      width = Math.max(size, Array.from(el.textContent.trim()).length * size * 0.9);
    }
    const left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
    return { x: left, y: num(el, 'y') - size, w: width, h: height };
  }

  function move(block, dx, dy) {
    const { el } = block;
    const shift = (name, delta) => el.setAttribute(name, String(round(num(el, name) + delta, 1)));
    if (block.type === 'line') {
      shift('x1', dx);
      shift('x2', dx);
      shift('y1', dy);
      shift('y2', dy);
    } else {
      shift('x', dx);
      shift('y', dy);
    }
  }

  // ---- ブロックの追加・削除 -------------------------------------------------

  function append(el) {
    root.append(doc.createTextNode('  '), el, doc.createTextNode('\n'));
    selected = el;
    commit();
    draw();
  }

  function create(tag, attrs, text) {
    const el = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function addField(name) {
    const box = viewBox();
    meta.fields[name] ??= { required: false, maxLines: 1, maxWidth: Math.round(box.w * 0.8), fontSize: Math.round(box.h * 0.04) };
    append(create('text', { id: name, x: Math.round(box.w * 0.1), y: Math.round(box.h * 0.9), fill: '#1a1a1a' }, `{{${name}}}`));
  }

  function addText() {
    const box = viewBox();
    append(
      create(
        'text',
        {
          x: Math.round(box.w * 0.1),
          y: Math.round(box.h * 0.9),
          fill: '#1a1a1a',
          'font-size': Math.round(box.h * 0.03),
          // 用紙のフォント指定をそのまま使う（先頭から順に、PCにあるものが使われる）
          'font-family': paperFontFamily(),
        },
        '文字',
      ),
    );
  }

  function addLine() {
    const box = viewBox();
    const y = Math.round(box.h * 0.93);
    append(create('line', { x1: Math.round(box.w * 0.1), y1: y, x2: Math.round(box.w * 0.3), y2: y, stroke: '#1a1a1a', 'stroke-width': 3 }));
  }

  function addRect() {
    const box = viewBox();
    append(
      create('rect', {
        x: Math.round(box.w * 0.7),
        y: Math.round(box.h * 0.8),
        width: Math.round(box.w * 0.2),
        height: Math.round(box.h * 0.1),
        fill: '#dddddd',
      }),
    );
  }

  /** SVG は元のベクターデータを保持する。大きすぎる画像は断る。 */
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'];
  const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

  /** 画像ファイルを読み込み、データURLと縦横比（高さ ÷ 幅）を返す。画像はテンプレートの中へ埋め込む。 */
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
      if (!IMAGE_TYPES.includes(file.type) && !isSvg) return reject(new Error('画像は PNG、JPEG または SVG を選択してください。'));
      if (file.size > IMAGE_MAX_BYTES) return reject(new Error('画像が大きすぎます（8MBまで）。'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('画像を読み込めませんでした。'));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error('画像として読み込めませんでした。'));
        image.onload = () => {
          const width = image.naturalWidth;
          const height = image.naturalHeight;
          if (!width || !height) return reject(new Error('画像の幅・高さを取得できませんでした。SVGに width / height または viewBox を指定してください。'));
          const url = isSvg ? String(reader.result).replace(/^data:[^;,]*/, 'data:image/svg+xml') : String(reader.result);
          resolve({ url, ratio: height / width, sourceName: file.name });
        };
        image.src = isSvg ? String(reader.result).replace(/^data:[^;,]*/, 'data:image/svg+xml') : String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  /** 画像を選ぶためのボタン。選ばれたファイルを onPick へ渡す。 */
  function imageButton(label, onPick) {
    const picker = h('input', {
      type: 'file',
      accept: [...IMAGE_TYPES, '.svg'].join(','),
      hidden: true,
      onchange: (event) => {
        const [file] = event.target.files;
        event.target.value = '';
        if (file) readImage(file).then(onPick, (error) => notify(error.message));
      },
    });
    return h('span', {}, h('button', { class: 'btn', type: 'button', onclick: () => picker.click() }, label), picker);
  }

  function addImage({ url, ratio, sourceName }) {
    const box = viewBox();
    // 用紙の3割の幅（縦長の画像は高さが収まる大きさ）で、中央に置く
    const width = Math.round(Math.min(box.w * 0.3, (box.h * 0.6) / ratio));
    const height = Math.round(width * ratio);
    append(create('image', { x: Math.round((box.w - width) / 2), y: Math.round((box.h - height) / 2), width, height, href: url, 'data-source-name': sourceName ?? '' }));
  }

  /** 画像を差し替える。幅はそのままにして、高さを新しい画像の縦横比に合わせる。 */
  function replaceImage(block, { url, ratio, sourceName }) {
    block.el.setAttribute('href', url);
    block.el.setAttribute('data-source-name', sourceName ?? '');
    block.el.setAttribute('height', String(Math.round(num(block.el, 'width') * ratio)));
    commit();
    draw();
  }

  const backgroundBlock = () => blocks().find((block) => block.type === 'rect' && block.background) ?? null;

  /** 背景色を設定する。color が null の場合は背景を無くす（PNGでは透明になる）。 */
  function setBackground(color) {
    const background = backgroundBlock();
    if (color === null) {
      background?.el.remove();
    } else if (background) {
      background.el.setAttribute('fill', color);
    } else {
      const box = viewBox();
      const rect = create('rect', { x: 0, y: 0, width: box.w, height: box.h, fill: color });
      root.insertBefore(rect, root.firstChild);
      root.insertBefore(doc.createTextNode('\n  '), rect);
    }
  }

  function remove(block) {
    block.el.remove();
    if (block.type === 'field' && !blocks().some((other) => other.type === 'field' && other.name === block.name)) {
      delete meta.fields[block.name];
    }
    selected = null;
    commit();
    draw();
  }

  /** 選択中のブロックを複製する。項目は同じ列を2つ置けないため、まだ使っていない列を割り当てる。 */
  function duplicate(block) {
    const copy = block.el.cloneNode(true);
    if (block.type === 'field') {
      const used = new Set(blocks().filter((b) => b.type === 'field').map((b) => b.name));
      const free = VARIABLES.find(([name]) => !used.has(name));
      if (!free) return;
      copy.setAttribute('id', free[0]);
      copy.textContent = `{{${free[0]}}}`;
      meta.fields[free[0]] = { ...spec(block) };
    } else {
      copy.removeAttribute('id');
    }
    block.el.after(doc.createTextNode('\n  '), copy);
    selected = copy;
    const step = Math.round(viewBox().w * 0.015);
    move(describe(copy), step, step);
    commit();
    draw();
  }

  /** ブロックを用紙の端・中央へ揃える。 */
  function align(block, mode) {
    const frame = boxOf(block);
    const box = viewBox();
    const dx = { left: -frame.x, center: box.w / 2 - (frame.x + frame.w / 2), right: box.w - (frame.x + frame.w) }[mode] ?? 0;
    const dy = { top: -frame.y, middle: box.h / 2 - (frame.y + frame.h / 2), bottom: box.h - (frame.y + frame.h) }[mode] ?? 0;
    move(block, round(dx, 1), round(dy, 1));
    commit();
    draw();
  }

  /** 重なり順を変える。SVGでは後ろにある要素ほど手前に描かれる。 */
  function reorder(block, direction) {
    const list = blocks().map((b) => b.el);
    const other = list[list.indexOf(block.el) + direction];
    if (!other) return;
    if (direction > 0) other.after(block.el);
    else other.before(block.el);
    commit();
    draw();
  }

  // ---- 設定フォーム ---------------------------------------------------------

  /** 入力のたびに反映する入力欄。フォーカスを保つため、一覧や枠だけを描き直す。 */
  function input(type, value, apply, attrs = {}) {
    const tag = {}; // この入力欄での連続入力を、履歴の上で1回分にまとめるための印
    return h('input', {
      type,
      value: value ?? '',
      ...attrs,
      oninput: (event) => {
        apply(type === 'number' ? Number.parseFloat(event.target.value) : event.target.value);
        commit(tag);
        drawList();
        drawOverlay();
      },
    });
  }

  function row(label, control) {
    return h('label', { class: 'prop' }, h('span', {}, label), control);
  }

  const setAttr = (el, name) => (value) => {
    if (value === '' || (typeof value === 'number' && !Number.isFinite(value))) el.removeAttribute(name);
    else el.setAttribute(name, String(value));
  };

  const setSpec = (block, name) => (value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) delete spec(block)[name];
    else spec(block)[name] = value;
  };

  function select(value, options, apply) {
    return h(
      'select',
      {
        onchange: (event) => {
          apply(event.target.value);
          commit();
          draw();
        },
      },
      options.map(([key, label]) => h('option', { value: key, selected: key === value }, label)),
    );
  }

  function colorRow(label, el, name, fallback) {
    const value = el.getAttribute(name) ?? fallback;
    return row(
      label,
      h(
        'span',
        { class: 'color' },
        input('color', /^#[0-9a-f]{6}$/i.test(value) ? value : fallback, setAttr(el, name)),
        input('text', value, setAttr(el, name)),
      ),
    );
  }

  /** フォントの選択肢。empty を渡すと、先頭に「指定しない」を表す項目を置く。 */
  function fontOptions(current, empty) {
    const options = fonts.map((name) => [name, name]);
    if (current && !fonts.includes(current)) options.unshift([current, `${current}（このPCにありません）`]);
    if (empty) options.unshift(['', empty]);
    return options;
  }

  const firstFamily = (value) => (value ?? '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  const paperFontFamily = () => [...(meta.fonts?.length ? meta.fonts : ['Noto Sans JP']), 'sans-serif'].join(', ');

  const ANCHORS = [
    ['start', '左揃え'],
    ['middle', '中央揃え'],
    ['end', '右揃え'],
  ];

  function properties(block) {
    const { el } = block;
    const rows = [];
    if (block.type === 'field') {
      const s = spec(block);
      const used = new Set(blocks().filter((b) => b.type === 'field' && b !== block).map((b) => b.name));
      const names = VARIABLES.filter(([name]) => name === block.name || !used.has(name));
      if (!names.some(([name]) => name === block.name)) names.unshift([block.name, block.name]);
      rows.push(
        row(
          '表示する列',
          select(block.name, names, (name) => {
            meta.fields[name] = meta.fields[block.name] ?? {};
            delete meta.fields[block.name];
            el.setAttribute('id', name);
            el.textContent = `{{${name}}}`;
          }),
        ),
        row('文字サイズ', input('number', s.fontSize ?? num(el, 'font-size', 40), setSpec(block, 'fontSize'), { min: 1, step: 1 })),
        row('最小の文字サイズ', input('number', s.minFontSize ?? '', setSpec(block, 'minFontSize'), { min: 1, step: 1, placeholder: '文字サイズの80%' })),
        row('最大行数', input('number', s.maxLines ?? 1, setSpec(block, 'maxLines'), { min: 1, step: 1 })),
        row('折り返す幅', input('number', s.maxWidth ?? '', setSpec(block, 'maxWidth'), { min: 1, step: 1, placeholder: '自動' })),
        row('行送り（倍率）', input('number', s.lineHeight ?? 1.5, setSpec(block, 'lineHeight'), { min: 0.5, step: 0.05 })),
        row(
          'フォント',
          select(s.fontFamily ?? '', fontOptions(s.fontFamily, '用紙のフォントと同じ'), (value) => {
            if (value) s.fontFamily = value;
            else delete s.fontFamily;
          }),
        ),
      );
    }
    if (block.type === 'text') {
      rows.push(
        row('文字', input('text', el.textContent, (value) => (el.textContent = value))),
        row('文字サイズ', input('number', num(el, 'font-size', 40), setAttr(el, 'font-size'), { min: 1, step: 1 })),
      );
      const own = firstFamily(el.getAttribute('font-family'));
      const custom = own && own !== (meta.fonts ?? [])[0] ? own : '';
      rows.push(
        row(
          'フォント',
          select(custom, fontOptions(custom, '用紙のフォントと同じ'), (value) =>
            el.setAttribute('font-family', value ? `${value}, sans-serif` : paperFontFamily()),
          ),
        ),
      );
    }
    if (block.type === 'field' || block.type === 'text') {
      rows.push(
        row('横位置 x', input('number', num(el, 'x'), setAttr(el, 'x'), { step: 1 })),
        row('縦位置 y（1行目の下端）', input('number', num(el, 'y'), setAttr(el, 'y'), { step: 1 })),
        row('揃え', select(el.getAttribute('text-anchor') ?? 'start', ANCHORS, (value) => setAttr(el, 'text-anchor')(value === 'start' ? '' : value))),
        colorRow('文字色', el, 'fill', '#1a1a1a'),
      );
    }
    if (block.type === 'field') {
      const s = spec(block);
      rows.push(
        row(
          '太さ',
          select(s.fontWeight === 'bold' || s.fontWeight === 700 ? 'bold' : 'normal', [['normal', '標準'], ['bold', '太字']], (value) => {
            if (value === 'bold') s.fontWeight = 'bold';
            else delete s.fontWeight;
          }),
        ),
        row(
          '上下の揃え（枠内）',
          select(
            s.valign ?? 'top',
            [
              ['top', '上揃え'],
              ['middle', '上下中央'],
              ['bottom', '下揃え'],
            ],
            (value) => {
              if (value === 'top') delete s.valign;
              else s.valign = value;
            },
          ),
        ),
        row(
          '空欄のとき',
          select(s.required ? 'yes' : 'no', [['no', '何もしない'], ['yes', '警告する（必須）']], (value) => (s.required = value === 'yes')),
        ),
      );
    }
    if (block.type === 'line') {
      rows.push(
        row('始点 x', input('number', num(el, 'x1'), setAttr(el, 'x1'), { step: 1 })),
        row('始点 y', input('number', num(el, 'y1'), setAttr(el, 'y1'), { step: 1 })),
        row('終点 x', input('number', num(el, 'x2'), setAttr(el, 'x2'), { step: 1 })),
        row('終点 y', input('number', num(el, 'y2'), setAttr(el, 'y2'), { step: 1 })),
        row('太さ', input('number', num(el, 'stroke-width', 1), setAttr(el, 'stroke-width'), { min: 0.1, step: 0.5 })),
        colorRow('色', el, 'stroke', '#1a1a1a'),
      );
    }
    if (block.type === 'rect') {
      rows.push(
        row('横位置 x', input('number', num(el, 'x'), setAttr(el, 'x'), { step: 1 })),
        row('縦位置 y', input('number', num(el, 'y'), setAttr(el, 'y'), { step: 1 })),
        row('幅', input('number', num(el, 'width'), setAttr(el, 'width'), { min: 0, step: 1 })),
        row('高さ', input('number', num(el, 'height'), setAttr(el, 'height'), { min: 0, step: 1 })),
        colorRow('塗りの色', el, 'fill', '#ffffff'),
      );
    }
    if (block.type === 'image') {
      const reference = el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '';
      const embedded = reference.startsWith('data:');
      const source = el.getAttribute('data-source-name');
      rows.push(
        row('選択したファイル / URL', h('code', { style: 'overflow-wrap:anywhere' },
          embedded ? (source || '元ファイル名は記録されていません') : reference)),
        h('div', { class: 'sub' }, embedded
          ? 'テンプレート内に埋め込み済み（元の保存場所への参照は不要です）。'
          : '外部参照です。相対パスはテンプレートの配置場所を基準に確認してください。'),
        row('横位置 x', input('number', num(el, 'x'), setAttr(el, 'x'), { step: 1 })),
        row('縦位置 y', input('number', num(el, 'y'), setAttr(el, 'y'), { step: 1 })),
        row('幅', input('number', num(el, 'width'), setAttr(el, 'width'), { min: 1, step: 1 })),
        row('高さ', input('number', num(el, 'height'), setAttr(el, 'height'), { min: 1, step: 1 })),
        h('div', { class: 'prop' }, h('span', {}, '画像'), imageButton('画像を差し替える', (image) => replaceImage(block, image))),
        h('div', { class: 'sub' }, '画像は枠の中に、縦横比を保って収まるように表示されます。'),
      );
    }
    return h(
      'div',
      { class: 'props' },
      h('div', { class: 'label' }, labelOf(block)),
      rows,
      !(block.type === 'rect' && block.background) &&
        h(
          'div',
          { class: 'prop' },
          h('span', {}, '用紙に揃える'),
          h(
            'span',
            { class: 'align' },
            [
              ['left', '左'],
              ['center', '中央'],
              ['right', '右'],
              ['top', '上'],
              ['middle', '中'],
              ['bottom', '下'],
            ].map(([mode, label]) => h('button', { class: 'btn', type: 'button', onclick: () => align(block, mode) }, label)),
          ),
        ),
      h(
        'div',
        { class: 'actions tight' },
        h('button', { class: 'btn', type: 'button', onclick: () => reorder(block, 1) }, '手前へ'),
        h('button', { class: 'btn', type: 'button', onclick: () => reorder(block, -1) }, '奥へ'),
        h('button', { class: 'btn', type: 'button', title: 'Ctrl+D', onclick: () => duplicate(block) }, '複製'),
        h('button', { class: 'btn btn-danger', type: 'button', title: 'Delete', onclick: () => remove(block) }, '削除'),
      ),
    );
  }

  /** 用紙サイズの単位。px（または単位なし）ならピクセル、それ以外はミリメートルとして扱う。 */
  const unitOf = () => (/^\s*[0-9.]+\s*(px)?\s*$/.test(String(meta.width ?? '')) ? 'px' : 'mm');
  /** 用紙の1mm（または1px）が、位置や大きさの数値でいくつに当たるか。 */
  const unitsPer = (unit) => (unit === 'px' ? 1 : 10);

  function setCanvas(unit, width, height) {
    meta.width = `${width}${unit}`;
    meta.height = `${height}${unit}`;
    root.setAttribute('width', meta.width);
    root.setAttribute('height', meta.height);
    const next = { w: round(width * unitsPer(unit), 1), h: round(height * unitsPer(unit), 1) };
    // 背景は用紙サイズに合わせて伸縮させる
    for (const block of blocks()) {
      if (block.type !== 'rect' || !block.background) continue;
      block.el.setAttribute('width', String(next.w));
      block.el.setAttribute('height', String(next.h));
    }
    root.setAttribute('viewBox', `0 0 ${next.w} ${next.h}`);
  }

  /** すべてのブロックの位置・大きさ・文字サイズを factor 倍する（単位を切り替えても見た目を保つため）。 */
  function rescale(factor) {
    const all = blocks();
    for (const { el } of all) {
      for (const name of ['x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'font-size', 'stroke-width', 'letter-spacing']) {
        if (el.hasAttribute(name)) el.setAttribute(name, String(round(num(el, name) * factor, 2)));
      }
    }
    for (const field of Object.values(meta.fields)) {
      for (const name of ['fontSize', 'minFontSize', 'maxWidth']) {
        if (typeof field[name] === 'number') field[name] = round(field[name] * factor, 2);
      }
    }
  }

  /** 用紙サイズ（mm / px）とフォント。 */
  function canvasSettings() {
    const box = viewBox();
    const unit = unitOf();
    const size = (key, fallback) => {
      const mm = toMm(meta[key]);
      if (!Number.isFinite(mm)) return fallback;
      return unit === 'px' ? Math.round((mm / 25.4) * 96) : round(mm, 1);
    };
    const current = { width: size('width', box.w / unitsPer(unit)), height: size('height', box.h / unitsPer(unit)) };
    const resize = (key) => (value) => {
      if (!Number.isFinite(value) || value <= 0) return;
      current[key] = value;
      setCanvas(unit, current.width, current.height);
    };
    const changeUnit = (next) => {
      if (next === unit) return;
      // 実寸を保ったまま単位を変える（96px = 1インチ = 25.4mm）
      const convert = (value) => (next === 'px' ? Math.round((value / 25.4) * 96) : round((value * 25.4) / 96, 1));
      const before = viewBox();
      setCanvas(next, convert(current.width), convert(current.height));
      rescale(viewBox().w / before.w);
    };
    const changeFonts = (primary, spare) => {
      const before = (meta.fonts ?? [])[0];
      meta.fonts = [primary, spare].filter(Boolean);
      // 「用紙のフォントと同じ」になっている固定の文字も、新しいフォントに合わせる
      for (const block of blocks()) {
        if (block.type !== 'text') continue;
        const own = firstFamily(block.el.getAttribute('font-family'));
        if (!own || own === before) block.el.setAttribute('font-family', paperFontFamily());
      }
    };
    const [primary = '', spare = ''] = meta.fonts ?? [];
    const background = backgroundBlock();
    const backgroundColor = background?.el.getAttribute('fill') ?? '#ffffff';
    return h(
      'div',
      { class: 'props' },
      h('div', { class: 'label' }, '用紙'),
      row('単位', select(unit, [['mm', 'mm（印刷向け）'], ['px', 'px（画像・画面向け）']], changeUnit)),
      row(`幅 (${unit})`, input('number', current.width, resize('width'), { min: 1, step: 1 })),
      row(`高さ (${unit})`, input('number', current.height, resize('height'), { min: 1, step: 1 })),
      row(
        '背景',
        select(background ? 'color' : 'none', [['color', '色を塗る'], ['none', '透明（背景なし）']], (value) =>
          setBackground(value === 'color' ? '#ffffff' : null),
        ),
      ),
      background &&
        row(
          '背景色',
          h(
            'span',
            { class: 'color' },
            input('color', /^#[0-9a-f]{6}$/i.test(backgroundColor) ? backgroundColor : '#ffffff', setBackground),
            input('text', backgroundColor, (value) => setBackground(value || '#ffffff')),
          ),
        ),
      row('フォント', select(primary, fontOptions(primary, fonts.length ? null : '（一覧を取得できません）'), (value) => changeFonts(value, spare))),
      row(
        '予備のフォント',
        select(spare, fontOptions(spare, '指定しない'), (value) => changeFonts(primary, value)),
      ),
      h(
        'div',
        { class: 'sub' },
        unit === 'px'
          ? `位置や大きさの数値は、用紙の左上を原点としたピクセルです（${box.w} × ${box.h}）。PNGはこの画素数で出力されます。`
          : `位置や大きさの数値は、用紙の左上を原点とした単位です（${box.w} × ${box.h}。10 で 1mm）。`,
      ),
      h('div', { class: 'sub' }, '予備のフォントは、1つ目のフォントがPCに無い場合に使われます。'),
    );
  }

  // ---- HTML / CSS の生成 ----------------------------------------------------

  /** HTML出力をブロックの配置に連動させるか（template.json の "htmlFromBlocks"。既定は連動する）。 */
  const htmlLinked = () => meta.htmlFromBlocks !== false;

  /**
   * 現在のブロックの配置から、HTML出力用の template.html / template.css を作る。
   * SVGと同じ位置・大きさ（mm）で絶対配置する。
   *
   * 文字の縦位置は、SVGと同じく「1行目の文字の下端（ベースライン）」で合わせる。
   * 高さの決まった見えない支柱（.s）と文字を、下端揃えで横に並べることで、
   * フォントが変わってもベースラインの位置が動かないようにしている。
   */
  function buildHtml() {
    const box = viewBox();
    const widthMm = toMm(meta.width) || box.w / 10;
    const unit = widthMm / box.w;
    const mm = (value) => `${round(value * unit, 3)}mm`;
    const families = [...(meta.fonts ?? []), ...(meta.fallbackFonts ?? [])];
    const fontList = (names) => [...names.map((name) => `"${name}"`), 'sans-serif'].join(', ');
    const background = backgroundBlock();
    const html = [];
    const css = [
      `.caption {\n  background: ${background ? (background.el.getAttribute('fill') ?? '#ffffff') : 'transparent'};\n  color: #1a1a1a;\n  font-family: ${fontList(families)};\n}`,
      '.caption .b {\n  position: absolute;\n  margin: 0;\n}',
      '.caption .t {\n  display: flex;\n  align-items: baseline;\n}',
      '.caption .s {\n  flex: none;\n  width: 0;\n}',
      '.caption .t p {\n  flex: 1;\n  min-width: 0;\n  margin: 0;\n}',
      '.caption .v {\n  display: flex;\n  flex-direction: column;\n}',
    ];

    blocks().forEach((block, index) => {
      const { el } = block;
      const name = `b${index + 1}`;
      if (block.type === 'rect') {
        if (block.background) return;
        html.push(`<div class="b ${name}"></div>`);
        css.push(
          `.${name} {\n  left: ${mm(num(el, 'x'))};\n  top: ${mm(num(el, 'y'))};\n  width: ${mm(num(el, 'width'))};\n  height: ${mm(num(el, 'height'))};\n  background: ${el.getAttribute('fill') ?? '#ffffff'};\n}`,
        );
        return;
      }
      if (block.type === 'image') {
        html.push(`<img class="b ${name}" alt="" src="${el.getAttribute('href') ?? ''}">`);
        css.push(
          `.${name} {\n  left: ${mm(num(el, 'x'))};\n  top: ${mm(num(el, 'y'))};\n  width: ${mm(num(el, 'width'))};\n  height: ${mm(num(el, 'height'))};\n  object-fit: contain;\n}`,
        );
        return;
      }
      if (block.type === 'line') {
        const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((key) => num(el, key));
        const thickness = num(el, 'stroke-width', 1);
        const angle = round((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI, 2);
        html.push(`<div class="b ${name}"></div>`);
        css.push(
          `.${name} {\n  left: ${mm(x1)};\n  top: ${mm(y1 - thickness / 2)};\n  width: ${mm(Math.hypot(x2 - x1, y2 - y1))};\n  height: ${mm(thickness)};\n  background: ${el.getAttribute('stroke') ?? '#1a1a1a'};` +
            (angle ? `\n  transform: rotate(${angle}deg);\n  transform-origin: 0 50%;` : '') +
            '\n}',
        );
        return;
      }

      // 文字（項目・固定の文字）
      const size = fontSizeOf(block);
      const s = block.type === 'field' ? spec(block) : {};
      const lineHeight = block.type === 'field' ? (s.lineHeight ?? 1.5) : 1.5;
      const frame = boxOf(block);
      const anchor = el.getAttribute('text-anchor') ?? 'start';
      const shared = [
        `left: ${mm(frame.x)};`,
        `width: ${mm(frame.w)};`,
        `font-size: ${mm(size)};`,
        `line-height: ${lineHeight};`,
        `color: ${el.getAttribute('fill') ?? '#1a1a1a'};`,
      ];
      const own = block.type === 'field' ? s.fontFamily : firstFamily(el.getAttribute('font-family'));
      if (own && own !== families[0]) shared.push(`font-family: ${fontList([own, ...families])};`);
      if (s.fontWeight) shared.push(`font-weight: ${s.fontWeight};`);
      if (el.getAttribute('letter-spacing')) shared.push(`letter-spacing: ${mm(num(el, 'letter-spacing'))};`);

      const inner = [];
      if (anchor !== 'start') inner.push(`text-align: ${anchor === 'middle' ? 'center' : 'right'};`);
      let content;
      const maxLines = s.maxLines ?? 1;
      if (block.type === 'field') {
        // 最大行数を超えた分は表示しない
        inner.push('white-space: pre-line;', 'overflow-wrap: anywhere;', 'overflow: hidden;', `max-height: ${round(maxLines * lineHeight, 3)}em;`);
        content = `{{${block.name}}}`;
      } else {
        inner.push('white-space: nowrap;');
        content = escapeHtml(el.textContent.trim());
      }

      if (block.type === 'field' && (s.valign === 'middle' || s.valign === 'bottom')) {
        // 上下中央・下揃え: 最大行数ぶんの高さの枠を置き、その中で文字を上下に寄せる。
        // 枠の中心が、SVGでの「最大行数ぶんの文字の中心」と同じ位置になるようにしている
        const top = num(el, 'y') - size * (0.38 + lineHeight / 2);
        html.push(`<div class="b v ${name}"><p>${content}</p></div>`);
        css.push(
          `.${name} {\n  ${[`top: ${mm(top)};`, `height: ${mm(maxLines * lineHeight * size)};`, `justify-content: ${s.valign === 'middle' ? 'center' : 'flex-end'};`, ...shared].join('\n  ')}\n}`,
        );
        css.push(`.${name} p {\n  ${['margin: 0;', ...inner].join('\n  ')}\n}`);
        return;
      }

      // 上揃え: 支柱の高さの分だけ上から始め、支柱の下端（＝1行目のベースライン）を y に合わせる
      const strut = size * 2;
      html.push(`<div class="b t ${name}"><span class="s"></span><p>${content}</p></div>`);
      css.push(`.${name} {\n  ${[`top: ${mm(num(el, 'y') - strut)};`, ...shared].join('\n  ')}\n}`);
      css.push(`.${name} .s {\n  height: ${mm(strut)};\n}`);
      css.push(`.${name} p {\n  ${inner.join('\n  ')}\n}`);
    });

    return { html: html.join('\n') + '\n', css: css.join('\n\n') + '\n' };
  }

  // ---- 描画 -----------------------------------------------------------------

  const list = h('div', { class: 'block-list' });
  const detail = h('div', {});

  function drawList() {
    const all = blocks();
    list.replaceChildren(
      ...(all.length === 0 ? [h('div', { class: 'sub' }, 'ブロックがありません。下のボタンから追加してください。')] : []),
      // 手前にあるものを上に表示する
      ...all
        .slice()
        .reverse()
        .map((block) =>
          h(
            'button',
            {
              type: 'button',
              class: block.el === selected ? 'block-item active' : 'block-item',
              onclick: () => {
                selected = block.el;
                draw();
              },
            },
            labelOf(block),
          ),
        ),
    );
  }

  function drawDetail() {
    const block = blocks().find((b) => b.el === selected);
    detail.replaceChildren(block ? properties(block) : canvasSettings());
  }

  // ---- プレビュー上での操作 -------------------------------------------------

  let snapEnabled = true;
  /** 吸着する距離（画面上のピクセル） */
  const SNAP_PIXELS = 6;

  /** 吸着先。用紙の端と中央、他のブロックの端と中央、文字のベースライン。 */
  function snapTargets(exclude) {
    const box = viewBox();
    const xs = [0, box.w / 2, box.w];
    const ys = [0, box.h / 2, box.h];
    for (const block of blocks()) {
      if (block.el === exclude || (block.type === 'rect' && block.background)) continue;
      const frame = boxOf(block);
      xs.push(frame.x, frame.x + frame.w / 2, frame.x + frame.w);
      ys.push(frame.y, frame.y + frame.h / 2, frame.y + frame.h);
      if (block.type === 'field' || block.type === 'text') ys.push(num(block.el, 'y'));
    }
    return { xs, ys };
  }

  /** values のいずれかが targets に threshold 以内まで近づいていれば、最も近い組み合わせを返す。 */
  function nearest(values, targets, threshold) {
    let best = null;
    for (const value of values) {
      for (const target of targets) {
        const delta = target - value;
        if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, at: target };
      }
    }
    return best;
  }

  function showGuides(xs, ys) {
    const box = viewBox();
    for (const guide of overlay.querySelectorAll('.guide')) guide.remove();
    for (const x of xs) overlay.append(h('div', { class: 'guide v', style: `left: ${(x / box.w) * 100}%` }));
    for (const y of ys) overlay.append(h('div', { class: 'guide h', style: `top: ${(y / box.h) * 100}%` }));
  }

  /**
   * ドラッグの共通処理。onMove には、押した位置からの移動量（用紙の単位）とイベントを渡す。
   * 動いた場合だけ onEnd(true) を呼ぶ。
   */
  function startDrag(event, element, onMove, onEnd) {
    event.preventDefault();
    event.stopPropagation();
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // ポインタを捕捉できなくても、要素の上でのドラッグは動作する
    }
    const scale = viewBox().w / overlay.getBoundingClientRect().width;
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    const move = (e) => {
      const dx = (e.clientX - start.x) * scale;
      const dy = (e.clientY - start.y) * scale;
      if (dx || dy) moved = true;
      onMove(dx, dy, e, SNAP_PIXELS * scale);
    };
    const up = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      showGuides([], []);
      onEnd(moved);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
  }

  function drawOverlay() {
    if (!root) {
      overlay.replaceChildren();
      return;
    }
    const box = viewBox();
    const place = (el, f) => {
      el.style.left = `${(f.x / box.w) * 100}%`;
      el.style.top = `${(f.y / box.h) * 100}%`;
      el.style.width = `${(f.w / box.w) * 100}%`;
      el.style.height = `${(f.h / box.h) * 100}%`;
    };
    const frames = new Map();

    const items = blocks()
      .filter((block) => !(block.type === 'rect' && block.background))
      .map((block) => {
        const frame = boxOf(block);
        const el = h('div', { class: block.el === selected ? 'frame active' : 'frame', title: labelOf(block) });
        place(el, frame);
        frames.set(block.el, el);
        el.addEventListener('pointerdown', (event) => {
          const targets = snapTargets(block.el);
          const isText = block.type === 'field' || block.type === 'text';
          const baseline = isText ? num(block.el, 'y') : null;
          let offset = { x: 0, y: 0 };
          startDrag(
            event,
            el,
            (rawX, rawY, e, threshold) => {
              let dx = rawX;
              let dy = rawY;
              // Shift: 水平または垂直にだけ動かす
              if (e.shiftKey) {
                if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
                else dx = 0;
              }
              const guides = { x: [], y: [] };
              if (snapEnabled && !e.altKey) {
                const lockX = e.shiftKey && dx === 0;
                const lockY = e.shiftKey && dy === 0;
                const sx = lockX ? null : nearest([frame.x + dx, frame.x + frame.w / 2 + dx, frame.x + frame.w + dx], targets.xs, threshold);
                const lines = [frame.y + dy, frame.y + frame.h / 2 + dy, frame.y + frame.h + dy];
                if (baseline !== null) lines.push(baseline + dy);
                const sy = lockY ? null : nearest(lines, targets.ys, threshold);
                if (sx) {
                  dx += sx.delta;
                  guides.x.push(sx.at);
                }
                if (sy) {
                  dy += sy.delta;
                  guides.y.push(sy.at);
                }
              }
              offset = { x: round(dx, 1), y: round(dy, 1) };
              place(el, { ...frame, x: frame.x + offset.x, y: frame.y + offset.y });
              showGuides(guides.x, guides.y);
            },
            (moved) => {
              selected = block.el;
              if (moved && (offset.x || offset.y)) {
                move(block, offset.x, offset.y);
                commit();
              }
              draw();
            },
          );
        });
        return el;
      });

    overlay.replaceChildren(...items, ...handlesFor(blocks().find((block) => block.el === selected), frames, place));
  }

  /** 選択中のブロックの、大きさを変えるためのつまみ。 */
  function handlesFor(block, frames, place) {
    if (!block || (block.type === 'rect' && block.background) || block.type === 'text') return [];
    // （項目・四角・画像・線につまみを出す。固定の文字は文字サイズで大きさが決まる）
    const box = viewBox();
    const { el } = block;
    const frameEl = frames.get(el);
    const targets = snapTargets(el);
    const handles = [];

    const handle = (x, y, cursor, onMove) => {
      const knob = h('div', { class: 'handle', style: `cursor: ${cursor}` });
      const put = (px, py) => {
        knob.style.left = `${(px / box.w) * 100}%`;
        knob.style.top = `${(py / box.h) * 100}%`;
      };
      put(x, y);
      knob.addEventListener('pointerdown', (event) =>
        startDrag(
          event,
          knob,
          (dx, dy, e, threshold) => {
            const point = onMove(dx, dy, e, threshold);
            put(point.x, point.y);
            place(frameEl, boxOf(block));
          },
          (moved) => {
            if (moved) commit();
            draw();
          },
        ),
      );
      handles.push(knob);
    };

    /** 点 (x, y) を吸着させる。ガイド線も表示する。 */
    const snapPoint = (x, y, e, threshold) => {
      if (!snapEnabled || e.altKey) {
        showGuides([], []);
        return { x, y };
      }
      const sx = nearest([x], targets.xs, threshold);
      const sy = nearest([y], targets.ys, threshold);
      showGuides(sx ? [sx.at] : [], sy ? [sy.at] : []);
      return { x: sx ? sx.at : x, y: sy ? sy.at : y };
    };

    if (block.type === 'rect' || block.type === 'image') {
      const origin = { x: num(el, 'x'), y: num(el, 'y'), w: num(el, 'width'), h: num(el, 'height') };
      // 四角は Shift で縦横比を保つ。画像は縦横比を保つのが既定で、Shift を押すと自由に変形する
      const keepRatio = (e) => (block.type === 'image' ? !e.shiftKey : e.shiftKey);
      handle(origin.x + origin.w, origin.y + origin.h, 'nwse-resize', (dx, dy, e, threshold) => {
        let width = Math.max(1, origin.w + dx);
        let height = Math.max(1, origin.h + dy);
        if (keepRatio(e) && origin.w > 0 && origin.h > 0) {
          const ratio = Math.max(width / origin.w, height / origin.h);
          width = origin.w * ratio;
          height = origin.h * ratio;
          showGuides([], []);
        } else {
          const corner = snapPoint(origin.x + width, origin.y + height, e, threshold);
          width = Math.max(1, corner.x - origin.x);
          height = Math.max(1, corner.y - origin.y);
        }
        el.setAttribute('width', String(round(width, 1)));
        el.setAttribute('height', String(round(height, 1)));
        return { x: origin.x + width, y: origin.y + height };
      });
    }

    if (block.type === 'field') {
      // 折り返す幅を変える。揃えの向きによって、広がる方向が異なる
      const frame = boxOf(block);
      const anchor = el.getAttribute('text-anchor') ?? 'start';
      const atLeft = anchor === 'end';
      const minimum = fontSizeOf(block);
      handle(atLeft ? frame.x : frame.x + frame.w, frame.y + frame.h / 2, 'ew-resize', (dx, _dy, e, threshold) => {
        const edge = snapPoint((atLeft ? frame.x : frame.x + frame.w) + dx, frame.y + frame.h / 2, e, threshold).x;
        const moved = edge - (atLeft ? frame.x : frame.x + frame.w);
        const width = Math.max(minimum, frame.w + (anchor === 'middle' ? 2 * moved : atLeft ? -moved : moved));
        spec(block).maxWidth = Math.round(width);
        const next = boxOf(block);
        return { x: atLeft ? next.x : next.x + next.w, y: next.y + next.h / 2 };
      });
    }

    if (block.type === 'line') {
      for (const [px, py, ox, oy] of [
        ['x1', 'y1', 'x2', 'y2'],
        ['x2', 'y2', 'x1', 'y1'],
      ]) {
        const origin = { x: num(el, px), y: num(el, py) };
        handle(origin.x, origin.y, 'move', (dx, dy, e, threshold) => {
          const other = { x: num(el, ox), y: num(el, oy) };
          let point = { x: origin.x + dx, y: origin.y + dy };
          if (e.shiftKey) {
            // Shift: もう一方の端点から見て、水平・垂直・45度の方向に固定する
            const length = Math.hypot(point.x - other.x, point.y - other.y);
            const step = Math.PI / 4;
            const angle = Math.round(Math.atan2(point.y - other.y, point.x - other.x) / step) * step;
            point = { x: other.x + Math.cos(angle) * length, y: other.y + Math.sin(angle) * length };
            showGuides([], []);
          } else {
            point = snapPoint(point.x, point.y, e, threshold);
          }
          el.setAttribute(px, String(round(point.x, 1)));
          el.setAttribute(py, String(round(point.y, 1)));
          return point;
        });
      }
    }
    return handles;
  }

  function draw() {
    if (problem) {
      panel.replaceChildren(h('ul', { class: 'notes' }, h('li', { class: 'note-warning' }, problem)));
      overlay.replaceChildren();
      return;
    }
    const used = new Set(blocks().filter((b) => b.type === 'field').map((b) => b.name));
    const free = VARIABLES.filter(([name]) => !used.has(name));
    const picker = h('select', { 'aria-label': '追加する列' }, free.map(([name, label]) => h('option', { value: name }, label)));

    drawList();
    drawDetail();
    drawOverlay();
    updateHistoryButtons();
    panel.replaceChildren(
      h('div', { class: 'actions tight' }, undoButton, redoButton, h('span', { class: 'sub' }, 'Ctrl+Z / Ctrl+Shift+Z')),
      h('details', { class: 'external-references', open: true },
        h('summary', {}, '外部ファイル・URLの参照'),
        window.templateReferences(files).length
          ? h('ul', {}, window.templateReferences(files).map(({ origin, value }) =>
              h('li', {}, h('span', { class: 'sub' }, origin + ': '), h('code', {}, value))))
          : h('div', { class: 'sub' }, '外部参照はありません（埋め込み画像は外部ファイルを参照しません）。'),
      ),
      h(
        'div',
        { class: 'blocks-main' },
        h(
          'div',
          { class: 'blocks-side' },
          h('div', { class: 'label' }, 'ブロック（上ほど手前）'),
          list,
          h(
            'button',
            {
              class: selected ? 'block-item' : 'block-item active',
              type: 'button',
              onclick: () => {
                selected = null;
                draw();
              },
            },
            '用紙の設定',
          ),
        ),
        detail,
      ),
      h(
        'div',
        { class: 'actions tight' },
        free.length > 0 && picker,
        free.length > 0 && h('button', { class: 'btn', type: 'button', onclick: () => addField(picker.value) }, '＋ 項目'),
        h('button', { class: 'btn', type: 'button', onclick: addText }, '＋ 文字'),
        h('button', { class: 'btn', type: 'button', onclick: addLine }, '＋ 線'),
        h('button', { class: 'btn', type: 'button', onclick: addRect }, '＋ 四角'),
        imageButton('＋ 画像', addImage),
      ),
      h(
        'div',
        { class: 'sub' },
        h(
          'label',
          { class: 'snap' },
          h('input', {
            type: 'checkbox',
            checked: htmlLinked(),
            onchange: (event) => {
              if (event.target.checked) delete meta.htmlFromBlocks;
              else meta.htmlFromBlocks = false;
              commit();
              draw();
            },
          }),
          ' HTML出力もこの配置にする（template.html / template.css を自動で作る）',
        ),
        !htmlLinked() && h('div', {}, 'いまは連動していません。template.html / template.css は、コードのタブで編集した内容がそのまま使われます。'),
      ),
      h(
        'div',
        { class: 'sub' },
        h(
          'label',
          { class: 'snap' },
          h('input', { type: 'checkbox', checked: snapEnabled, onchange: (event) => (snapEnabled = event.target.checked) }),
          ' スナップ（ほかのブロックや用紙の端・中央に吸着）',
        ),
        h('div', {}, 'Shift + ドラッグ: 水平・垂直に移動 / Alt + ドラッグ: 吸着しない / 矢印キー: 1ずつ移動（Shift で 10）'),
        h('div', {}, 'Delete: 削除 / Ctrl+D: 複製 / Esc: 選択を解除 / 選択中のつまみ: 大きさ・幅・線の端点を変更'),
      ),
    );
  }

  return {
    /** 「ブロック」タブの中身 */
    panel,
    /** プレビューの上に重ねる、ドラッグ用の枠 */
    overlay,
    /** コードのタブで編集された内容を読み直す */
    reload() {
      load();
      record(); // コードのタブでの編集も、1回分の操作として履歴に残す
      draw();
    },
    /** HTML出力がブロックの配置に連動しているか。 */
    isHtmlLinked() {
      try {
        return JSON.parse(files.json).htmlFromBlocks !== false;
      } catch {
        return false;
      }
    },
    /**
     * HTML出力とブロックの連動を止める。template.html / template.css を直接編集したときに呼ぶ
     * （連動したままだと、次にブロックを動かしたときに上書きされてしまうため）。
     */
    unlinkHtml() {
      try {
        const current = JSON.parse(files.json);
        current.htmlFromBlocks = false;
        files.json = JSON.stringify(current, null, 2) + '\n';
      } catch {
        // template.json が編集途中で壊れている場合は何もしない
      }
    },
    /**
     * キー操作を処理する。処理した場合は true を返す。
     * Ctrl+Z: 元に戻す / Ctrl+Shift+Z・Ctrl+Y: やり直す
     */
    handleKey(event) {
      if (event.altKey) return false;
      const key = event.key.toLowerCase();
      const command = event.ctrlKey || event.metaKey;
      // 入力欄で文字を打っている間は、矢印キーや Delete を入力欄の操作として扱う
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
      const block = blocks().find((b) => b.el === selected);
      const movable = block && !(block.type === 'rect' && block.background);
      const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };

      if (command && key === 'z' && !event.shiftKey) undo();
      else if (command && ((key === 'z' && event.shiftKey) || key === 'y')) redo();
      else if (typing || problem) return false;
      else if (command && key === 'd' && block) duplicate(block);
      else if (!command && (key === 'delete' || key === 'backspace') && block) remove(block);
      else if (!command && key === 'escape' && selected) {
        selected = null;
        draw();
      } else if (!command && arrows[key] && movable) {
        const step = event.shiftKey ? 10 : 1;
        move(block, arrows[key][0] * step, arrows[key][1] * step);
        commit(nudgeTag);
        draw();
      } else return false;
      event.preventDefault();
      return true;
    },
  };
};
