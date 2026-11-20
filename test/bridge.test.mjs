import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('native quick access shares one sidecar, receives events and protects unsaved edits', async () => {
  const previousLocation = globalThis.location, previousHost = globalThis.__bridgeHost;
  const handlers = new Map();
  let label = 'main', spawns = 0, kills = 0, stdout, close;
  const calls = [];
  const host = {
    isTauri: () => true,
    getWindow: () => {
      const ownLabel = label;
      return { listen: async (name, callback) => {
        const key = ownLabel + ':' + name;
        handlers.set(key, callback); return () => handlers.delete(key);
      } };
    },
    emitTo: async (target, name, payload) => { await handlers.get(target + ':' + name)?.({ payload }); },
    invoke: async () => {},
    command: {
      stdout: { on: (_, callback) => { stdout = callback; } }, stderr: { on: () => {} },
      on: (_, callback) => { close = callback; },
      spawn: async () => {
        spawns++;
        return { write: async (line) => {
          const request = JSON.parse(line); calls.push(request.method);
          stdout(JSON.stringify({ id: request.id, result: { ready: true, currentPlan: null } }));
        }, kill: async () => { kills++; close(); } };
      },
    },
  };
  globalThis.__bridgeHost = host;
  const bundle = await build({ entryPoints: ['src/bridge.js'], bundle: true, format: 'esm', platform: 'browser', write: false,
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_DEV_TOKEN': '""', 'import.meta.env.VITE_DEV_BRIDGE': '""' },
    plugins: [{ name: 'native-api-test', setup(plugin) {
      plugin.onResolve({ filter: /^@tauri-apps\// }, ({ path }) => ({ path, namespace: 'native-api-test' }));
      plugin.onLoad({ filter: /.*/, namespace: 'native-api-test' }, ({ path }) => {
        const body = path.endsWith('/core') ? 'export const isTauri = () => globalThis.__bridgeHost.isTauri(); export const invoke = (...args) => globalThis.__bridgeHost.invoke(...args);'
          : path.endsWith('/event') ? 'export const emitTo = (...args) => globalThis.__bridgeHost.emitTo(...args);'
          : path.endsWith('/webviewWindow') ? 'export const getCurrentWebviewWindow = () => globalThis.__bridgeHost.getWindow();'
          : path.endsWith('/plugin-shell') ? 'export const Command = { sidecar: () => globalThis.__bridgeHost.command };'
          : path.endsWith('/plugin-dialog') ? 'export const open = async () => [];'
          : 'export const openPath = async () => {};';
        return { contents: body, loader: 'js' };
      });
    } }],
  });
  const moduleURL = (name) => 'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text + '\n//' + name).toString('base64');
  let main, quick;
  try {
    globalThis.location = { search: '' }; main = await import(moduleURL('main')); await main.connect();
    label = 'quick'; globalThis.location = { search: '?quick=1' }; quick = await import(moduleURL('quick')); await quick.connect();
    assert.equal(spawns, 1);
    assert.deepEqual(await quick.call('get_state'), { ready: true, currentPlan: null });
    assert.deepEqual(calls, ['get_state']);
    const events = []; const remove = quick.subscribe((event, data) => events.push({ event, data }));
    stdout(JSON.stringify({ event: 'operation', data: 'analysis' }));
    assert.deepEqual(events, [{ event: 'operation', data: 'analysis' }]); remove();
    main.setReviewLock(true);
    await assert.rejects(quick.call('apply_plan', { planId: 'draft', revision: 1 }), /edits/);
    assert.deepEqual(calls, ['get_state']);
    await main.prepareShutdown();
    assert.deepEqual(calls, ['get_state', 'shutdown']);
    await quick.disconnect(); await main.disconnect();
    assert.equal(kills, 1);
    await main.prepareShutdown(); // Closing still succeeds if the engine has already stopped.
    assert.deepEqual(calls, ['get_state', 'shutdown']);
  } finally {
    await quick?.disconnect(); await main?.disconnect();
    globalThis.location = previousLocation; globalThis.__bridgeHost = previousHost;
  }
});
