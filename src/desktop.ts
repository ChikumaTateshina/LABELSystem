/**
 * OSとのやり取り。追加のライブラリは使わず、OSに標準で入っているものだけを呼び出す。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

function launch(command: string, args: string[]): boolean {
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** 既定のブラウザでURLを開く。シェルを経由しないため、URL中の記号がコマンドとして解釈されることはない。 */
export function openExternal(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const target = parsed.toString();
  return process.platform === 'win32'
    ? launch('rundll32', ['url.dll,FileProtocolHandler', target])
    : launch(process.platform === 'darwin' ? 'open' : 'xdg-open', [target]);
}

/** フォルダをOSのファイルマネージャで開く。 */
export function openFolder(directory: string): boolean {
  if (!existsSync(directory)) return false;
  return launch(process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open', [
    directory,
  ]);
}

const EXTRACT_ICON_SCRIPT = `
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Label -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern uint PrivateExtractIcons(string file, int index, int cx, int cy, IntPtr[] icons, uint[] ids, uint count, uint flags);'
$handles = New-Object IntPtr[] 1
$ids = New-Object uint32[] 1
$count = [Label.Native]::PrivateExtractIcons($env:LABEL_ICON_SOURCE, 0, 256, 256, $handles, $ids, 1, 0)
if ($count -gt 0 -and $handles[0] -ne [IntPtr]::Zero) { $bitmap = [System.Drawing.Icon]::FromHandle($handles[0]).ToBitmap() }
else { $bitmap = [System.Drawing.Icon]::ExtractAssociatedIcon($env:LABEL_ICON_SOURCE).ToBitmap() }
$bitmap.Save($env:LABEL_ICON_TARGET, [System.Drawing.Imaging.ImageFormat]::Png)
`;

/**
 * 実行ファイルのアイコンをPNGとして取り出す（Windowsのみ）。
 * ウィンドウ（タイトルバー・タスクバー）のアイコンを、exe のアイコンと同じものにするために使う。
 * パスは環境変数で渡し、コマンド文字列へは埋め込まない。
 */
export function extractIcon(executable: string, target: string): boolean {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', EXTRACT_ICON_SCRIPT], {
      stdio: 'ignore',
      timeout: 20_000,
      windowsHide: true,
      env: { ...process.env, LABEL_ICON_SOURCE: executable, LABEL_ICON_TARGET: target },
    });
    return existsSync(target);
  } catch {
    return false;
  }
}

/**
 * 起動できなかった理由を利用者へ伝える。
 * exe にはコンソールが無いため、Windows ではメッセージボックスを表示する。
 * 文言は環境変数で渡し、コマンド文字列へは埋め込まない。
 */
export function showError(message: string): void {
  console.error(message);
  if (process.platform !== 'win32' || process.stdout.isTTY) return;
  try {
    spawn(
      'powershell',
      [
        '-NoProfile',
        '-WindowStyle',
        'Hidden',
        '-Command',
        "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show($env:LABEL_MESSAGE, 'LABELSystem')",
      ],
      { stdio: 'ignore', detached: true, env: { ...process.env, LABEL_MESSAGE: message } },
    ).unref();
  } catch {
    // 表示できない場合は諦める
  }
}
