/** ソースから起動する場合の入口（npm start）。 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from './config.ts';
import { reportFatal, start } from './start.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const uiDir = join(root, 'src', 'ui');
const ui = Object.fromEntries(readdirSync(uiDir).map((name) => [name, readFileSync(join(uiDir, name), 'utf8')]));

start(resolvePaths(root), ui).catch(reportFatal);
