import test from 'node:test';
import assert from 'node:assert/strict';
import { shortcutFromEvent, validateShortcut, canonicalShortcut, validateShortcutPair } from '../src/shortcut.js';
const event = (extra) => ({ code: 'KeyK', key: 'k', ctrlKey: true, ...extra });
test('captures modifier combinations and respects letter keys on other keyboard layouts', () => {
  assert.equal(shortcutFromEvent(event({ altKey: true, shiftKey: true })), 'Control+Alt+Shift+K');
  assert.equal(shortcutFromEvent(event({ code: 'KeyQ', key: 'a' })), 'Control+A');
  assert.equal(shortcutFromEvent(event({ code: 'F12', key: 'F12', ctrlKey: false, metaKey: true })), 'Super+F12');
  assert.equal(shortcutFromEvent(event({ code: 'Digit1', key: '&', altKey: true })), 'Control+Alt+1');
});
test('the two shortcuts cannot collide even when modifier order differs', () => {
  assert.equal(canonicalShortcut('Alt+Control+K'), 'Control+Alt+K');
  assert.throws(() => validateShortcutPair({ visibilityShortcut: 'Control+Alt+K', quickAccessShortcut: 'Alt+Control+K' }), /different/);
  assert.deepEqual(validateShortcutPair({ visibilityShortcut: '', quickAccessShortcut: 'Control+Alt+Space' }), { visibility: '', quick: 'Control+Alt+Space' });
});
test('ignores modifier-only presses, repeat and AltGraph; refuses typing keys alone', () => {
  assert.equal(shortcutFromEvent(event({ code: 'ControlLeft', key: 'Control' })), null);
  assert.equal(shortcutFromEvent(event({ repeat: true })), null);
  assert.equal(shortcutFromEvent(event({ getModifierState: () => true })), null);
  assert.throws(() => shortcutFromEvent(event({ ctrlKey: false })));
  assert.throws(() => validateShortcut('Alt+F25'));
  assert.equal(validateShortcut('Alt+ArrowUp'), 'Alt+ArrowUp');
});
