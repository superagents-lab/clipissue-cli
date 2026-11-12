import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// A publish dry run still needs a real local tarball for the installation test.
const npmEnv = { ...process.env, npm_config_dry_run: 'false' };

test('the npm tarball runs without source files and includes the installable skill', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'clipissue-package-'));
  try {
    const [packed] = JSON.parse(execFileSync(npm, [
      'pack', '--json', '--ignore-scripts', '--pack-destination', temporary,
    ], { cwd: root, env: npmEnv, encoding: 'utf8' }));
    const files = new Set(packed.files.map((file) => file.path));
    assert(files.has('dist/cli.js'));
    assert(files.has('skills/clipissue/SKILL.md'));
    assert(![...files].some((file) => file.startsWith('src/')));

    execFileSync(npm, [
      'install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund',
      join(temporary, packed.filename),
    ], { env: npmEnv, encoding: 'utf8' });
    const entry = join(temporary, 'node_modules', '@fatwang2', 'clipissue', 'bin', 'clipissue.mjs');
    const env = { ...process.env, HOME: temporary, USERPROFILE: temporary };
    delete env.CLIPISSUE_SKILL_SOURCE;
    const run = (...args) => execFileSync(process.execPath, [entry, ...args], {
      cwd: temporary, env, encoding: 'utf8',
    }).trim();
    const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(run('--version'), metadata.version);
    assert.match(run('help'), /clipissue create/);
    const status = JSON.parse(run('skills', 'status', '--json'));
    assert.equal(status.installed, false);
    assert.match(status.source, /skills[\\/]clipissue[\\/]SKILL\.md$/);
    const installed = JSON.parse(run('skills', 'install', '--json'));
    assert.equal(installed.installed, true);
    assert(existsSync(join(temporary, '.agents', 'skills', 'clipissue', 'SKILL.md')));
    assert.equal(JSON.parse(run('skills', 'uninstall', '--json')).uninstalled, true);
    const invalid = spawnSync(process.execPath, [entry, 'skills', 'not-a-command', '--json'], {
      cwd: temporary, env, encoding: 'utf8',
    });
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stderr).success, false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

// Source checkouts use Node's type stripping rather than the compiled tarball.
const [major, minor] = process.versions.node.split('.').map(Number);
test('source entrypoint runs on Node versions with type stripping', { skip: major < 22 || (major === 22 && minor < 6) }, () => {
  const output = execFileSync(process.execPath, [join(root, 'bin', 'clipissue.mjs'), 'help'], {
    env: { ...process.env, CLIPISSUE_USE_DIST: '0' }, encoding: 'utf8',
  });
  assert.match(output, /Sign in with Linear OAuth/);
});
