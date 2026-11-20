import { validateShortcutPair } from './shortcut.js';
import { answerQuickRequest } from './quick-protocol.js';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Command } from '@tauri-apps/plugin-shell';
import { open } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
const subscribers = new Set(), pending = new Map();
let child, connection, stream, closed = false, engineStopped = false, sendTo, nativeListeners = [], reviewLocked = false;
const notify = (event, data) => subscribers.forEach((fn) => fn(event, data));
const devUrl = import.meta.env.DEV ? import.meta.env.VITE_DEV_BRIDGE : null;
const token = import.meta.env.VITE_DEV_TOKEN;
export const desktop = isTauri();
export const quickView = new URLSearchParams(location.search).get('quick') === '1';
export const subscribe = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
export async function connect() {
  if (connection) return connection;
  closed = false;
  engineStopped = false;
  connection = (async () => {
    if (desktop) {
      const { emitTo } = await import('@tauri-apps/api/event');
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      sendTo = emitTo;
      const window = getCurrentWebviewWindow();
      if (quickView) {
        nativeListeners.push(await window.listen('quick_result', ({ payload }) => {
          const request = pending.get(payload.id);
          if (!request) return;
          pending.delete(payload.id); clearTimeout(request.timer);
          payload.error ? request.reject(new Error(payload.error)) : request.resolve(payload.result);
        }));
        nativeListeners.push(await window.listen('engine_event', ({ payload }) => notify(payload.event, payload.data)));
        await new Promise((resolve, reject) => {
          let removeReady, finished = false;
          const finish = (error) => { if (finished) return; finished = true; clearInterval(ping); clearTimeout(timeout); removeReady?.(); error ? reject(error) : resolve(); };
          const ping = setInterval(() => emitTo('main', 'quick_ping', null).catch(() => {}), 500);
          const timeout = setTimeout(() => finish(new Error('Open the main window to reconnect the engine.')), 15000);
          window.listen('engine_ready', () => finish()).then((remove) => {
            if (finished) { remove(); return; }
            removeReady = remove; emitTo('main', 'quick_ping', null).catch((error) => finish(error));
          }).catch((error) => finish(error));
        });
        return;
      }
      nativeListeners.push(await window.listen('quick_request', async ({ payload }) => {
        const reply = await answerQuickRequest(payload, call, reviewLocked);
        if (reply) await emitTo('quick', 'quick_result', reply).catch(() => {});
      }));
      nativeListeners.push(await window.listen('quick_navigation', ({ payload }) => notify('navigate', payload)));
      nativeListeners.push(await window.listen('quick_ping', () => emitTo('quick', 'engine_ready', null).catch(() => {})));
      const command = Command.sidecar('binaries/clean-folder-worker', ['--serve']);
      command.stdout.on('data', (line) => {
        try {
          const message = JSON.parse(line);
          if (message.event) {
            notify(message.event, message.data);
            emitTo('quick', 'engine_event', { event: message.event, data: message.data }).catch(() => {});
          }
          else {
            const request = pending.get(message.id);
            if (request) { pending.delete(message.id); message.error ? request.reject(new Error(message.error)) : request.resolve(message.result); }
          }
        } catch { notify('bridge_error', 'The local engine returned an invalid message.'); }
      });
      command.stderr.on('data', (line) => notify('bridge_error', line));
      command.on('close', () => {
        engineStopped = true;
        if (!closed) notify('bridge_error', 'The local engine stopped. Restart Clean_folder to reconnect.');
        emitTo('quick', 'engine_event', { event: 'bridge_error', data: 'The local engine stopped. Restart Clean_folder.' }).catch(() => {});
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
  })().catch((error) => { nativeListeners.splice(0).forEach((remove) => remove()); connection = null; throw error; });
  return connection;
}
export async function call(method, args = {}) {
  await connect();
  if (desktop && !quickView && engineStopped) throw new Error('The local engine stopped. Restart Clean_folder to reconnect.');
  if (!desktop) {
    const response = await fetch(`${devUrl}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Clean-Token': token },
      body: JSON.stringify({ method, args }) });
    const data = await response.json(); if (data.error) throw new Error(data.error); return data.result;
  }
  const id = crypto.randomUUID();
  if (quickView) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The engine is not responding. Open Clean_folder to check the operation.')); }, method === 'get_state' ? 60000 : 24 * 60 * 60 * 1000);
      pending.set(id, { resolve, reject, timer });
      sendTo('main', 'quick_request', { id, method, args }).catch((error) => { clearTimeout(timer); pending.delete(id); reject(error); });
    });
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.write(`${JSON.stringify({ id, method, args })}\n`).catch((error) => { pending.delete(id); reject(error); });
  });
}
export async function configureApplicationShortcuts(settings) {
  const { visibility, quick } = validateShortcutPair(settings);
  if (desktop) await invoke('set_application_shortcuts', { visibility, quick });
}
export function setReviewLock(locked) { reviewLocked = locked; }
export async function saveApplicationSettings(settings, previous) {
  await configureApplicationShortcuts(settings);
  try { return await call('save_settings', { settings }); }
  catch (error) {
    try { await configureApplicationShortcuts(previous); }
    catch (rollback) { throw new Error(`${error.message} Could not restore the previous shortcut: ${rollback.message}`); }
    throw error;
  }
}
export async function chooseDirectories({ multiple = true } = {}) {
  if (!desktop) return null;
  const result = await open({ directory: true, multiple, title: 'Choose a folder to organize' });
  return result ? (Array.isArray(result) ? result : [result]) : [];
}
export async function revealDirectory(path) {
  if (!desktop) throw new Error('Opening File Explorer is available in the desktop app.');
  await openPath(path);
}
export async function openQuickAccess() {
  if (desktop) return invoke('open_quick_access');
  return window.open(new URL('?quick=1', location.href), 'clean-folder-quick', 'width=460,height=620');
}
export async function hideQuickAccess() {
  if (desktop) return invoke('hide_quick_access');
  window.close();
}
export async function openMainWorkspace(page = 'organize') {
  if (desktop) {
    await sendTo('main', 'quick_navigation', page);
    return invoke('open_main_workspace');
  }
  if (window.opener) { window.opener.postMessage({ type: 'clean-folder-navigate', page }, location.origin); window.opener.focus(); }
}
export async function disconnect() {
  closed = true; stream?.close(); nativeListeners.splice(0).forEach((remove) => remove());
  if (child && !engineStopped) await child.kill(); connection = null;
}
export async function prepareShutdown() {
  if (!desktop) return call('shutdown');
  if (connection) await connection.catch(() => {});
  if (!child || engineStopped) return;
  try { await call('shutdown'); }
  catch (error) { if (!engineStopped) throw error; }
}
