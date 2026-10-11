import { chromium } from 'playwright';
import { createServer } from 'vite';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startDevBridge } from './browser-dev.mjs';
import { createPlan } from '../sidecar/engine.mjs';

// Test-only model fixtures. The UI calls the real service and moves real temporary files.
// No mock adapter, seeded data, or fake operations exist in the shipped application.
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-folder-ui-'));
const source = path.join(base, 'Workspace'); await fs.mkdir(source);
const names = ['Course_LangGraph_2026.pdf','Course_LangGraph_notes.docx','Invoice_October_2026.pdf','Invoice_September_2026.xlsx','Meeting_Notes.txt'];
for (const name of names) await fs.writeFile(path.join(source, name), `Temporary test document: ${name}`);
const counts = { analyses: 0, embeddings: 0, naming: 0 };
const models = [{ name: 'qwen3-embedding:0.6b', size: 639000000, parameterSize: '0.6B', capabilities: ['embedding'] },
  { name: 'llama3.2:1b', size: 1100000000, parameterSize: '1.8B', capabilities: ['completion'] }];
const bridge = await startDevBridge({ directory: path.join(base, 'data'), dependencies: {
  getModels: async () => models,
  pullModel: async (name, progress) => { progress({ model: name, status: 'success', percent: null }); models.push({ name, size: 500000000, parameterSize: '1B', capabilities: ['completion'] }); },
  createPlan: async (directory, options, hooks) => {
    counts.analyses++;
    return createPlan(directory, options, { ...hooks, client: { stats: {},
      embedNames: async (files) => { counts.embeddings++; return files.map((n) => n.startsWith('Course') ? [1,0,0] : n.startsWith('Invoice') ? [0,1,0] : [0,0,1]); },
      chooseFolder: async (files) => { counts.naming++; return files[0].startsWith('Course') ? 'Learning' : files[0].startsWith('Invoice') ? 'Invoices' : 'Notes'; },
    } });
  },
} });
process.env.VITE_DEV_BRIDGE = bridge.url; process.env.VITE_DEV_TOKEN = bridge.token;
const vite = await createServer({ server: { port: 1420, strictPort: true, host: '127.0.0.1' } }); await vite.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (message) => { if (message.type() === 'error') console.error('UI console:', message.text()); });
  const out = path.join(process.cwd(), 'ui-test-output'); await fs.mkdir(out, { recursive: true });
  await page.goto('http://127.0.0.1:1420');
  try { await page.locator('.runtime-pill.ready').waitFor(); }
  catch (error) { await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }); console.error(await page.locator('body').innerText(), errors); throw error; }
  await page.screenshot({ path: path.join(out, '01-home.png'), fullPage: true });
  await page.getByRole('button', { name: 'Choose directories', exact: true }).first().click();
  await page.getByLabel('Directory path', { exact: true }).fill(source);
  await page.getByRole('button', { name: 'Add directory', exact: true }).click();
  await page.getByRole('button', { name: 'Create my plan' }).click();
  await page.getByRole('button', { name: 'Approve & organize', exact: true }).waitFor();
  assert.deepEqual((await fs.readdir(source)).sort(), names.sort());
  await page.screenshot({ path: path.join(out, '02-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Rename Learning', exact: true }).click();
  await page.getByLabel('New folder name', { exact: true }).fill('Professional learning');
  assert.equal(await page.getByRole('button', { name: 'Approve & organize', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Save folder name', exact: true }).click();
  await page.getByRole('heading', { name: 'Professional learning', exact: true }).waitFor();
  const learning = bridge.store.state.currentPlan.roots[0].groups.find((g) => g.folder === 'Professional learning');
  await page.getByLabel('Move Meeting_Notes.txt', { exact: true }).selectOption(learning.id);
  await page.locator('.folder-card').filter({ has: page.getByRole('heading', { name: 'Professional learning', exact: true }) }).getByText('Meeting_Notes.txt', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByLabel('Folder name', { exact: true }).fill('Projects');
  await page.getByRole('button', { name: 'Add folder', exact: true }).click();
  const projectsCard = page.locator('.folder-card').filter({ has: page.getByRole('heading', { name: 'Projects', exact: true }) });
  await projectsCard.waitFor();
  // Dispatch the standard HTML drag events with one shared DataTransfer. The destination
  // handler still persists the edit through the real IPC service, rather than a UI mock.
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  const draggedFile = page.locator('.file-row').filter({ hasText: 'Invoice_September_2026.xlsx' });
  await draggedFile.dispatchEvent('dragstart', { dataTransfer: transfer });
  await projectsCard.dispatchEvent('dragover', { dataTransfer: transfer });
  await projectsCard.dispatchEvent('drop', { dataTransfer: transfer });
  await draggedFile.dispatchEvent('dragend', { dataTransfer: transfer });
  await projectsCard.getByText('Invoice_September_2026.xlsx', { exact: true }).waitFor();
  const invoicesId = bridge.store.state.currentPlan.roots[0].groups.find((g) => g.folder === 'Invoices').id;
  await page.getByLabel('Move Invoice_September_2026.xlsx', { exact: true }).selectOption(invoicesId);
  await page.locator('.folder-card').filter({ has: page.getByRole('heading', { name: 'Invoices', exact: true }) }).getByText('Invoice_September_2026.xlsx', { exact: true }).waitFor();
  // Save and reload: the edited proposal is read from the real local database.
  await page.reload(); await page.getByRole('heading', { name: 'Professional learning', exact: true }).waitFor();
  const before = { ...counts };
  await page.getByRole('button', { name: 'Approve & organize', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Organize 5 files', exact: true }).click();
  await page.getByRole('heading', { name: 'Everything has its place.', exact: true }).waitFor();
  assert.deepEqual(counts, before);
  assert.equal(await fs.readFile(path.join(source, 'Professional learning', 'Meeting_Notes.txt'), 'utf8'), 'Temporary test document: Meeting_Notes.txt');
  assert.equal((await fs.readdir(path.join(source, 'Professional learning'))).length, 3);
  assert.equal((await fs.readdir(path.join(source, 'Invoices'))).length, 2);
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.locator('.run-card').first().click(); await page.getByRole('heading', { name: 'Move receipts', exact: true }).waitFor();
  assert.equal(await page.locator('.receipt').count(), 5);
  await page.screenshot({ path: path.join(out, '03-activity.png'), fullPage: true });
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.getByLabel('Ollama model name').fill('test-fixture:1b');
  await page.getByRole('button', { name: 'Install model', exact: true }).click();
  const card = page.locator('.model-card').filter({ has: page.getByRole('heading', { name: 'test-fixture:1b', exact: true }) });
  await card.getByRole('button', { name: 'Use for naming', exact: true }).click();
  await card.getByRole('button', { name: 'Selected for naming', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByLabel('Suggested folder names', { exact: true }).selectOption('English');
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await page.getByText('Your preferences are saved.', { exact: true }).waitFor();
  await page.reload(); await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  assert.equal(await page.getByLabel('Suggested folder names', { exact: true }).inputValue(), 'English');
  assert.equal(bridge.store.state.settings.model, 'test-fixture:1b');
  await page.setViewportSize({ width: 760, height: 900 });
  await page.screenshot({ path: path.join(out, '04-compact.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('UI PASS: selection, real preview, rename, reassignment, restart persistence, exact-plan approval, real moves, logs, receipts, model installation/selection, preferences and compact layout.');
  console.log(`Screenshots: ${out}`);
} finally { await browser?.close(); await vite.close(); await bridge.close(); await fs.rm(base, { recursive: true, force: true }); }
