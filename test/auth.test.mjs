import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthManager } from '../dist/auth.js';

function fixture(overrides = {}) {
  let saved = { accessToken: 'old', refreshToken: 'refresh-old', expiresAt: 0, clientId: 'client' };
  let refreshing = Promise.resolve();
  let refreshes = 0;
  const deps = {
    environmentKey: () => null, apiKey: () => 'legacy-api-key', source: 'keychain',
    load: () => saved, save: (value) => { saved = value; }, now: () => 1000,
    lock: (fn) => {
      const result = refreshing.then(fn);
      refreshing = result.catch(() => {});
      return result;
    },
    refresh: async () => { refreshes++; return { accessToken: 'new', refreshToken: 'refresh-new', expiresAt: 100_000, clientId: 'client' }; },
    ...overrides,
  };
  return { get: createAuthManager(deps), current: () => saved, refreshes: () => refreshes };
}

test('explicit environment API key takes precedence without touching stored OAuth', async () => {
  const f = fixture({ environmentKey: () => 'env-key', load: () => assert.fail('must not read keychain') });
  assert.deepEqual(await f.get(), { authorization: 'env-key', method: 'api-key', source: 'env' });
});

test('stored OAuth takes precedence over shared API keys; no OAuth falls back to API key', async () => {
  const f = fixture();
  assert.equal((await f.get()).method, 'oauth');
  assert.equal(f.current().refreshToken, 'refresh-new');
  assert.equal((await fixture({ load: () => null }).get()).authorization, 'legacy-api-key');
  assert.equal(await fixture({ load: () => null, apiKey: () => null }).get(), null);
});

test('two concurrent commands re-read storage inside the lock and refresh once', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.get(), f.get()]);
  assert.equal(a.authorization, 'Bearer new');
  assert.equal(b.authorization, 'Bearer new');
  assert.equal(f.refreshes(), 1);
  assert.deepEqual(f.current(), { accessToken: 'new', refreshToken: 'refresh-new', expiresAt: 100_000, clientId: 'client' });
});

test('401 refreshes an unexpired token once; an already-replaced token uses the latest pair', async () => {
  const f = fixture();
  await f.get();
  assert.equal((await f.get('Bearer old')).authorization, 'Bearer new');
  assert.equal(f.refreshes(), 1);
  await f.get('Bearer new');
  assert.equal(f.refreshes(), 2);
});

test('refresh failure never silently falls back to another account through an API key', async () => {
  const f = fixture({ refresh: async () => { throw new Error('Run `clipissue login` again.'); } });
  await assert.rejects(f.get(), /clipissue login/);
  assert.equal(f.current().accessToken, 'old');
});
