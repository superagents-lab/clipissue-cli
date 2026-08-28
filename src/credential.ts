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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    // Update in place so the key never appears in `ps`.
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
    return;
  }
  if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH, { force: true });
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
