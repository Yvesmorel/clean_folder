import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../sidecar/store.mjs';
import { Service } from '../sidecar/service.mjs';

export async function startDevBridge({ directory = path.join(process.cwd(), '.dev-data'), dependencies = {}, port = 0 } = {}) {
  const store = await new Store(directory).init(); const clients = new Set();
  const token = randomBytes(32).toString('hex');
  const service = new Service(store, (event, data) => { for (const client of clients) client.write(`data: ${JSON.stringify({ event, data })}\n\n`); }, dependencies);
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin)) { res.writeHead(403); res.end(); return; }
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Clean-Token'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    if ((req.headers['x-clean-token'] ?? url.searchParams.get('token')) !== token) { res.writeHead(403); res.end(); return; }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(': connected\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/health') { res.end(JSON.stringify({ ok: true })); return; }
    if (url.pathname !== '/rpc' || req.method !== 'POST') { res.writeHead(404); res.end('{}'); return; }
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 2_000_000) throw new Error('Request too large.'); }
      const request = JSON.parse(body); const result = await service.handle(request.method, request.args); res.end(JSON.stringify({ result }));
    } catch (error) { res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { service, store, token, url: `http://127.0.0.1:${server.address().port}`, async close() {
    for (const client of clients) client.end(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  } };
}
async function main() {
  const bridge = await startDevBridge();
  const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit',
    env: { ...process.env, VITE_DEV_BRIDGE: bridge.url, VITE_DEV_TOKEN: bridge.token } });
  console.log('Development UI uses the real engine. Local database: .dev-data');
  const close = async () => { vite.kill(); await bridge.close(); process.exit(0); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exitCode = 1; });
