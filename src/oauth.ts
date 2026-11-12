import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';

export const DEFAULT_CLIENT_ID = '22203e33a70d34549ddeff09fac69098';
export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:52837/oauth/callback';
const AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const TOKEN_URL = 'https://api.linear.app/oauth/token';

export interface OAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
}

type Fetch = typeof globalThis.fetch;

export class OAuthError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

async function tokenRequest(fields: Record<string, string>, fetcher: Fetch, now: () => number): Promise<OAuthCredential> {
  let response: Response;
  try {
    response = await fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new OAuthError('Could not reach Linear to exchange tokens. Check your connection and try again.');
  }
  if (!response.ok) {
    // Do not echo response bodies: a provider or proxy may include credentials.
    let code: unknown;
    try { code = ((await response.json()) as Record<string, unknown>).error; } catch { /* not JSON */ }
    throw new OAuthError(
      code === 'invalid_grant'
        ? 'Linear authorization expired or was revoked. Run `clipissue login` again.'
        : `Linear token exchange failed (HTTP ${response.status}). Run \`clipissue login\` again.`,
      code === 'invalid_grant' ? 'invalid_grant' : undefined,
    );
  }
  let data: Record<string, unknown>;
  try { data = await response.json() as Record<string, unknown>; } catch {
    throw new OAuthError('Linear returned an invalid token response.');
  }
  if (!data || typeof data.access_token !== 'string' || !data.access_token.trim()
    || (data.token_type !== undefined && String(data.token_type).toLowerCase() !== 'bearer')
    || (data.expires_in !== undefined && (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0))) {
    throw new OAuthError('Linear returned an invalid token response.');
  }
  return {
    accessToken: data.access_token,
    ...(typeof data.refresh_token === 'string' && data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    ...(typeof data.expires_in === 'number' ? { expiresAt: now() + data.expires_in * 1000 } : {}),
    clientId: fields.client_id!,
  };
}

export async function refreshOAuth(
  credential: OAuthCredential,
  fetcher: Fetch = (...args) => fetch(...args),
  now: () => number = Date.now,
): Promise<OAuthCredential> {
  if (!credential.refreshToken) throw new OAuthError('Linear authorization expired. Run `clipissue login` again.');
  const updated = await tokenRequest({
    grant_type: 'refresh_token', client_id: credential.clientId, refresh_token: credential.refreshToken,
  }, fetcher, now);
  return { ...updated, refreshToken: updated.refreshToken ?? credential.refreshToken };
}

export function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000, windowsHide: true }, (error) => error ? reject(new Error('Could not open the browser.')) : resolve());
  });
}

interface AuthorizeOptions {
  clientId?: string;
  redirectUri?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onAuthorize: (url: string) => void | Promise<void>;
  fetcher?: Fetch;
  now?: () => number;
}

/** Only binds IPv4 loopback; no client secret or desktop application is needed. */
export async function authorize(options: AuthorizeOptions): Promise<OAuthCredential> {
  const clientId = options.clientId ?? process.env.CLIPISSUE_OAUTH_CLIENT_ID ?? DEFAULT_CLIENT_ID;
  const redirect = new URL(options.redirectUri ?? process.env.CLIPISSUE_OAUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI);
  if (!clientId || redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1'
    || redirect.username || redirect.password || redirect.search || redirect.hash || !redirect.port) {
    throw new OAuthError('OAuth redirect must be an http://127.0.0.1:<port>/path URL without query parameters.');
  }
  if (options.signal?.aborted) throw new OAuthError('Sign-in canceled.');
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // An abort can arrive while binding or opening the browser.
  void codePromise.catch(() => {});
  let accepted = false;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    let url: URL;
    try { url = new URL(request.url ?? '/', redirect.origin); } catch { response.writeHead(400).end('Invalid request.'); return; }
    if (request.headers.host !== redirect.host || url.pathname !== redirect.pathname) {
      response.writeHead(404).end('Not found.'); return;
    }
    if (request.method !== 'GET') { response.writeHead(405).end('Method not allowed.'); return; }
    const receivedState = url.searchParams.get('state') ?? '';
    if (Buffer.byteLength(receivedState) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))) {
      response.writeHead(400).end('Invalid authorization state. Return to the original sign-in tab.'); return;
    }
    if (accepted) { response.writeHead(409).end('Authorization already received.'); return; }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error) {
      accepted = true;
      response.writeHead(400).end('Authorization was not completed. Return to the terminal to try again.');
      rejectCode(new OAuthError(error === 'access_denied' ? 'Linear authorization was denied.' : 'Linear authorization failed. Run `clipissue login` again.'));
    } else if (code) {
      accepted = true;
      response.end('Authorization received. Return to the terminal to finish signing in. You can close this tab.');
      resolveCode(code);
    } else { response.writeHead(400).end('Missing authorization code.'); }
  });
  const abort = () => rejectCode(new OAuthError('Sign-in canceled.'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => rejectCode(new OAuthError('Sign-in timed out. Run `clipissue login` again.')), options.timeoutMs ?? 180_000);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', () => reject(new OAuthError(`Cannot listen on ${redirect.origin}. Close another sign-in process and retry.`)));
      server.listen(Number(redirect.port), '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address && typeof address === 'object') redirect.port = String(address.port);
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: clientId, redirect_uri: redirect.href, response_type: 'code', scope: 'read,write',
      actor: 'user', state, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    await options.onAuthorize(url.href);
    const code = await codePromise;
    if (options.signal?.aborted) throw new OAuthError('Sign-in canceled.');
    return await tokenRequest({
      grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirect.href,
      code, code_verifier: verifier,
    }, options.fetcher ?? ((...args) => fetch(...args)), options.now ?? Date.now);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    server.close();
    server.closeAllConnections();
  }
}
