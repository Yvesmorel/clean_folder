import { isTauri } from '@tauri-apps/api/core';
import { Command } from '@tauri-apps/plugin-shell';
import { open } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
const subscribers = new Set(), pending = new Map();
let child, connection, stream, closed = false;
const notify = (event, data) => subscribers.forEach((fn) => fn(event, data));
const devUrl = import.meta.env.DEV ? import.meta.env.VITE_DEV_BRIDGE : null;
const token = import.meta.env.VITE_DEV_TOKEN;
export const desktop = isTauri();
export const subscribe = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
export async function connect() {
  if (connection) return connection;
  closed = false;
  connection = (async () => {
    if (desktop) {
      const command = Command.sidecar('binaries/clean-folder-worker', ['--serve']);
      command.stdout.on('data', (line) => {
        try {
          const message = JSON.parse(line);
          if (message.event) notify(message.event, message.data);
          else {
            const request = pending.get(message.id);
            if (request) { pending.delete(message.id); message.error ? request.reject(new Error(message.error)) : request.resolve(message.result); }
          }
        } catch { notify('bridge_error', 'The local engine returned an invalid message.'); }
      });
      command.stderr.on('data', (line) => notify('bridge_error', line));
      command.on('close', () => {
        if (!closed) notify('bridge_error', 'The local engine stopped. Restart Clean_folder to reconnect.');
        for (const request of pending.values()) request.reject(new Error('The local engine stopped.'));
        pending.clear();
      });
      child = await command.spawn();
    } else if (devUrl) {
      // Development only: the actual Node service, never mock UI data.
      stream = new EventSource(`${devUrl}/events?token=${encodeURIComponent(token)}`);
      stream.onmessage = (e) => { const { event, data } = JSON.parse(e.data); notify(event, data); };
      await fetch(`${devUrl}/health`, { headers: { 'X-Clean-Token': token } }).then((r) => { if (!r.ok) throw new Error('Development engine unavailable.'); });
    } else throw new Error('The desktop engine is unavailable. Open Clean_folder as a desktop app, or run npm run dev:browser for development.');
  })().catch((error) => { connection = null; throw error; });
  return connection;
}
export async function call(method, args = {}) {
  await connect();
  if (!desktop) {
    const response = await fetch(`${devUrl}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Clean-Token': token },
      body: JSON.stringify({ method, args }) });
    const data = await response.json(); if (data.error) throw new Error(data.error); return data.result;
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.write(`${JSON.stringify({ id, method, args })}\n`).catch((error) => { pending.delete(id); reject(error); });
  });
}
export async function chooseDirectories() {
  if (!desktop) return null;
  const result = await open({ directory: true, multiple: true, title: 'Choose directories to organize' });
  return result ? (Array.isArray(result) ? result : [result]) : [];
}
export async function revealDirectory(path) {
  if (!desktop) throw new Error('Opening File Explorer is available in the desktop app.');
  await openPath(path);
}
export async function disconnect() {
  closed = true; stream?.close(); if (child) await child.kill(); connection = null;
}
