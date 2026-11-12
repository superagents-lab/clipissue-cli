import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { authorize, refreshOAuth } from '../dist/oauth.js';

const base = { clientId: 'test-client', redirectUri: 'http://127.0.0.1:0/oauth/callback', timeoutMs: 2000 };
const tokenResponse = (extra = {}) => Response.json({ access_token: 'access-test', refresh_token: 'refresh-test', token_type: 'Bearer', expires_in: 3600, ...extra });

async function sendCallback(authorization, parameters) {
  const url = new URL(authorization);
  const callback = new URL(url.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: url.searchParams.get('state'), ...parameters }).toString();
  return fetch(callback);
}

test('browser OAuth validates callback state, exchanges a PKCE code, and returns both tokens', async () => {
  let authorization;
  const result = await authorize({
    ...base, now: () => 10_000,
    onAuthorize: async (url) => {
      authorization = new URL(url);
      assert.equal(authorization.origin, 'https://linear.app');
      assert.equal(authorization.searchParams.get('scope'), 'read,write');
      assert.equal(authorization.searchParams.get('actor'), 'user');
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      assert(authorization.searchParams.get('state').length >= 43);
      assert.equal((await sendCallback(url, { state: 'wrong', code: 'injected' })).status, 400);
      assert.equal((await sendCallback(url, { state: '中'.repeat(43), code: 'injected' })).status, 400);
      assert.equal((await sendCallback(url, {})).status, 400);
      assert.equal((await sendCallback(url, { code: 'valid-code' })).status, 200);
    },
    fetcher: async (url, init) => {
      assert.equal(url, 'https://api.linear.app/oauth/token');
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('client_id'), 'test-client');
      assert.equal(body.get('code'), 'valid-code');
      assert.equal(body.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
      assert.equal(body.has('client_secret'), false);
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
      return tokenResponse();
    },
  });
  assert.deepEqual(result, { accessToken: 'access-test', refreshToken: 'refresh-test', expiresAt: 3_610_000, clientId: 'test-client' });
});

test('denied authorization fails without requesting tokens', async () => {
  await assert.rejects(authorize({ ...base,
    onAuthorize: async (url) => { await sendCallback(url, { error: 'access_denied' }); },
    fetcher: () => { assert.fail('must not exchange a denied code'); },
  }), /denied/);
});

test('timeout and cancellation close the loopback listener', async () => {
  let port;
  await assert.rejects(authorize({ ...base, timeoutMs: 30, onAuthorize: (url) => {
    port = Number(new URL(new URL(url).searchParams.get('redirect_uri')).port);
  } }), /timed out/);
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  await new Promise((resolve) => server.close(resolve));
  const controller = new AbortController();
  await assert.rejects(authorize({ ...base, signal: controller.signal, onAuthorize: () => controller.abort() }), /canceled/);
});

test('only loopback redirects are accepted; an occupied callback port fails clearly', async () => {
  for (const redirectUri of ['https://example.com/callback', 'http://0.0.0.0:52837/callback', 'http://127.0.0.1:52837/callback?state=bad']) {
    await assert.rejects(authorize({ ...base, redirectUri, onAuthorize: () => assert.fail() }), /OAuth redirect/);
  }
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(authorize({ ...base, redirectUri: `http://127.0.0.1:${server.address().port}/callback`, onAuthorize: () => assert.fail() }), /Cannot listen/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('refresh uses the original client ID, rotates credentials together, and handles omitted refresh tokens', async () => {
  const old = { clientId: 'original-client', accessToken: 'old', refreshToken: 'original-refresh', expiresAt: 0 };
  const refreshed = await refreshOAuth(old, async (url, init) => {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('client_id'), 'original-client');
    assert.equal(body.get('refresh_token'), 'original-refresh');
    assert.equal(body.has('client_secret'), false);
    return tokenResponse();
  }, () => 1000);
  assert.equal(refreshed.refreshToken, 'refresh-test');
  assert.equal(refreshed.expiresAt, 3_601_000);
  assert.equal((await refreshOAuth(old, async () => tokenResponse({ refresh_token: undefined }))).refreshToken, 'original-refresh');
});

test('token errors are actionable and never echo credential-bearing responses', async () => {
  const old = { clientId: 'client', accessToken: 'old', refreshToken: 'secret' };
  await assert.rejects(refreshOAuth(old, async () => Response.json({ error: 'invalid_grant', details: 'secret' }, { status: 400 })), (error) => {
    assert.match(error.message, /clipissue login/);
    assert(!error.message.includes('secret'));
    return true;
  });
  await assert.rejects(refreshOAuth(old, async () => tokenResponse({ expires_in: 'invalid' })), /invalid token response/);
  await assert.rejects(refreshOAuth(old, async () => new Response('not json')), /invalid token response/);
});
