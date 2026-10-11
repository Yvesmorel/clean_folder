import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OllamaClient, groupFiles, validateFolderName, validateOptions, scanFolder,
  createPlan, applyPlan, makeFolderPrompt, moveNoOverwrite,
} from '../sidecar/engine.mjs';

const execute = promisify(execFile);
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-folder-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, name, content = name) { await fs.writeFile(path.join(root, name), content); }
function fakeClient(folders, vectors) {
  let index = 0;
  return { stats: {}, embedNames: async (names) => vectors ?? names.map(() => [1, 0]),
    chooseFolder: async () => folders[index++] ?? folders.at(-1) };
}
async function mockOllama(t, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    calls.push({ endpoint: req.url, body });
    try {
      const answer = await handler(req.url, body, calls);
      res.writeHead(answer.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer.data));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}
const chatAnswer = (folder) => ({ data: { message: { content: JSON.stringify({ folder }) },
  done_reason: 'stop', prompt_eval_count: 30, eval_count: 8 } });

test('la matrice utilise le DERNIER fichier, même si le groupe dérive', () => {
  assert.deepEqual(groupFiles(['a', 'b', 'c'], [[1, 0], [.8, .6], [.28, .96]], .7), [['a', 'b', 'c']]);
});
test('choisir le meilleur score, pas le premier groupe dépassant le seuil', () => {
  assert.deepEqual(groupFiles(['a', 'b', 'c'], [[1, 0], [0, 1], [.6, .8]], .7), [['a'], ['b', 'c']]);
});
test('un score égal au seuil est accepté ; un score plus faible crée un groupe', () => {
  assert.deepEqual(groupFiles(['a', 'b'], [[1, 0], [.7, Math.sqrt(.51)]], .7), [['a', 'b']]);
  assert.deepEqual(groupFiles(['a', 'b'], [[1, 0], [.69, Math.sqrt(1 - .69 ** 2)]], .7), [['a'], ['b']]);
});
test('scores égaux : premier groupe ; matrice vide', () => {
  assert.deepEqual(groupFiles(['a', 'b', 'c'], [[1, 0], [0, 1], [1, 1]], .7), [['a', 'c'], ['b']]);
  assert.deepEqual(groupFiles([], []), []);
});
test('vecteurs incohérents, nuls et seuils invalides refusés', () => {
  assert.throws(() => groupFiles(['a', 'b'], [[1, 0], [1]]));
  assert.throws(() => groupFiles(['a'], [[0, 0]]));
  assert.throws(() => groupFiles(['a'], [[NaN]]));
  assert.throws(() => groupFiles(['a'], []));
  assert.throws(() => validateOptions({ threshold: NaN }));
  assert.throws(() => validateOptions({ batchSize: 0 }));
  assert.throws(() => validateOptions({ ollamaUrl: 'file:///etc' }));
});
test('noms de dossiers : chemins, noms réservés et contrôles refusés', () => {
  for (const name of ['../ailleurs', '..', '.', '/tmp', 'C:\\Users', 'con', 'NUL.txt', 'COM1', '.secret',
    'Formation.', ' Formation', 'Formation ', 'a\n', 'a\u202eb', 'a'.repeat(81), '']) {
    assert.throws(() => validateFolderName(name), name);
  }
  assert.equal(validateFolderName('Études et cours'), 'Études et cours');
});
test('scan en surface : sous-dossiers et liens restent intacts', async (t) => {
  const root = await temp(t);
  await put(root, 'b.pdf'); await put(root, 'a.docx');
  await fs.mkdir(path.join(root, 'Cours')); await put(path.join(root, 'Cours'), 'interne.txt');
  await fs.symlink(path.join(root, 'Cours'), path.join(root, 'lien'), process.platform === 'win32' ? 'junction' : 'dir');
  const scan = await scanFolder(root);
  assert.deepEqual(scan.files.map((f) => f.name), ['a.docx', 'b.pdf']);
  assert.deepEqual(scan.directories, ['Cours']); assert.deepEqual(scan.skipped, ['lien']);
});
test('embeddings par lots, une seule fois par nom et cache réutilisé', async (t) => {
  const server = await mockOllama(t, (_, body) => ({ data: { embeddings: body.input.map(() => [1, 2]) } }));
  const client = new OllamaClient({ ollamaUrl: server.url, batchSize: 2 });
  assert.equal((await client.embedNames(['Formation_2026.pdf', 'b', 'c', 'b'])).length, 4);
  await client.embedNames(['b', 'c']);
  assert.equal(server.calls.length, 2); assert.equal(client.stats.embeddedTexts, 3);
  assert.equal(server.calls[0].body.input[0], 'Formation 2026.pdf');
  assert.equal(server.calls[0].body.truncate, false);
});
test('dimensions différentes entre lots interrompent le traitement', async (t) => {
  const server = await mockOllama(t, (_, __, calls) => ({ data: { embeddings: [calls.length === 1 ? [1, 0] : [1]] } }));
  await assert.rejects(new OllamaClient({ ollamaUrl: server.url, batchSize: 1 }).embedNames(['a', 'b']), /dimensions/);
});
test('sortie LLM en JSON contraint, budget 64 tokens, température zéro', async (t) => {
  const server = await mockOllama(t, () => chatAnswer('Formation'));
  const client = new OllamaClient({ ollamaUrl: server.url });
  assert.equal(await client.chooseFolder(['math.pdf'], ['Formation']), 'Formation');
  const payload = server.calls[0].body;
  assert.equal(payload.stream, false); assert.equal(payload.options.num_predict, 64);
  assert.equal(payload.options.temperature, 0); assert.deepEqual(payload.format.required, ['folder']);
});
test('une sortie invalide est relancée une seule fois', async (t) => {
  const server = await mockOllama(t, (_, __, calls) => calls.length === 1
    ? { data: { message: { content: '{"folder":' }, done_reason: 'length' } } : chatAnswer('Cours'));
  const client = new OllamaClient({ ollamaUrl: server.url });
  assert.equal(await client.chooseFolder(['cours.pdf'], []), 'Cours');
  assert.equal(server.calls.length, 2);
});
test('si le LLM continue à proposer un chemin, aucun déplacement', async (t) => {
  const root = await temp(t); await put(root, 'cours.pdf');
  const server = await mockOllama(t, () => chatAnswer('../ailleurs'));
  await assert.rejects(createPlan(root, { ollamaUrl: server.url }), /two attempts/);
  assert.deepEqual(await fs.readdir(root), ['cours.pdf']); assert.equal(server.calls.length, 2);
});
test('erreur Ollama HTTP : interruption claire sans relance réseau', async (t) => {
  const server = await mockOllama(t, () => ({ status: 404, data: { error: 'model not found' } }));
  await assert.rejects(new OllamaClient({ ollamaUrl: server.url }).chooseFolder(['a'], []), /HTTP 404/);
  assert.equal(server.calls.length, 1);
});
test('les nouveaux dossiers sont réutilisables par les groupes suivants', async (t) => {
  const root = await temp(t); await put(root, 'a'); await put(root, 'b');
  const seen = [];
  const client = { stats: {}, embedNames: async () => [[1, 0], [0, 1]],
    chooseFolder: async (_, dirs) => { seen.push([...dirs]); return seen.length === 1 ? 'Cours' : 'cours'; } };
  const plan = await createPlan(root, {}, { client });
  assert.deepEqual(plan.groups.map((g) => g.folder), ['Cours', 'Cours']);
  assert.ok(seen[1].includes('Cours')); assert.deepEqual(await fs.readdir(root), ['a', 'b']);
});
test('collision dossier avec fichier : création d’un autre nom', async (t) => {
  const root = await temp(t); await put(root, 'Formation');
  const plan = await createPlan(root, {}, { client: fakeClient(['Formation']) });
  assert.equal(plan.groups[0].folder, 'Formation (2)');
  const result = await applyPlan(plan); assert.equal(result.errors.length, 0);
  assert.equal(await fs.readFile(path.join(root, 'Formation (2)', 'Formation'), 'utf8'), 'Formation');
});
test('déplacement réel, collision sans écrasement et sous-dossiers conservés', async (t) => {
  const root = await temp(t); await put(root, 'cours.pdf', 'nouveau');
  await fs.mkdir(path.join(root, 'Formation')); await put(path.join(root, 'Formation'), 'cours.pdf', 'ancien');
  await put(path.join(root, 'Formation'), 'cours (1).pdf', 'ancien 1');
  const plan = await createPlan(root, {}, { client: fakeClient(['formation']) });
  const result = await applyPlan(plan);
  assert.deepEqual(result.errors, []); assert.equal(result.moved[0].to, path.join('Formation', 'cours (2).pdf'));
  assert.equal(await fs.readFile(path.join(root, 'Formation', 'cours.pdf'), 'utf8'), 'ancien');
  assert.equal(await fs.readFile(path.join(root, 'Formation', 'cours (2).pdf'), 'utf8'), 'nouveau');
  assert.equal((await fs.readdir(root)).length, 1);
});
test('source modifiée après analyse : source préservée et erreur rapportée', async (t) => {
  const root = await temp(t); await put(root, 'a.pdf', 'avant');
  const plan = await createPlan(root, {}, { client: fakeClient(['Cours']) });
  await put(root, 'a.pdf', 'après modification');
  const result = await applyPlan(plan);
  assert.equal(result.moved.length, 0); assert.equal(result.errors.length, 1);
  assert.equal(await fs.readFile(path.join(root, 'a.pdf'), 'utf8'), 'après modification');
});
test('destination remplacée par un lien : aucun fichier envoyé hors du dossier', async (t) => {
  const root = await temp(t), outside = await temp(t);
  await put(root, 'a.pdf'); await fs.mkdir(path.join(root, 'Cours'));
  const plan = await createPlan(root, {}, { client: fakeClient(['Cours']) });
  await fs.rmdir(path.join(root, 'Cours')); await fs.symlink(outside, path.join(root, 'Cours'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await applyPlan(plan);
  assert.equal(result.errors.length, 1); assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(await fs.readFile(path.join(root, 'a.pdf'), 'utf8'), 'a.pdf');
});
test('plan incomplet ou avec un chemin de fichier refusé avant mutation', async (t) => {
  const root = await temp(t); await put(root, 'a.pdf');
  const plan = await createPlan(root, {}, { client: fakeClient(['Cours']) });
  await assert.rejects(applyPlan({ ...plan, groups: [{ folder: 'Cours', files: ['../a.pdf'] }] }), /Invalid move plan/);
  await assert.rejects(applyPlan({ ...plan, groups: [] }), /every original file/);
  assert.deepEqual(await fs.readdir(root), ['a.pdf']);
});
test('dossier sans fichiers : aucune requête Ollama', async (t) => {
  const root = await temp(t); await fs.mkdir(path.join(root, 'Cours'));
  const plan = await createPlan(root, {}, { client: { embedNames() { throw new Error('appel inattendu'); } } });
  assert.deepEqual(plan.groups, []); assert.deepEqual(await applyPlan(plan), { moved: [], errors: [] });
});
test('entrée LLM bornée même avec des centaines de noms', () => {
  const prompt = makeFolderPrompt(Array.from({ length: 1000 }, (_, i) => `formation_${i}_${'x'.repeat(200)}.pdf`),
    Array.from({ length: 500 }, (_, i) => `Dossier ${i}`));
  assert.ok(prompt.length < 3500); assert.ok(prompt.includes('1000')); assert.ok(!prompt.includes('Dossier 499'));
});
test('CLI de bout en bout : aperçu sans mutation puis application réelle', async (t) => {
  const root = await temp(t); await put(root, 'formation.pdf'); await put(root, 'formation2.docx');
  const server = await mockOllama(t, (endpoint, body) => endpoint === '/api/embed'
    ? { data: { embeddings: body.input.map(() => [1, 0]) } } : chatAnswer('Formation'));
  const script = fileURLToPath(new URL('../sidecar/engine.mjs', import.meta.url));
  const args = [script, root, '--ollama-url', server.url, '--json'];
  const preview = JSON.parse((await execute(process.execPath, args)).stdout);
  assert.equal(preview.mode, 'preview'); assert.equal(preview.groups.length, 1);
  assert.deepEqual((await fs.readdir(root)).sort(), ['formation.pdf', 'formation2.docx']);
  const applied = JSON.parse((await execute(process.execPath, [...args, '--apply'])).stdout);
  assert.equal(applied.moved.length, 2); assert.deepEqual(applied.errors, []);
  assert.deepEqual(await fs.readdir(root), ['Formation']);
});
test('déplacement entre systèmes de fichiers : copie exclusive puis suppression', async (t) => {
  const root = await temp(t);
  let shm;
  try { shm = await fs.stat('/dev/shm'); } catch { t.skip('/dev/shm indisponible'); return; }
  if (shm.dev === (await fs.stat(root)).dev) { t.skip('Pas de second système de fichiers'); return; }
  const destination = await fs.mkdtemp('/dev/shm/clean-folder-test-');
  t.after(() => fs.rm(destination, { recursive: true, force: true }));
  await put(root, 'a.pdf', 'nouveau'); await put(destination, 'a.pdf', 'ancien');
  const s = await fs.lstat(path.join(root, 'a.pdf'));
  const moved = await moveNoOverwrite(path.join(root, 'a.pdf'), destination, s);
  assert.equal(path.basename(moved), 'a (1).pdf');
  assert.equal(await fs.readFile(moved, 'utf8'), 'nouveau');
  assert.equal(await fs.readFile(path.join(destination, 'a.pdf'), 'utf8'), 'ancien');
  assert.deepEqual(await fs.readdir(root), []);
});
