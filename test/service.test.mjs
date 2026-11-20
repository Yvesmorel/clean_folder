import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../sidecar/store.mjs';
import { Service } from '../sidecar/service.mjs';
import { createPlan as enginePlan, applyPlan } from '../sidecar/engine.mjs';
import { pullModel, deleteModel, validModel } from '../sidecar/runtime.mjs';

const models = [{ name: 'qwen3-embedding:0.6b', capabilities: ['embedding'], size: 639000000 },
  { name: 'llama3.2:1b', capabilities: ['completion'], size: 1100000000 }];
async function fixture(t, extra = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-folder-service-'));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 3 }));
  const first = path.join(base, 'first'), second = path.join(base, 'second');
  await fs.mkdir(first); await fs.mkdir(second);
  await fs.writeFile(path.join(first, 'course.pdf'), 'course'); await fs.writeFile(path.join(first, 'invoice.pdf'), 'invoice');
  await fs.writeFile(path.join(second, 'notes.txt'), 'notes');
  const calls = { analyses: 0, embeddings: 0, naming: 0 }, events = [];
  const dependencies = { getModels: async () => models,
    createPlan: async (directory, options, hooks) => {
      calls.analyses++;
      return enginePlan(directory, options, { ...hooks, client: { stats: {},
        embedNames: async (names) => { calls.embeddings++; return names.map((n) => n.includes('course') ? [1, 0] : [0, 1]); },
        chooseFolder: async (names) => { calls.naming++; return names[0].includes('invoice') ? 'Invoices' : 'Learning'; },
      } });
    }, ...extra };
  const store = await new Store(path.join(base, 'data')).init();
  const service = new Service(store, (event, data) => events.push({ event, data }), dependencies);
  return { base, first, second, service, store, calls, events, dependencies };
}

test('edited multi-directory plan survives restart and applies without scanning or calling any model again', async (t) => {
  const f = await fixture(t); let plan = await f.service.handle('create_plan', { directories: [f.first, f.second] });
  const root = plan.roots[0], source = root.groups.find((g) => g.files.some((file) => file.name === 'course.pdf'));
  plan = await f.service.handle('edit_plan', { planId: plan.id, revision: plan.revision, rootId: root.id, groupId: source.id, action: 'rename_group', name: 'My learning' });
  const destination = plan.roots[0].groups.find((g) => g.folder === 'My learning');
  const invoice = plan.roots[0].groups.find((g) => g.folder === 'Invoices');
  plan = await f.service.handle('edit_plan', { planId: plan.id, revision: plan.revision, rootId: root.id, groupId: invoice.id,
    action: 'move_file', file: 'invoice.pdf', destinationGroupId: destination.id });
  const before = { ...f.calls };
  const restartedStore = await new Store(f.store.directory).init();
  const restarted = new Service(restartedStore, () => {}, { ...f.dependencies, createPlan() { throw new Error('Analysis ran again!'); } });
  assert.equal((await restarted.handle('get_state')).currentPlan.revision, 3);
  const result = await restarted.handle('apply_plan', { planId: plan.id, revision: plan.revision });
  assert.equal(result.run.moved, 3); assert.equal(result.run.errors, 0); assert.deepEqual(f.calls, before);
  assert.equal(await fs.readFile(path.join(f.first, 'My learning', 'invoice.pdf'), 'utf8'), 'invoice');
  assert.equal(await fs.readFile(path.join(f.first, 'My learning', 'course.pdf'), 'utf8'), 'course');
  assert.equal(await fs.readFile(path.join(f.second, 'Learning', 'notes.txt'), 'utf8'), 'notes');
  const persisted = JSON.parse(await fs.readFile(path.join(f.store.directory, 'state.json'), 'utf8'));
  assert.equal(persisted.history[0].entries.length, 3); assert.equal(persisted.history[0].status, 'completed');
  assert.deepEqual(persisted.recentDirectories, [f.first, f.second]);
});
test('stale revision is rejected before any file operation', async (t) => {
  const f = await fixture(t); const plan = await f.service.handle('create_plan', { directories: [f.first] });
  await f.service.handle('edit_plan', { planId: plan.id, revision: 1, rootId: plan.roots[0].id, groupId: plan.roots[0].groups[0].id, action: 'rename_group', name: 'Edited' });
  await assert.rejects(f.service.handle('apply_plan', { planId: plan.id, revision: 1 }), /plan changed/);
  assert.deepEqual((await fs.readdir(f.first)).sort(), ['course.pdf', 'invoice.pdf']);
});
test('completed plans cannot be replayed', async (t) => {
  const f = await fixture(t); const plan = await f.service.handle('create_plan', { directories: [f.first] });
  await f.service.handle('apply_plan', { planId: plan.id, revision: plan.revision });
  await assert.rejects(f.service.handle('apply_plan', { planId: plan.id, revision: plan.revision }), /no longer editable/);
  assert.equal(f.store.state.history.length, 1);
});
test('renaming to an existing group merges it without duplicating files', async (t) => {
  const f = await fixture(t); let plan = await f.service.handle('create_plan', { directories: [f.first] });
  const root = plan.roots[0];
  plan = await f.service.handle('edit_plan', { planId: plan.id, revision: plan.revision, rootId: root.id, groupId: root.groups[0].id,
    action: 'rename_group', name: root.groups[1].folder.toLowerCase() });
  assert.equal(plan.roots[0].groups.length, 1); assert.equal(plan.roots[0].groups[0].files.length, 2);
});
test('unsafe renames and filenames are rejected without mutating the draft', async (t) => {
  const f = await fixture(t); const plan = await f.service.handle('create_plan', { directories: [f.first] });
  const root = plan.roots[0], group = root.groups[0];
  await assert.rejects(f.service.handle('edit_plan', { planId: plan.id, revision: plan.revision, rootId: root.id, groupId: group.id,
    action: 'rename_group', name: '../outside' }), /Invalid folder/);
  await assert.rejects(f.service.handle('edit_plan', { planId: plan.id, revision: plan.revision, rootId: root.id, groupId: group.id,
    action: 'move_file', file: '../outside', destinationGroupId: group.id }), /Unknown file/);
  assert.equal(f.store.state.currentPlan.revision, 1);
});
test('add a destination then assign a file; no directory is created until approval', async (t) => {
  const f = await fixture(t); let plan = await f.service.handle('create_plan', { directories: [f.first] });
  plan = await f.service.handle('edit_plan', { planId: plan.id, revision: plan.revision, rootId: plan.roots[0].id, action: 'add_group', name: 'Personal' });
  const root = plan.roots[0], destination = root.groups.find((g) => g.folder === 'Personal'), source = root.groups.find((g) => g.files.length);
  plan = await f.service.handle('edit_plan', { planId: plan.id, revision: plan.revision, rootId: root.id, groupId: source.id,
    action: 'move_file', file: source.files[0].name, destinationGroupId: destination.id });
  assert.deepEqual((await fs.readdir(f.first)).sort(), ['course.pdf', 'invoice.pdf']);
  await f.service.handle('apply_plan', { planId: plan.id, revision: plan.revision });
  assert.equal((await fs.readdir(path.join(f.first, 'Personal'))).length, 1);
});
test('changing model selections validates capabilities and persists the selection', async (t) => {
  const f = await fixture(t, { getModels: async () => [...models, { name: 'other:1b', capabilities: ['completion'] }] });
  await f.service.handle('save_settings', { settings: { model: 'other:1b', threshold: .8, folderLanguage: 'English' } });
  const restored = await new Store(f.store.directory).init(); assert.equal(restored.state.settings.model, 'other:1b');
  assert.equal(restored.state.settings.threshold, .8); assert.equal(restored.state.settings.folderLanguage, 'English');
  await assert.rejects(f.service.handle('save_settings', { settings: { embeddingModel: 'other:1b' } }), /embedding model/);
  await assert.rejects(f.service.handle('save_settings', { settings: { ollamaUrl: 'http://example.com' } }), /Unsupported setting/);
});
test('busy guard prevents simultaneous operations', async (t) => {
  let release; const pending = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { pullModel: async () => pending });
  const download = f.service.handle('install_model', { name: 'other:1b' });
  await assert.rejects(f.service.handle('create_plan', { directories: [f.first] }), /Please wait/);
  await assert.rejects(f.service.handle('save_settings', { settings: { threshold: .8 } }), /Please wait/);
  release(); await download; assert.equal(f.service.active, null);
});
test('changed file yields a real partial history receipt', async (t) => {
  const f = await fixture(t); const plan = await f.service.handle('create_plan', { directories: [f.first] });
  await fs.writeFile(path.join(f.first, 'course.pdf'), 'changed file contents');
  const result = await f.service.handle('apply_plan', { planId: plan.id, revision: plan.revision });
  assert.equal(result.run.status, 'partial'); assert.equal(result.run.moved, 1); assert.equal(result.run.errors, 1);
  assert.equal(await fs.readFile(path.join(f.first, 'course.pdf'), 'utf8'), 'changed file contents');
  assert.ok(f.events.some((e) => e.event === 'log' && e.data.level === 'error'));
});
test('an interrupted run is marked on restart and cannot be approved again', async (t) => {
  const f = await fixture(t); await f.service.handle('create_plan', { directories: [f.first] });
  f.store.state.currentPlan.status = 'applying'; f.store.state.history.push({ planId: f.store.state.currentPlan.id, status: 'applying', entries: [] }); await f.store.save();
  const restored = await new Store(f.store.directory).init();
  assert.equal(restored.state.currentPlan.status, 'interrupted'); assert.equal(restored.state.history[0].status, 'interrupted');
  assert.ok(restored.state.logs.some((l) => l.message.includes('interrupted')));
});
test('overlapping source directories are rejected without moving anything', async (t) => {
  const f = await fixture(t); await fs.mkdir(path.join(f.first, 'nested'));
  await assert.rejects(f.service.handle('create_plan', { directories: [f.first, path.join(f.first, 'nested')] }), /separate directories/);
  assert.deepEqual((await fs.readdir(f.first)).sort(), ['course.pdf', 'invoice.pdf', 'nested']);
});
test('discarding a persisted review does not move files', async (t) => {
  const f = await fixture(t); const plan = await f.service.handle('create_plan', { directories: [f.first] });
  await f.service.handle('discard_plan', { planId: plan.id, revision: plan.revision });
  assert.equal((await new Store(f.store.directory).init()).state.currentPlan, null);
  assert.deepEqual((await fs.readdir(f.first)).sort(), ['course.pdf', 'invoice.pdf']);
});
test('corrupt local state is reported without silently deleting or replacing it', async (t) => {
  const f = await fixture(t); const file = path.join(f.store.directory, 'state.json'); await fs.writeFile(file, '{bad JSON');
  await assert.rejects(new Store(f.store.directory).init(), /could not be loaded/);
  assert.equal(await fs.readFile(file, 'utf8'), '{bad JSON');
});
test('journal errors stop execution and do not relabel a moved file as a failed move', async (t) => {
  const f = await fixture(t); const snapshot = await f.dependencies.createPlan(f.first, {}, {});
  const receipts = [];
  await assert.rejects(applyPlan(snapshot, { onFileResult: async (entry) => { receipts.push(entry); throw new Error('Disk full'); } }), /Disk full/);
  assert.equal(receipts.length, 1); assert.equal(receipts[0].ok, true);
  const remaining = (await fs.readdir(f.first)).filter((n) => n.endsWith('.pdf')); assert.equal(remaining.length, 1);
});
test('streaming model pull parses fragmented NDJSON and reports actual progress', async (t) => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write('{"status":"pulling layer","total":100,"com');
    res.write('pleted":40}\n'); res.end('{"status":"success"}\n'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const progress = [];
  await pullModel('other:1b', (p) => progress.push(p), { base: `http://127.0.0.1:${server.address().port}` });
  assert.equal(progress[0].percent, 40); assert.equal(progress.at(-1).status, 'success');
  for (const name of ['x; rm', 'x\n', '../x', '']) assert.throws(() => validModel(name));
});

test('remote models cannot be selected or used for analysis', async (t) => {
  const f = await fixture(t, { getModels: async () => [...models, { name: 'remote-alias:latest', local: false, capabilities: ['completion'] }] });
  await assert.rejects(f.service.handle('save_settings', { settings: { model: 'remote-alias:latest' } }), /local text-generation/);
  f.store.state.settings.model = 'remote-alias:latest';
  await assert.rejects(f.service.handle('create_plan', { directories: [f.first] }), /selected local models/);
  assert.equal(f.calls.analyses, 0); assert.throws(() => validModel('qwen:cloud'), /local model/);
});

test('thinking is disabled for supported naming models to preserve the short JSON budget', async (t) => {
  let options;
  const f = await fixture(t, { getModels: async () => [models[0], { ...models[1], capabilities: ['completion', 'thinking'] }],
    createPlan: async (directory, settings, hooks) => { options = settings; return enginePlan(directory, settings, { ...hooks,
      client: { stats: {}, embedNames: async (names) => names.map(() => [1, 0]), chooseFolder: async () => 'Files' } }); } });
  await f.service.handle('create_plan', { directories: [f.first] });
  assert.equal(options.thinkingSupported, true);
});


test('deleting a selected model chooses an installed local compatible replacement and persists it', async (t) => {
  let installed = [...models, { name: 'remote:latest', local: false, capabilities: ['completion'] }, { name: 'replacement:1b', capabilities: ['completion'] }];
  const deleted = [];
  const f = await fixture(t, { getModels: async () => installed, deleteModel: async (name) => { deleted.push(name); installed = installed.filter((m) => m.name !== name); } });
  const result = await f.service.handle('delete_model', { name: 'llama3.2:1b' });
  assert.deepEqual(deleted, ['llama3.2:1b']); assert.equal(result.ready, true);
  assert.equal(result.settings.model, 'replacement:1b');
  assert.equal(result.models.some((m) => m.name === 'llama3.2:1b'), false);
  const restored = await new Store(f.store.directory).init();
  assert.equal(restored.state.settings.model, 'replacement:1b'); assert.equal(restored.state.setup.autoSetupDisabled, true);
});

test('deleting the last embedding model disables analysis and preserves a prepared review', async (t) => {
  let installed = [...models];
  const f = await fixture(t, { getModels: async () => installed, deleteModel: async (name) => { installed = installed.filter((m) => m.name !== name); } });
  const plan = await f.service.handle('create_plan', { directories: [f.first] });
  const result = await f.service.handle('delete_model', { name: 'qwen3-embedding:0.6b' });
  assert.equal(result.ready, false); assert.equal(result.currentPlan.id, plan.id);
  assert.equal((await new Store(f.store.directory).init()).state.setup.autoSetupDisabled, true);
  const applied = await f.service.handle('apply_plan', { planId: plan.id, revision: plan.revision });
  assert.equal(applied.run.moved, 2);
});

test('model deletion rejects unknown names, concurrent tasks and propagates Ollama failure', async (t) => {
  let calls = 0;
  const f = await fixture(t, { deleteModel: async () => { calls++; throw new Error('Ollama refused deletion'); } });
  await assert.rejects(f.service.handle('delete_model', { name: 'unknown:1b' }), /no longer installed/);
  await assert.rejects(f.service.handle('delete_model', { name: '../bad' }), /valid Ollama/);
  f.service.active = 'analysis';
  await assert.rejects(f.service.handle('delete_model', { name: 'llama3.2:1b' }), /Please wait/);
  f.service.active = null;
  await assert.rejects(f.service.handle('delete_model', { name: 'llama3.2:1b' }), /Ollama refused deletion/);
  assert.equal(calls, 1); assert.equal(f.service.active, null);
  assert.equal(f.store.state.settings.model, 'llama3.2:1b'); assert.equal(f.store.state.setup.autoSetupDisabled, undefined);
});

test('deletion uses the Ollama DELETE endpoint with the exact model and accepts an empty success response', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
    if (requests.length === 1) { res.writeHead(200); res.end(); }
    else { res.writeHead(500); res.end('Delete failed'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await deleteModel('custom:1b', { base });
  assert.deepEqual(requests[0], { method: 'DELETE', url: '/api/delete', body: { model: 'custom:1b' } });
  await assert.rejects(deleteModel('custom:1b', { base }), /HTTP 500: Delete failed/);
});

test('visibility shortcut is validated, persisted and can be cleared', async (t) => {
  const f = await fixture(t);
  await f.service.handle('save_settings', { settings: { visibilityShortcut: 'Control+Alt+K' } });
  assert.equal((await new Store(f.store.directory).init()).state.settings.visibilityShortcut, 'Control+Alt+K');
  for (const visibilityShortcut of ['K', 'Shift+K', 'Control+Control+K', 'Control+Bogus', null, 2]) {
    await assert.rejects(f.service.handle('save_settings', { settings: { visibilityShortcut } }));
  }
  assert.equal(f.store.state.settings.visibilityShortcut, 'Control+Alt+K');
  await f.service.handle('save_settings', { settings: { visibilityShortcut: '' } });
  assert.equal((await new Store(f.store.directory).init()).state.settings.visibilityShortcut, '');
});


test('cancelling analysis interrupts pending work and leaves no partial plan or moves', async (t) => {
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { createPlan: async (_, __, { signal }) => {
    entered(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const work = f.service.handle('create_plan', { directories: [f.first] }); await ready;
  assert.deepEqual(await f.service.handle('cancel_analysis'), { cancelled: true });
  assert.deepEqual(await work, { cancelled: true }); assert.equal(f.service.active, null);
  assert.equal(f.store.state.currentPlan, null); assert.deepEqual(f.store.state.recentDirectories, []);
  assert.deepEqual((await fs.readdir(f.first)).sort(), ['course.pdf', 'invoice.pdf']);
  assert.deepEqual(await f.service.handle('cancel_analysis'), { cancelled: false });
  f.service.dependencies.createPlan = f.dependencies.createPlan = async (directory, options, hooks) => enginePlan(directory, options, { ...hooks,
    client: { stats: {}, embedNames: async (names) => names.map(() => [1, 0]), chooseFolder: async () => 'Files' } });
  assert.equal((await f.service.handle('create_plan', { directories: [f.first] })).status, 'draft');
});
test('cancellation while checking models stops before reading any directory', async (t) => {
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { getModels: async ({ signal }) => { entered(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  const work = f.service.handle('create_plan', { directories: [f.first] }); await ready;
  await f.service.handle('cancel_analysis'); assert.deepEqual(await work, { cancelled: true }); assert.equal(f.calls.analyses, 0);
});
test('theme and content preferences persist and invalid settings are rejected', async (t) => {
  const f = await fixture(t);
  await f.service.handle('save_settings', { settings: { theme: 'black', inspectContent: false } });
  const restored = await new Store(f.store.directory).init();
  assert.equal(restored.state.settings.theme, 'black'); assert.equal(restored.state.settings.inspectContent, false);
  await assert.rejects(f.service.handle('save_settings', { settings: { theme: 'blue' } }));
  await assert.rejects(f.service.handle('save_settings', { settings: { inspectContent: 'yes' } }));
});

test('quick-access shortcut is migrated, validated and persisted separately from window visibility', async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.state.settings.quickAccessShortcut, 'Control+Alt+Space');
  await f.service.handle('save_settings', { settings: { visibilityShortcut: 'Control+Alt+K', quickAccessShortcut: 'Control+Alt+J' } });
  const restored = await new Store(f.store.directory).init();
  assert.equal(restored.state.settings.quickAccessShortcut, 'Control+Alt+J');
  await assert.rejects(f.service.handle('save_settings', { settings: { quickAccessShortcut: 'Alt+Control+K' } }), /different/);
  assert.equal(f.store.state.settings.quickAccessShortcut, 'Control+Alt+J');
  await f.service.handle('save_settings', { settings: { quickAccessShortcut: '' } });
  assert.equal(f.store.state.settings.visibilityShortcut, 'Control+Alt+K');
});

test('shutdown cancels analysis, saves local state and rejects new work', async (t) => {
  let entered; const ready = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { createPlan: async (_, __, { signal }) => {
    entered(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const analysis = f.service.handle('create_plan', { directories: [f.first] }); await ready;
  assert.deepEqual(await f.service.handle('shutdown'), { readyToClose: true });
  assert.deepEqual(await analysis, { cancelled: true }); assert.equal(f.service.active, null);
  assert.equal((await new Store(f.store.directory).init()).state.currentPlan, null);
  await assert.rejects(f.service.handle('create_plan', { directories: [f.first] }), /closing/);
  assert.deepEqual((await fs.readdir(f.first)).sort(), ['course.pdf', 'invoice.pdf']);
});
test('shutdown during file moves waits for the current receipt and stops before the next file', async (t) => {
  let entered, release; const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; }); let receipts = 0;
  const f = await fixture(t, { applyPlan: async (plan, hooks) => applyPlan(plan, { ...hooks, onFileResult: async (entry) => {
    await hooks.onFileResult(entry); if (++receipts === 1) { entered(); await gate; }
  } }) });
  const plan = await f.service.handle('create_plan', { directories: [f.first] });
  const moving = f.service.handle('apply_plan', { planId: plan.id, revision: plan.revision }).catch((error) => error);
  await ready;
  let closed = false; const closing = f.service.handle('shutdown').then((result) => { closed = true; return result; });
  await Promise.resolve(); assert.equal(closed, false);
  release(); assert.equal((await moving).name, 'AbortError');
  assert.deepEqual(await closing, { readyToClose: true });
  const restored = await new Store(f.store.directory).init();
  assert.equal(restored.state.history[0].entries.length, 1); assert.equal(restored.state.history[0].entries[0].ok, true);
  assert.equal(restored.state.history[0].status, 'interrupted'); assert.equal(restored.state.history[0].moved, 1);
  assert.equal((await fs.readdir(f.first)).filter((name) => name.endsWith('.pdf')).length, 1);
});
test('shutdown cancels setup and waits for the operation to release the engine', async (t) => {
  let entered; const ready = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { setupRuntime: async (_, __, ___, { signal }) => {
    entered(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const setup = f.service.handle('setup_runtime').catch((error) => error); await ready;
  assert.deepEqual(await f.service.handle('shutdown'), { readyToClose: true });
  assert.equal((await setup).name, 'AbortError'); assert.equal(f.service.active, null);
  assert.match((await new Store(f.store.directory).init()).state.setup.error, /cancelled/);
});
