/**
 * LABELSystem - Google スプレッドシート連携（Google Apps Script）
 *
 * スプレッドシートの内容をJSONで返すウェブアプリです。
 * LABELSystem のサーバがこのURLを読み取り、新しい行を作品として取り込みます。
 * 導入手順は docs/gas.md を参照してください。
 *
 * シートの1行目は列名にします（順不同・不要な列は無視されます）:
 *   title / user_display_name / user_id / comment / source_post_url / entry_number
 *   （「タイトル」「ユーザー名」「ユーザーID」「コメント」「元投稿URL」などの日本語名も可）
 */

/** 読み取るシート名。空文字にすると先頭のシートを使います。 */
const SHEET_NAME = 'entries';

/** 行を識別するためのID列の名前。無ければ自動で追加します。 */
const ID_COLUMN = 'id';

/**
 * 初回のみ実行: アクセス用トークンを生成してスクリプトプロパティへ保存します。
 * 実行ログに表示されたトークンを、LABELSystem の data/config.json の sheet.token に設定してください。
 */
function setupToken() {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('LABEL_TOKEN', token);
  Logger.log('sheet.token に設定する値: ' + token);
}

function doGet(e) {
  const expected = PropertiesService.getScriptProperties().getProperty('LABEL_TOKEN');
  const given = e && e.parameter ? e.parameter.token : '';
  if (!expected) return respond({ error: 'トークンが未設定です。setupToken を実行してください。' });
  if (given !== expected) return respond({ error: 'unauthorized' });

  try {
    return respond({ entries: readEntries() });
  } catch (error) {
    return respond({ error: String(error && error.message ? error.message : error) });
  }
}

function getSheet() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = SHEET_NAME ? book.getSheetByName(SHEET_NAME) : book.getSheets()[0];
  if (!sheet) throw new Error('シート「' + SHEET_NAME + '」が見つかりません。');
  return sheet;
}

/**
 * シートの全行を、列名をキーにしたオブジェクトの配列として返します。
 * ID列が空の行には新しいIDを書き込みます（同じ行を二重に取り込まないため）。
 */
function readEntries() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSheet();
    const lastRow = sheet.getLastRow();
    const lastColumn = sheet.getLastColumn();
    if (lastRow < 2 || lastColumn < 1) return [];

    const header = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(function (name) {
      return String(name).trim();
    });
    let idIndex = header.indexOf(ID_COLUMN);
    if (idIndex < 0) {
      idIndex = header.length;
      header.push(ID_COLUMN);
      sheet.getRange(1, idIndex + 1).setValue(ID_COLUMN);
    }

    const values = sheet.getRange(2, 1, lastRow - 1, header.length).getDisplayValues();
    const entries = [];
    values.forEach(function (row, i) {
      const hasContent = row.some(function (cell, column) {
        return column !== idIndex && String(cell).trim() !== '';
      });
      if (!hasContent) return;
      if (!row[idIndex]) {
        row[idIndex] = Utilities.getUuid();
        sheet.getRange(i + 2, idIndex + 1).setValue(row[idIndex]);
      }
      const entry = {};
      header.forEach(function (name, column) {
        if (name) entry[name] = row[column];
      });
      entries.push(entry);
    });
    return entries;
  } finally {
    lock.releaseLock();
  }
}

function respond(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
