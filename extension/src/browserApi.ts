/**
 * Chrome（chrome.*）とFirefox（browser.*）の差を吸収する最小限のラッパ。
 * 本拡張が使うAPIは tabs.query / tabs.sendMessage / runtime.onMessage / storage.local のみ。
 */
import type { SheetSettings } from '../../src/sheet.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ext: any = g.browser ?? g.chrome;

export const EXTRACT_MESSAGE = 'label-system:extract';

/** この拡張機能に保存する設定。接続先と、前回入力したテーマ・部門。 */
export interface Stored {
  sheet: SheetSettings;
  theme: string;
  category: string;
}

export async function loadStored(): Promise<Stored> {
  const data = (await ext.storage.local.get(['sheet', 'theme', 'category'])) ?? {};
  return {
    sheet: { url: data.sheet?.url ?? '', token: data.sheet?.token ?? '' },
    theme: data.theme ?? '',
    category: data.category ?? '',
  };
}

export async function saveStored(values: Partial<Stored>): Promise<void> {
  await ext.storage.local.set(values);
}
