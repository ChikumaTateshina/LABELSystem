/**
 * Chrome（chrome.*）とFirefox（browser.*）の差を吸収する最小限のラッパ。
 * 本拡張が使うAPIは tabs.query / tabs.sendMessage / runtime.onMessage / storage.local のみ。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ext: any = g.browser ?? g.chrome;

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:38471';
export const EXTRACT_MESSAGE = 'label-system:extract';

export async function getServerUrl(): Promise<string> {
  const stored = await ext.storage.local.get('serverUrl');
  return (stored?.serverUrl as string | undefined) || DEFAULT_SERVER_URL;
}

export async function setServerUrl(url: string): Promise<void> {
  await ext.storage.local.set({ serverUrl: url.replace(/\/+$/, '') });
}
