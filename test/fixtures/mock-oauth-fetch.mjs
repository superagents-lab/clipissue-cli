import { appendFileSync } from 'node:fs';
let rejected = false;
globalThis.fetch = async (url, init) => {
  if (url === 'https://api.linear.app/oauth/token') {
    const form = new URLSearchParams(init.body);
    const refreshing = form.get('grant_type') === 'refresh_token';
    appendFileSync(process.env.CLIPISSUE_TEST_REQUEST_LOG, `${JSON.stringify({ grant: form.get('grant_type'), hasSecret: form.has('client_secret') })}\n`);
    return Response.json({ access_token: refreshing ? 'refreshed-access' : 'initial-access', refresh_token: refreshing ? 'rotated-refresh' : 'initial-refresh', token_type: 'Bearer', expires_in: refreshing ? 3600 : 30 });
  }
  if (url !== 'https://api.linear.app/graphql') throw new Error('Unexpected endpoint');
  const authorization = init.headers.Authorization;
  if (process.env.CLIPISSUE_TEST_REJECT_ONCE && !rejected) { rejected = true; return new Response('', { status: 401 }); }
  if (authorization !== 'Bearer refreshed-access') throw new Error('OAuth Bearer authorization was not refreshed');
  return Response.json({ data: { viewer: { name: 'Test user' }, organization: { name: 'Test workspace' } } });
};
