/**
 * LABELSystem - スプレッドシート連携（Google Apps Script）
 *
 * 作品の一覧が入ったスプレッドシートを、LABELSystem（exe とブラウザ拡張）から
 * 「読む」「末尾へ1行追記する」ための窓口です。導入手順は docs/gas.md を参照してください。
 *
 * このスクリプトが行うのは次の2つだけです。既存の行を書き換えたり、列を追加したりはしません。
 *   - list   : 全行を読む（キャプションの出力用）
 *   - append : 新しい行を末尾へ追加する（Xからの取り込み用）
 */

/** 対象のシート名。空文字の場合は、いちばん左のシートを使います。 */
const SHEET_NAME = '';

/** 列の定義。シートの1行目（見出し）とこの順番で対応します。 */
const COLUMNS = [
  { key: 'no', header: 'No.' },
  { key: 'theme', header: 'テーマ' },
  { key: 'category', header: '部門' },
  { key: 'title', header: 'タイトル' },
  { key: 'username', header: 'ユーザ名' },
  { key: 'userid', header: 'ユーザID' },
  { key: 'comment', header: 'コメント' },
  { key: 'date', header: '投稿日' },
  { key: 'imageUrl', header: '画像url(GoogleDrive)' },
  { key: 'postUrl', header: '元投稿URL(Twitter)' },
  { key: 'award', header: '賞など' },
  { key: 'note', header: '備考' },
];

// ---- 初期設定 ----------------------------------------------------------------

/**
 * 初回のみ実行: アクセス用トークンを生成します。シートが空の場合は見出し行も作成します。
 * 実行ログに表示されたトークンを、LABELSystem とブラウザ拡張の設定へ入力してください。
 * 再実行するとトークンが新しくなります（シートのデータは変更しません）。
 */
function setup() {
  const sheet = getSheet();
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS.map(function (column) { return column.header; })]);
    sheet.setFrozenRows(1);
  }
  columnIndexes(sheet); // 見出しを確認する（不足していればここでエラーになる）
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('LABEL_TOKEN', token);
  Logger.log('LABELSystem へ入力するトークン: ' + token);
}

// ---- ウェブアプリの入口 ------------------------------------------------------

function doGet() {
  // データは返さない。URLが正しいかどうかの確認用。
  return respond({ ok: true, data: { name: 'label-system-sheet' } });
}

function doPost(e) {
  let request;
  try {
    request = JSON.parse(e.postData.contents);
  } catch (error) {
    return respond(failure('bad-request', 'リクエストをJSONとして解析できません。'));
  }

  const expected = PropertiesService.getScriptProperties().getProperty('LABEL_TOKEN');
  if (!expected) return respond(failure('not-initialized', 'setup を実行してください。'));
  if (request.token !== expected) return respond(failure('unauthorized', 'トークンが一致しません。'));

  const action = ACTIONS[request.action];
  if (!action) return respond(failure('unknown-action', '不明な操作です: ' + request.action));

  // 採番と重複判定を確実にするため、すべての操作を直列に実行する
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (error) {
    return respond(failure('busy', '他の操作が実行中です。少し待ってからやり直してください。'));
  }
  try {
    return respond({ ok: true, data: action(request) });
  } catch (error) {
    return respond(failure(error.labelCode || 'internal', String(error && error.message ? error.message : error)));
  } finally {
    lock.releaseLock();
  }
}

function respond(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

function failure(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

// ---- シートの読み書き --------------------------------------------------------

function getSheet() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = SHEET_NAME ? book.getSheetByName(SHEET_NAME) : book.getSheets()[0];
  if (!sheet) throw new Error('シート「' + SHEET_NAME + '」が見つかりません。');
  return sheet;
}

/** 見出しの表記ゆれ（空白・全角半角・大文字小文字）を吸収する。 */
function normalizeHeader(text) {
  return String(text)
    .replace(/\s/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/．/g, '.')
    .toLowerCase();
}

/** 各項目がシートの何列目にあるかを、1行目の見出しから調べる（0始まり）。 */
function columnIndexes(sheet) {
  const width = Math.max(sheet.getLastColumn(), 1);
  const header = sheet.getRange(1, 1, 1, width).getDisplayValues()[0].map(normalizeHeader);
  const indexes = {};
  COLUMNS.forEach(function (column) {
    const index = header.indexOf(normalizeHeader(column.header));
    if (index < 0) {
      const error = new Error('シートの1行目に、列「' + column.header + '」が見つかりません。');
      error.labelCode = 'bad-sheet';
      throw error;
    }
    indexes[column.key] = index;
  });
  return indexes;
}

function readRows(sheet, indexes) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getDisplayValues();
  const rows = [];
  values.forEach(function (cells, i) {
    const record = { row: i + 2 };
    let hasContent = false;
    COLUMNS.forEach(function (column) {
      record[column.key] = String(cells[indexes[column.key]] || '');
      if (record[column.key].trim() !== '') hasContent = true;
    });
    if (hasContent) rows.push(record);
  });
  return rows;
}

function postIdFromUrl(url) {
  const match = /\/status(?:es)?\/(\d+)/.exec(url || '');
  return match ? match[1] : '';
}

/**
 * 次の No. を決める。既存の No. のうち最大のものに 1 を足し、書式（接頭辞・桁数）はその行に合わせる。
 * 例: 「12」→「13」、「007」→「008」、「A-041」→「A-042」
 */
function nextNumber(rows) {
  let best = null;
  rows.forEach(function (row) {
    const match = /^(.*?)(\d+)$/.exec(String(row.no).trim());
    if (!match) return;
    const value = parseInt(match[2], 10);
    if (!best || value > best.value) best = { prefix: match[1], value: value, width: match[2].length };
  });
  if (!best) return '1';
  let digits = String(best.value + 1);
  while (digits.length < best.width) digits = '0' + digits;
  return best.prefix + digits;
}

/**
 * セルへ書き込む値。先頭に「'」を付けると、スプレッドシートはその値を文字列として扱う。
 * - 「=」「+」で始まる文字列: 数式として解釈されないようにする（投稿本文をそのまま保存するため）
 * - 「007」のような0で始まる数字: 数値の 7 へ変換されないようにする
 */
function encodeCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /^[=+]|^0\d+$/.test(text) ? "'" + text : text;
}

// ---- 操作 --------------------------------------------------------------------

const ACTIONS = {
  ping: function () {
    columnIndexes(getSheet());
    return { name: 'label-system-sheet' };
  },

  /** 全行を返す。 */
  list: function () {
    const sheet = getSheet();
    return { rows: readRows(sheet, columnIndexes(sheet)) };
  },

  /** 元投稿URLから、登録済みの行を探す。 */
  find: function (request) {
    const sheet = getSheet();
    const postId = postIdFromUrl(request.postUrl);
    if (!postId) return { row: null };
    const rows = readRows(sheet, columnIndexes(sheet));
    for (let i = 0; i < rows.length; i++) if (postIdFromUrl(rows[i].postUrl) === postId) return { row: rows[i] };
    return { row: null };
  },

  /**
   * 行を末尾へ追加する。No. は自動で振る。
   * 同じ投稿（元投稿URLの投稿IDが同じ）が既にある場合は追加せず、その行を返す。
   */
  append: function (request) {
    const sheet = getSheet();
    const indexes = columnIndexes(sheet);
    const rows = readRows(sheet, indexes);
    const added = [];
    const skipped = [];
    const width = sheet.getLastColumn();

    (request.rows || []).forEach(function (input, index) {
      const postId = postIdFromUrl(input.postUrl);
      if (postId) {
        for (let i = 0; i < rows.length; i++) {
          if (postIdFromUrl(rows[i].postUrl) === postId) {
            skipped.push({ index: index, reason: 'この投稿は既に登録されています。', existing: rows[i] });
            return;
          }
        }
      }
      const record = { row: sheet.getLastRow() + 1, no: nextNumber(rows) };
      const cells = [];
      for (let c = 0; c < width; c++) cells.push('');
      COLUMNS.forEach(function (column) {
        if (column.key !== 'no') record[column.key] = input[column.key] ? String(input[column.key]) : '';
        cells[indexes[column.key]] = encodeCell(record[column.key]);
      });
      if (sheet.getMaxRows() < record.row) sheet.insertRowsAfter(sheet.getMaxRows(), 50);
      sheet.getRange(record.row, 1, 1, width).setValues([cells]);
      rows.push(record);
      added.push(record);
    });
    return { added: added, skipped: skipped };
  },
};
