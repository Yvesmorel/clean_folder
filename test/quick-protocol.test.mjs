import test from 'node:test';
import assert from 'node:assert/strict';
import { answerQuickRequest } from '../src/quick-protocol.js';

test('quick requests delegate to the same engine and return its actual result', async () => {
  const calls = [];
  const result = await answerQuickRequest({ id: 'request', method: 'apply_plan', args: { planId: 'plan', revision: 4 } }, async (method, args) => {
    calls.push({ method, args }); return { run: { moved: 2 } };
  });
  assert.deepEqual(calls, [{ method: 'apply_plan', args: { planId: 'plan', revision: 4 } }]);
  assert.deepEqual(result, { id: 'request', result: { run: { moved: 2 } } });
});
test('quick access rejects unsupported commands and protects unsaved main-window edits', async () => {
  const call = () => { throw new Error('Should not run'); };
  assert.equal(await answerQuickRequest({ method: 'get_state' }, call), null);
  assert.match((await answerQuickRequest({ id: 'request', method: 'save_settings' }, call)).error, /unavailable/);
  assert.match((await answerQuickRequest({ id: 'request', method: 'apply_plan' }, call, true)).error, /edits/);
});
test('quick access propagates engine errors without reporting successful moves', async () => {
  assert.deepEqual(await answerQuickRequest({ id: 'request', method: 'apply_plan' }, async () => { throw new Error('Stale plan'); }), { id: 'request', error: 'Stale plan' });
});
