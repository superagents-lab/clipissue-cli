import { environmentApiKey, loadApiKey, loadOAuth, saveOAuth, withOAuthLock } from './credential.ts';
import { refreshOAuth, type OAuthCredential } from './oauth.ts';

export interface Auth {
  authorization: string;
  method: 'oauth' | 'api-key';
  source: 'env' | 'keychain' | 'config-file';
}

interface Dependencies {
  environmentKey: () => string | null;
  apiKey: () => string | null;
  load: () => OAuthCredential | null;
  save: (credential: OAuthCredential) => void;
  lock: <T>(operation: () => Promise<T>) => Promise<T>;
  refresh: (credential: OAuthCredential) => Promise<OAuthCredential>;
  now: () => number;
  source: 'keychain' | 'config-file';
}

export function createAuthManager(deps: Dependencies) {
  const oauthAuth = (credential: OAuthCredential): Auth => ({ authorization: `Bearer ${credential.accessToken}`, method: 'oauth', source: deps.source });
  return async function getAuth(rejectedAuthorization?: string): Promise<Auth | null> {
    const environment = deps.environmentKey();
    if (environment) return { authorization: environment, method: 'api-key', source: 'env' };
    const credential = deps.load();
    if (!credential) {
      const key = deps.apiKey();
      return key ? { authorization: key, method: 'api-key', source: deps.source } : null;
    }
    const needsRefresh = (value: OAuthCredential) =>
      (value.expiresAt !== undefined && value.expiresAt <= deps.now() + 60_000)
      || rejectedAuthorization === `Bearer ${value.accessToken}`;
    if (!needsRefresh(credential)) return oauthAuth(credential);
    return deps.lock(async () => {
      // Another process may have already refreshed, logged in, or logged out.
      const current = deps.load();
      if (!current) throw new Error('CLI authorization changed. Run `clipissue login` again.');
      if (!needsRefresh(current)) return oauthAuth(current);
      const refreshed = await deps.refresh(current);
      deps.save(refreshed);
      return oauthAuth(refreshed);
    });
  };
}

export const getAuth = createAuthManager({
  environmentKey: environmentApiKey, apiKey: loadApiKey, load: loadOAuth, save: saveOAuth,
  lock: withOAuthLock, refresh: refreshOAuth, now: Date.now,
  source: process.platform === 'darwin' ? 'keychain' : 'config-file',
});
