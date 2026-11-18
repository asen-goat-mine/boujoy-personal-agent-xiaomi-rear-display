import {DISTRIBUTION} from './distribution.mjs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.BOUJOY_DATA || path.join(os.homedir(), 'Library/Application Support', DISTRIBUTION.dataDirectoryName);
export const PORT = Number(process.env.BOUJOY_PORT || DISTRIBUTION.port);
export const HOST = '127.0.0.1';
export const ORIGIN = `http://${HOST}:${PORT}`;
// Public releases use only their own local runtime and fresh memory directory.
export const LOCAL_HARNESS = path.join(ROOT, '.runtime/harness');
export const HARNESS = process.env.BOUJOY_HARNESS || LOCAL_HARNESS;
export const MEMORY_VAULT = process.env.BOUJOY_MEMORY_VAULT || path.join(os.homedir(), 'Documents', DISTRIBUTION.memoryDirectoryName);
export const MODEL = 'deepseek-flash';
export function prepareData() {
  for (const p of [DATA, 'artifacts', 'harness', 'browser', 'phone', 'logs'].map((p,i) => i ? path.join(DATA,p) : p)) fs.mkdirSync(p,{recursive:true,mode:0o700});
}
