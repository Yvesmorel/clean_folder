import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../sidecar/store.mjs';
import { Service } from '../sidecar/service.mjs';
import { createPlan as enginePlan, applyPlan } from '../sidecar/engine.mjs';
import { pullModel, validModel } from '../sidecar/runtime.mjs';

const models = [{ name: 'qwen3-embedding:0.6b', capabilities: ['embedding'], size: 639000000 },
  { name: 'llama3.2:1b', capabilities: ['completion'], size: 1100000000 }];
async function fixture(t, extra = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-folder-service-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
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
