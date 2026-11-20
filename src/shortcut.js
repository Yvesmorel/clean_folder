const modifiers = ['Control', 'Alt', 'Shift', 'Super'];
const keys = /^(?:[A-Z]|[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/;
export function validateShortcut(value) {
  if (value === '') return value;
  if (typeof value !== 'string' || value.length > 80) throw new Error('Choose a valid keyboard shortcut.');
  const parts = value.split('+'), key = parts.pop();
  if (!keys.test(key) || !parts.length || new Set(parts).size !== parts.length || parts.some((p) => !modifiers.includes(p)) || !parts.some((p) => p !== 'Shift')) {
    throw new Error('Use Ctrl, Alt or Windows with a letter, number, function key or navigation key.');
  }
  return value;
}
export function canonicalShortcut(value) {
  validateShortcut(value);
  if (!value) return '';
  const parts = value.split('+'), key = parts.pop();
  return [...modifiers.filter((modifier) => parts.includes(modifier)), key].join('+');
}
export function validateShortcutPair(settings) {
  const visibility = canonicalShortcut(settings.visibilityShortcut);
  const quick = canonicalShortcut(settings.quickAccessShortcut);
  if (visibility && visibility === quick) throw new Error('Choose different shortcuts for the main window and quick access.');
  return { visibility, quick };
}
export function shortcutFromEvent(event) {
  if (event.repeat || event.getModifierState?.('AltGraph')) return null;
  let key = /^[a-z]$/i.test(event.key) ? event.key.toUpperCase() : event.code;
  if (/^Key[A-Z]$/.test(key)) key = key.slice(3);
  else if (/^Digit[0-9]$/.test(key)) key = key.slice(5);
  if (!keys.test(key)) return null;
  const parts = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super', key].filter(Boolean);
  const value = parts.join('+'); validateShortcut(value); return value;
}
