import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserStorage } from './browser-storage.js';

class MemoryStorage {
  getItem(key) { return Object.hasOwn(this, key) ? this[key] : null; }
  setItem(key, value) { this[key] = String(value); }
  removeItem(key) { delete this[key]; }
}

test('preview edits, deletes and lists cannot affect production plans', () => {
  const storage = new MemoryStorage();
  const production = createBrowserStorage(() => storage);
  const preview = createBrowserStorage(() => storage, 'shearplan:codex-review:');
  production.set('plans', 'production plan');
  assert.equal(preview.get('plans').value, null);
  preview.set('plans', 'preview plan');
  assert.equal(production.get('plans').value, 'production plan');
  assert.deepEqual(preview.list('pl'), { keys: ['plans'], prefix: 'pl' });
  assert.deepEqual(preview.list(), { keys: ['plans'], prefix: '' });
  preview.delete('plans');
  assert.equal(preview.get('plans').value, null);
  assert.equal(production.get('plans').value, 'production plan');
});

test('production still reads existing unprefixed saved data', () => {
  const storage = new MemoryStorage();
  storage.setItem('plans', 'existing plan');
  const production = createBrowserStorage(() => storage);
  assert.deepEqual(production.get('plans'), { key: 'plans', value: 'existing plan' });
  production.set('plans', 'updated plan');
  assert.equal(storage.getItem('plans'), 'updated plan');
});

test('storage access remains lazy for browsers that block localStorage', () => {
  const api = createBrowserStorage(() => { throw new Error('Storage unavailable'); });
  assert.throws(() => api.get('plans'), /Storage unavailable/);
});
