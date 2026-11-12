/**
 * Credential management for the Linear CLI.
 *
 * On macOS the API key is stored in the user's Keychain via `security`
 * (login-keychain, generic password). It shares the exact same entry with
 * Clipissue (menu-bar app): whatever you save in either app is immediately
 * usable in the other. On Linux/Windows it falls back to a user-scoped
 * config file with 0600 permissions.
 *
 * The key is never accepted as a CLI flag, and never printed to stdout.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { OAuthCredential } from './oauth.ts';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// 统一凭据命名空间：与 Clipissue 共用同一 Keychain 条目。
const SERVICE = 'com.clipissue.mac';
const ACCOUNT = 'linear-api-key';
// 历史命名（改名前应用用的 app.linearlite、v0.1.0 前 CLI 用的 com.fatwang2.linear-cli），
// 仅用于把已保存的 Key 迁移到新命名空间。
const LEGACY_SERVICES = ['app.linearlite', 'com.fatwang2.linear-cli'];
const CONFIG_PATH = join(homedir(), '.config', 'clipissue', 'credentials.json');
// 改名前的配置路径，仅读取兜底，不再写入。
const LEGACY_CONFIG_PATH = join(homedir(), '.config', 'linear-cli', 'credentials.json');

function isMac(): boolean {
  return process.platform === 'darwin';
}

function security(args: string[]): string {
  const r = spawnSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    const stderr = (r.stderr || '').trim();
    throw new Error(stderr || `security ${args[0]} failed`);
  }
  return (r.stdout || '').trim();
}

function readConfigFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const value = data['api_key'];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readConfig(): string | null {
  return readConfigFile(CONFIG_PATH) ?? readConfigFile(LEGACY_CONFIG_PATH);
}

function writeConfig(value: string): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify({ api_key: value }, null, 2), { mode: 0o600 });
}

export function loadApiKey(): string | null {
  const fromEnv = process.env['CLIPISSUE_API_KEY'] ?? process.env['LINEAR_API_KEY'];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (isMac()) {
    // 新命名空间（与 Clipissue 共用）
    try {
      const primary = security([
        'find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w',
      ]);
      if (primary) return primary;
    } catch {
      // not present → try legacy
    }
    // 历史命名空间迁移：读到即写回新位置并删除旧条目。
    for (const legacyService of LEGACY_SERVICES) {
      try {
        const legacy = security([
          'find-generic-password', '-s', legacyService, '-a', ACCOUNT, '-w',
        ]);
        if (legacy) {
          saveApiKey(legacy);
          clearLegacyApiKey();
          return legacy;
        }
      } catch {
        // no legacy entry
      }
    }
  }
  return readConfig();
}

export function saveApiKey(value: string): void {
  const key = value.trim();
  if (!key) throw new Error('API key is empty');
  if (isMac()) {
    // Legacy API key login passes the key to the system security tool.
    const update = spawnSync(
      'security',
      ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-U', '-w', key],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (update.status !== 0) {
      const stderr = (update.stderr || '').trim();
      throw new Error(stderr || 'failed to save API key to Keychain');
    }
    return;
  }
  writeConfig(key);
}

export function clearApiKey(): void {
  if (isMac()) {
    try {
      security(['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
    } catch {
      // not present is fine
    }
    clearLegacyApiKey();
  }
  for (const path of [CONFIG_PATH, LEGACY_CONFIG_PATH]) {
    rmSync(path, { force: true });
  }
}

function clearLegacyApiKey(): void {
  for (const legacyService of LEGACY_SERVICES) {
    try {
      security(['delete-generic-password', '-s', legacyService, '-a', ACCOUNT]);
    } catch {
      // not present is fine
    }
  }
}

export function hasApiKey(): boolean {
  return loadApiKey() !== null;
}

// CLI OAuth is intentionally separate from the desktop app's saved API key.
const OAUTH_SERVICE = 'com.clipissue.cli';
const OAUTH_ACCOUNT = 'linear-oauth';
const OAUTH_PATH = join(homedir(), '.config', 'clipissue', 'oauth.json');
const OAUTH_LOCK = join(homedir(), '.config', 'clipissue', 'oauth.lock');

export function environmentApiKey(): string | null {
  return (process.env.CLIPISSUE_API_KEY ?? process.env.LINEAR_API_KEY)?.trim() || null;
}

export function loadOAuth(): OAuthCredential | null {
  let raw: string;
  if (isMac()) {
    const result = spawnSync('security', ['find-generic-password', '-s', OAUTH_SERVICE, '-a', OAUTH_ACCOUNT, '-w'], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 44) return null; // errSecItemNotFound
    if (result.status !== 0) throw new Error('Could not read CLI OAuth credentials from Keychain. Unlock the login keychain and retry.');
    raw = result.stdout.trim();
  } else {
    try { raw = readFileSync(OAUTH_PATH, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Could not read CLI OAuth credentials. Check configuration file permissions.');
    }
  }
  try {
    const value = JSON.parse(raw) as OAuthCredential;
    if (!value || typeof value.accessToken !== 'string' || !value.accessToken || typeof value.clientId !== 'string' || !value.clientId
      || (value.refreshToken !== undefined && (typeof value.refreshToken !== 'string' || !value.refreshToken))
      || (value.expiresAt !== undefined && (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)))) throw new Error();
    return value;
  } catch { throw new Error('Saved CLI OAuth credentials are invalid. Run `clipissue login` again.'); }
}

export function saveOAuth(value: OAuthCredential): void {
  const serialized = JSON.stringify(value);
  if (isMac()) {
    // security's interactive mode takes the secret on stdin, keeping it out of process arguments.
    const escaped = serialized.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const result = spawnSync('security', ['-i'], {
      input: `add-generic-password -s ${OAUTH_SERVICE} -a ${OAUTH_ACCOUNT} -U -w "${escaped}"\n`,
      encoding: 'utf8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Interactive security can exit 0 even when the command reports an error.
    if (result.status !== 0 || /SecKeychain|error:|Error:/i.test(result.stderr)) {
      throw new Error('Could not save CLI OAuth credentials to Keychain.');
    }
    const saved = loadOAuth();
    if (saved?.accessToken !== value.accessToken || saved.refreshToken !== value.refreshToken
      || saved.clientId !== value.clientId || saved.expiresAt !== value.expiresAt) {
      throw new Error('Could not verify saved CLI OAuth credentials in Keychain.');
    }
  } else {
    mkdirSync(dirname(OAUTH_PATH), { recursive: true, mode: 0o700 });
    const temporary = `${OAUTH_PATH}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, OAUTH_PATH);
    } finally { rmSync(temporary, { force: true }); }
  }
}

export function clearOAuth(): void {
  if (isMac()) {
    const result = spawnSync('security', ['delete-generic-password', '-s', OAUTH_SERVICE, '-a', OAUTH_ACCOUNT], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0 && result.status !== 44) throw new Error('Could not remove CLI OAuth credentials from Keychain.');
  } else { rmSync(OAUTH_PATH, { force: true }); }
}

/** Serialize refreshes across CLI processes so rotated tokens are saved as one pair. */
export async function withOAuthLock<T>(operation: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(OAUTH_LOCK), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 25_000;
  while (true) {
    try { mkdirSync(OAUTH_LOCK, { mode: 0o700 }); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Could not lock CLI OAuth credentials.');
      try {
        // Token requests time out after 15 seconds. Recover a lock left by a crashed process.
        if (Date.now() - statSync(OAUTH_LOCK).mtimeMs > 60_000) { rmSync(OAUTH_LOCK, { recursive: true, force: true }); continue; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error('Could not inspect CLI OAuth credential lock.');
      }
      if (Date.now() >= deadline) throw new Error('Another CLI process is updating OAuth credentials. Retry shortly.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await operation(); } finally { rmSync(OAUTH_LOCK, { recursive: true, force: true }); }
}
