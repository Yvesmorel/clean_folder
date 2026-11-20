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
let pauseAnalysis = false;
const quickSource = path.join(base, 'Quick'); await fs.mkdir(quickSource);
await fs.writeFile(path.join(quickSource, 'Course_Quick.txt'), 'Formation et cours.');
await fs.writeFile(path.join(quickSource, 'Invoice_Quick.txt'), 'Facture et paiement.');
const counts = { analyses: 0, embeddings: 0, naming: 0 };
const models = [{ name: 'qwen3-embedding:0.6b', size: 639000000, parameterSize: '0.6B', capabilities: ['embedding'] },
  { name: 'llama3.2:1b', size: 1100000000, parameterSize: '1.8B', capabilities: ['completion'] }];
const bridge = await startDevBridge({ directory: path.join(base, 'data'), dependencies: {
  getModels: async () => models,
  deleteModel: async (name) => { const index = models.findIndex((m) => m.name === name); assert.ok(index >= 0); models.splice(index, 1); },
  pullModel: async (name, progress) => { progress({ model: name, status: 'success', percent: null }); models.push({ name, size: 500000000, parameterSize: '1B', capabilities: ['completion'] }); },
  createPlan: async (directory, options, hooks) => {
    counts.analyses++;
    if (pauseAnalysis) { await new Promise((_, reject) => hooks.signal.addEventListener('abort', () => reject(hooks.signal.reason), { once: true })); }
    return createPlan(directory, options, { ...hooks, client: { stats: {},
      embedNames: async (files) => { counts.embeddings++; return files.map((n) => n.startsWith('Course') ? [1,0,0] : n.startsWith('Invoice') ? [0,1,0] : [0,0,1]); },
      chooseFolder: async (files) => { counts.naming++; return files[0].startsWith('Course') ? 'Learning' : files[0].startsWith('Invoice') ? 'Invoices' : 'Notes'; },
    } });
  },
} });
process.env.VITE_DEV_BRIDGE = bridge.url; process.env.VITE_DEV_TOKEN = bridge.token;
const vite = await createServer({ server: { port: 0, strictPort: true, host: '127.0.0.1', watch: { ignored: ['**/src-tauri/target/**', '**/src-tauri/binaries/**', '**/sidecar/build/**'] } } }); await vite.listen();
const uiUrl = vite.resolvedUrls.local[0];
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
  page.setDefaultNavigationTimeout(90000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (message) => { if (message.type() === 'error') console.error('UI console:', message.text()); });
  const out = path.join(process.cwd(), 'ui-test-output'); await fs.mkdir(out, { recursive: true });
  await page.goto(uiUrl);
  try { await page.locator('.runtime-pill.ready').waitFor(); }
  catch (error) { await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }); console.error(await page.locator('body').innerText(), errors); throw error; }
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'white');
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  assert.equal(bridge.store.state.settings.folderLanguage, 'English');
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)');
  await page.screenshot({ path: path.join(out, '01-home.png'), fullPage: true });
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).waitFor();
  await page.reload(); await page.locator('.runtime-pill.ready').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'black');
  await page.screenshot({ path: path.join(out, '01-home-black.png'), fullPage: true });
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Choose folders', exact: true }).first().click();
  await page.getByLabel('Folder path', { exact: true }).fill(source);
  await page.getByRole('button', { name: 'Add folder', exact: true }).click();
  pauseAnalysis = true;
  await page.getByRole('button', { name: 'Create plan' }).click();
  await page.getByRole('button', { name: 'Cancel plan creation', exact: true }).click();
  await page.getByText('Plan creation cancelled. Your files stayed in place.', { exact: true }).waitFor();
  assert.equal(bridge.store.state.currentPlan, null);
  assert.deepEqual((await fs.readdir(source)).sort(), names.sort());
  pauseAnalysis = false;
  await page.getByRole('button', { name: 'Create plan' }).click();
  await page.getByRole('button', { name: 'Organize files', exact: true }).waitFor();
  assert.deepEqual((await fs.readdir(source)).sort(), names.sort());
  await page.screenshot({ path: path.join(out, '02-review.png'), fullPage: true });
  const blockedPopupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Quick access', exact: true }).click();
  const blockedQuick = await blockedPopupPromise;
  await blockedQuick.getByRole('heading', { name: 'A plan is already open', exact: true }).waitFor();
  assert.equal(await blockedQuick.locator('.quick-picker').count(), 0);
  const preservedPlan = bridge.store.state.currentPlan.id;
  await blockedQuick.getByRole('button', { name: 'Close quick access', exact: true }).click();
  assert.equal(bridge.store.state.currentPlan.id, preservedPlan);

  await page.getByRole('button', { name: 'Rename Learning', exact: true }).click();
  await page.getByLabel('New folder name', { exact: true }).fill('Professional learning');
  assert.equal(await page.getByRole('button', { name: 'Organize files', exact: true }).isDisabled(), true);
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
  await page.getByRole('button', { name: 'Organize files', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Organize 5 files', exact: true }).click();
  await page.getByRole('heading', { name: 'Organization complete', exact: true }).waitFor();
  assert.deepEqual(counts, before);
  assert.equal(await fs.readFile(path.join(source, 'Professional learning', 'Meeting_Notes.txt'), 'utf8'), 'Temporary test document: Meeting_Notes.txt');
  assert.equal((await fs.readdir(path.join(source, 'Professional learning'))).length, 3);
  assert.equal((await fs.readdir(path.join(source, 'Invoices'))).length, 2);
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.locator('.run-card').first().click(); await page.getByRole('heading', { name: 'Move receipts', exact: true }).waitFor();
  assert.equal(await page.locator('.receipt').count(), 5);
  await page.screenshot({ path: path.join(out, '03-activity.png'), fullPage: true });
  const quickPopupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Quick access', exact: true }).click();
  const quick = await quickPopupPromise;
  await quick.setViewportSize({ width: 460, height: 620 });
  quick.on('pageerror', (e) => errors.push(e.message));
  await quick.getByRole('button', { name: /Choose a folder/ }).waitFor();
  await quick.screenshot({ path: path.join(out, '07-quick-home.png'), fullPage: true });
  pauseAnalysis = true;
  await quick.locator('.quick-picker').click();
  await quick.getByLabel('Folder path', { exact: true }).fill(quickSource);
  await quick.getByRole('button', { name: 'Prepare folder', exact: true }).click();
  await quick.getByRole('button', { name: 'Cancel plan creation', exact: true }).click();
  await quick.getByText('Plan creation cancelled. Your files stayed in place.', { exact: true }).waitFor();
  assert.deepEqual((await fs.readdir(quickSource)).sort(), ['Course_Quick.txt', 'Invoice_Quick.txt']);
  pauseAnalysis = false;
  await quick.locator('.quick-picker').click();
  await quick.getByLabel('Folder path', { exact: true }).fill(quickSource);
  await quick.getByRole('button', { name: 'Prepare folder', exact: true }).click();
  await quick.getByRole('heading', { name: 'Plan ready', exact: true }).waitFor();
  assert.equal(await quick.locator('.quick-groups > div').count(), 2);
  assert.deepEqual((await fs.readdir(quickSource)).sort(), ['Course_Quick.txt', 'Invoice_Quick.txt']);
  await quick.screenshot({ path: path.join(out, '08-quick-plan.png'), fullPage: true });
  const quickCounts = { ...counts };
  await quick.getByRole('button', { name: 'Organize 2 files', exact: true }).click();
  await quick.getByRole('heading', { name: 'Organization complete', exact: true }).waitFor();
  assert.deepEqual(counts, quickCounts);
  assert.equal(await fs.readFile(path.join(quickSource, 'Learning', 'Course_Quick.txt'), 'utf8'), 'Formation et cours.');
  assert.equal(await fs.readFile(path.join(quickSource, 'Invoices', 'Invoice_Quick.txt'), 'utf8'), 'Facture et paiement.');
  assert.equal(bridge.store.state.history.length, 2);
  await quick.screenshot({ path: path.join(out, '09-quick-done.png'), fullPage: true });
  await quick.getByRole('button', { name: 'Close quick access', exact: true }).click();

  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.getByLabel('Ollama model name').fill('test-fixture:1b');
  await page.getByRole('button', { name: 'Install model', exact: true }).click();
  const card = page.locator('.model-card').filter({ has: page.getByRole('heading', { name: 'test-fixture:1b', exact: true }) });
  await card.getByRole('button', { name: 'Use for naming', exact: true }).click();
  await card.getByRole('button', { name: 'Selected for naming', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Folder name language', { exact: true }).selectOption('English');
  await page.getByRole('checkbox', { name: /Use a short document excerpt/ }).uncheck();
  await page.getByLabel('Window shortcut', { exact: true }).press('Control+Alt+k');
  await page.getByLabel('Quick access shortcut', { exact: true }).press('Control+Alt+j');
  assert.equal(await page.getByLabel('Window shortcut', { exact: true }).inputValue(), 'Control+Alt+K');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Settings saved.', { exact: true }).waitFor();
  await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.getByLabel('Folder name language', { exact: true }).inputValue(), 'English');
  assert.equal(bridge.store.state.settings.model, 'test-fixture:1b');
  assert.equal(await page.getByRole('checkbox', { name: /Use a short document excerpt/ }).isChecked(), false);
  assert.equal(await page.getByLabel('Window shortcut', { exact: true }).inputValue(), 'Control+Alt+K');
  assert.equal(await page.getByLabel('Quick access shortcut', { exact: true }).inputValue(), 'Control+Alt+J');
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByText('Settings saved.', { exact: true }).waitFor();
  await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.getByLabel('Window shortcut', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  const deleteButton = page.getByRole('button', { name: 'Delete test-fixture:1b', exact: true });
  await deleteButton.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.ok(models.some((m) => m.name === 'test-fixture:1b'));
  await deleteButton.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete model', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  assert.equal(bridge.store.state.settings.model, 'llama3.2:1b');
  assert.equal(models.some((m) => m.name === 'test-fixture:1b'), false);
  await page.reload(); await page.getByRole('button', { name: 'Models', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Delete test-fixture:1b', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.setViewportSize({ width: 760, height: 900 });
  await page.screenshot({ path: path.join(out, '04-compact.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, '05-settings-black.png'), fullPage: true });
  await fs.writeFile(path.join(quickSource, 'Course_Next.txt'), 'Un autre cours.');
  const blackQuickPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Quick access', exact: true }).click();
  const blackQuick = await blackQuickPromise;
  await blackQuick.setViewportSize({ width: 460, height: 620 });
  blackQuick.on('pageerror', (e) => errors.push(e.message));
  await blackQuick.getByRole('button', { name: /Choose a folder/ }).waitFor();
  await blackQuick.waitForFunction(() => document.querySelector('.quick-picker')?.disabled === false && document.documentElement.dataset.theme === 'black');
  assert.equal(await blackQuick.evaluate(() => document.documentElement.dataset.theme), 'black');
  await blackQuick.locator('.quick-recents button').filter({ has: blackQuick.getByText('Quick', { exact: true }) }).click();
  await blackQuick.getByRole('heading', { name: 'Plan ready', exact: true }).waitFor();
  await blackQuick.screenshot({ path: path.join(out, '10-quick-black.png'), fullPage: true });
  await blackQuick.getByRole('button', { name: 'Organize 1 file', exact: true }).click();
  await blackQuick.getByRole('heading', { name: 'Organization complete', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(quickSource, 'Learning', 'Course_Next.txt'), 'utf8'), 'Un autre cours.');
  await blackQuick.getByRole('button', { name: 'Close quick access', exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Organize', exact: true }).click();
  await page.screenshot({ path: path.join(out, '06-mobile-black.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('UI PASS: selection, real preview, rename, reassignment, restart persistence, exact-plan approval, real moves, logs, receipts, model installation/selection/deletion, preferences, shortcut capture/clearing/persistence, black/white themes, analysis cancellation, content preference, quick-access protected drafts/cancellation/real moves, quick-shortcut persistence and responsive layouts.');
  console.log(`Screenshots: ${out}`);
} finally { await browser?.close(); await vite.close(); await bridge.close(); await fs.rm(base, { recursive: true, force: true }); }
