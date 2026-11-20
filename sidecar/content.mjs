import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const textExtensions = new Set(['.txt', '.md', '.csv', '.tsv', '.log', '.json', '.xml', '.html', '.htm']);
export const CONTENT_LIMITS = Object.freeze({ bytes: 8_000_000, textBytes: 24_000, words: 80, characters: 600, timeoutMs: 8000 });
export function shortExcerpt(text) {
  return text.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().split(' ').slice(0, CONTENT_LIMITS.words).join(' ').slice(0, CONTENT_LIMITS.characters);
}
async function parseDocument(data, extension, signal) {
  signal?.throwIfAborted();
  // The build embeds this worker's dependencies so packaged apps need no external Node.js.
  const worker = typeof __CONTENT_WORKER_SOURCE__ === 'string'
    ? new Worker(__CONTENT_WORKER_SOURCE__, { eval: true, workerData: { data, extension }, stdout: true, stderr: true })
    : new Worker(new URL('./content-worker.mjs', import.meta.url), { workerData: { data, extension }, stdout: true, stderr: true });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, text) => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      worker.terminate().catch(() => {});
      error ? reject(error) : resolve(text);
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error('Reading timed out: grouping by filename.')), CONTENT_LIMITS.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (result) => finish(result.error ? new Error(result.error) : null, result.text));
    worker.once('error', (error) => finish(error));
    worker.once('exit', () => { if (!finished) finish(new Error('Reading interrupted.')); });
    if (signal?.aborted) abort();
  });
}
export async function readContentHint(root, file, { signal } = {}) {
  signal?.throwIfAborted();
  const extension = path.extname(file.name).toLowerCase();
  if (!textExtensions.has(extension) && !['.pdf', '.docx'].includes(extension)) return { text: '', status: 'unsupported' };
  let handle;
  try {
    const location = path.join(root, file.name);
    const before = await fs.lstat(location);
    if (!before.isFile() || before.isSymbolicLink() || path.dirname(await fs.realpath(location)) !== root) throw new Error('The file was replaced while reading.');
    handle = await fs.open(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const same = (stat) => stat.isFile() && ['dev', 'ino', 'size', 'mtimeMs'].every((key) => stat[key] === file[key]);
    const stat = await handle.stat();
    if (!same(stat)) throw new Error('The file changed while reading.');
    const isText = textExtensions.has(extension);
    if (!isText && stat.size > CONTENT_LIMITS.bytes) return { text: '', status: 'too-large' };
    const data = Buffer.alloc(Math.min(stat.size, isText ? CONTENT_LIMITS.textBytes : CONTENT_LIMITS.bytes));
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    signal?.throwIfAborted();
    if (!same(await handle.stat())) throw new Error('The file changed while reading.');
    let text;
    if (isText) {
      const input = data.subarray(0, bytesRead);
      text = input[0] === 0xff && input[1] === 0xfe ? input.subarray(2).toString('utf16le') : input.toString('utf8');
      if (text.includes('\0')) return { text: '', status: 'unreadable' };
      if (['.xml', '.html', '.htm'].includes(extension)) text = text.replace(/<[^>]*>/g, ' ');
      text = shortExcerpt(text);
    } else text = await parseDocument(data.subarray(0, bytesRead), extension, signal);
    signal?.throwIfAborted();
    return { text, status: text ? 'read' : 'empty' };
  } catch {
    signal?.throwIfAborted();
    return { text: '', status: 'unreadable' };
  } finally { await handle?.close(); }
}
