import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createCloseController } from '../src/closing.js';
import { englishLogMessage } from '../src/log-language.js';

test('the native close button flushes the engine before disconnecting and destroying the main window', async () => {
  const events = [];
  const close = createCloseController({ isBusy: () => false, confirm: () => events.push('confirm'),
    shutdown: async () => events.push('save'), disconnect: async () => events.push('disconnect'),
    destroy: async () => events.push('destroy'), onError: (error) => { throw error; } });
  await close.request({ preventDefault: () => events.push('prevent automatic close') });
  assert.deepEqual(events, ['prevent automatic close', 'save', 'disconnect', 'destroy']);
  const capability = JSON.parse(await fs.readFile(new URL('../src-tauri/capabilities/default.json', import.meta.url)));
  assert.ok(capability.windows.includes('main')); assert.ok(capability.permissions.includes('core:window:allow-destroy'));
});
test('busy close requests ask for confirmation, and repeated quit clicks share one shutdown', async () => {
  const events = []; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const close = createCloseController({ isBusy: () => true, confirm: () => events.push('confirm'),
    shutdown: async () => { events.push('save'); await gate; }, disconnect: async () => events.push('disconnect'),
    destroy: async () => events.push('destroy'), onError: (error) => { throw error; } });
  await close.request({ preventDefault: () => {} }); assert.deepEqual(events, ['confirm']);
  const first = close.quit(), second = close.quit(); assert.equal(first, second);
  await Promise.resolve(); assert.deepEqual(events, ['confirm', 'save']);
  release(); assert.equal(await first, true); assert.deepEqual(events, ['confirm', 'save', 'disconnect', 'destroy']);
});
test('a failed shutdown reports the error and allows retry without destroying the window', async () => {
  let fail = true; const events = [];
  const close = createCloseController({ isBusy: () => false, confirm: () => {},
    shutdown: () => { if (fail) throw new Error('Disk full'); }, disconnect: async () => events.push('disconnect'),
    destroy: async () => events.push('destroy'), onError: (error) => events.push(error.message) });
  assert.equal(await close.quit(), false); assert.deepEqual(events, ['Disk full']);
  fail = false; assert.equal(await close.quit(), true); assert.deepEqual(events, ['Disk full', 'disconnect', 'destroy']);
});
test('old built-in log messages are displayed in English without translating user filenames', () => {
  assert.equal(englishLogMessage('Lecture des indices : 1/3'), 'Reading content clues: 1/3');
  assert.equal(englishLogMessage('Création du plan annulée. Aucun fichier déplacé.'), 'Plan creation cancelled. No files were moved.');
  assert.equal(englishLogMessage('Moved Facture été.pdf → Cours'), 'Moved Facture été.pdf → Cours');
});
