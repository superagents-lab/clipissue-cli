import { getAuth } from './auth.ts';

/**
 * Minimal GraphQL client for the Linear API.
 *
 * Every request goes through `gql()` which always resolves to a discriminated
 * result object, so callers can distinguish success, HTTP failure, GraphQL
 * errors, and malformed responses without try/catch.
 */

export const LINEAR_API_URL = 'https://api.linear.app/graphql';

export interface GqlOk {
  ok: true;
  data: unknown;
}

export interface GqlErr {
  ok: false;
  code: string;
  message: string;
}

export type GqlResult = GqlOk | GqlErr;

interface LinearApiErrorBody {
  errors?: Array<{ message?: string }>;
}

export function gql(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<GqlResult> {
  const request = (authorization: string) => fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authorization,
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
  return request(apiKey)
    .then(async (res) => {
      if (res.status === 401 && apiKey.startsWith('Bearer ')) {
        try {
          const refreshed = await getAuth(apiKey);
          if (!refreshed || refreshed.method !== 'oauth') return { ok: false as const, code: 'AUTH_ERROR', message: 'Not logged in. Run `clipissue login`.' };
          res = await request(refreshed.authorization);
        } catch (error) {
          return { ok: false as const, code: 'AUTH_ERROR', message: error instanceof Error ? error.message : 'Could not refresh Linear authorization.' };
        }
      }
      if (!res.ok) {
        return {
          ok: false as const,
          code: `HTTP_${res.status}`,
          message: `Linear API returned HTTP ${res.status}`,
        };
      }
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        return { ok: false as const, code: 'BAD_RESPONSE', message: 'Invalid JSON from Linear API' };
      }
      const body = payload as { data?: unknown; errors?: Array<{ message?: string }> };
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        const message = body.errors
          .map((e) => (e && e.message ? e.message : String(e)))
          .join('; ');
        return { ok: false as const, code: 'GRAPHQL_ERROR', message };
      }
      return { ok: true as const, data: body.data };
    })
    .catch((err: unknown) => ({
      ok: false as const,
      code: 'NETWORK_ERROR',
      message: err instanceof Error ? err.message : String(err),
    }));
}

/** Map Linear API errors to human-actionable CLI messages. */
export function describeError(err: GqlErr): string {
  switch (err.code) {
    case 'HTTP_401':
      return 'Authentication failed: your Linear API key is invalid or revoked. Re-run `clipissue login` to update it.';
    case 'HTTP_403':
      return 'Permission denied: your Linear API key cannot access this resource.';
    case 'HTTP_429':
      return 'Rate limited by Linear API. Wait a moment and try again.';
    case 'HTTP_500':
    case 'HTTP_502':
    case 'HTTP_503':
      return 'Linear API is temporarily unavailable. Try again later.';
    default:
      return err.message;
  }
}
