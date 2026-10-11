import readline from 'node:readline';
import { Store } from './store.mjs';
import { Service } from './service.mjs';
const send = (data) => process.stdout.write(`${JSON.stringify(data)}\n`);
async function main() {
  const bootstrap = process.argv.includes('--bootstrap');
  const store = await new Store().init();
  const service = new Service(store, (event, data) => {
    if (bootstrap) {
      if (event === 'log') console.log(`${data.level.toUpperCase()}: ${data.message}`);
      if (event === 'download') console.log(`${data.model ?? 'Ollama'}: ${data.status}${data.percent === null ? '' : ` ${data.percent}%`}`);
    } else send({ event, data });
  });
  if (bootstrap) { await service.handle('setup_runtime'); return; }
  if (!process.argv.includes('--serve')) throw new Error('Use --serve or --bootstrap.');
  // Parent process owns the lifetime. No HTTP port exists in the shipped application.
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (line.length > 2_000_000) { send({ id: null, error: 'IPC message is too large.' }); return; }
    let request;
    try { request = JSON.parse(line); if (typeof request.id !== 'string' || typeof request.method !== 'string') throw new Error('Invalid IPC request.'); }
    catch (error) { send({ id: request?.id ?? null, error: error.message }); return; }
    service.handle(request.method, request.args).then((result) => send({ id: request.id, result }))
      .catch((error) => send({ id: request.id, error: error.message }));
  });
  lines.on('close', () => process.exit(0));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
