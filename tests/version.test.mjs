import test from 'node:test';
import assert from 'node:assert/strict';
import { check, versions } from '../scripts/version.mjs';

test('app and plugin versions stay consistent across sources and the packaged zip', () => {
  assert.deepEqual(check(), []);
});

test('app and plugin versions are independent CalVer values', () => {
  const { app, plugin } = versions();
  assert.match(app, /^\d{4}\.\d{2}\.\d{2}$/);
  assert.match(plugin, /^\d{4}\.\d{2}\.\d{2}$/);
});
