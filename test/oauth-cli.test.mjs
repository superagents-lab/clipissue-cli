import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const mock = fileURLToPath(new URL('./fixtures/mock-oauth-fetch.mjs', import.meta.url));

test('CLI login, expiry refresh, 401 retry, whoami and logout work without the desktop app', { skip: process.platform === 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clipissue-oauth-'));
  const log = join(directory, 'requests.jsonl');
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, PATH: `${directory}${delimiter}${process.env.PATH}`,
    CLIPISSUE_OAUTH_CLIENT_ID: 'test-client', CLIPISSUE_OAUTH_REDIRECT_URI: 'http://127.0.0.1:0/oauth/callback', CLIPISSUE_TEST_REQUEST_LOG: log };
  delete env.CLIPISSUE_API_KEY;
  delete env.LINEAR_API_KEY;
  // A temporary security executable isolates macOS tests from the user's Keychain.
  writeFileSync(join(directory, 'security'), `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.HOME + '/keychain.json';
const args = process.argv.slice(2);
let records = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (args[0] === '-i') {
  const input = fs.readFileSync(0, 'utf8');
  const match = input.match(/-w "((?:\\\\.|[^"\\\\])*)"/);
  if (!match) process.exit(1);
  records.oauth = JSON.parse('"' + match[1] + '"');
} else if (args[0] === 'find-generic-password') {
  const value = args.includes('com.clipissue.cli') ? records.oauth : records.apiKey;
  if (!value) process.exit(44);
  process.stdout.write(value);
  process.exit(0);
} else if (args[0] === 'delete-generic-password') {
  delete records[args.includes('com.clipissue.cli') ? 'oauth' : 'apiKey'];
} else if (args[0] === 'add-generic-password') {
  records.apiKey = args[args.indexOf('-w') + 1];
} else process.exit(1);
fs.writeFileSync(file, JSON.stringify(records));
`, { mode: 0o755 });
  const command = (...args) => {
    const result = spawnSync(process.execPath, ['--import', mock, entry, ...args, '--json'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert(!result.stdout.includes('initial-refresh'));
    assert(!result.stdout.includes('rotated-refresh'));
    return JSON.parse(result.stdout);
  };
  let child;
  try {
    child = spawn(process.execPath, ['--import', mock, entry, 'login', '--no-browser', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = '';
    let callback;
    const callbackReady = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stderr.on('data', (data) => {
        stderr += data;
        const match = stderr.match(/https:\/\/linear\.app\/oauth\/authorize\?[^\s]+/);
        if (match && !callback) {
          const authorization = new URL(match[0]);
          callback = new URL(authorization.searchParams.get('redirect_uri'));
          callback.search = new URLSearchParams({ code: 'test-code', state: authorization.searchParams.get('state') }).toString();
          fetch(callback).then(resolve, reject);
        }
      });
      child.once('close', (code) => { if (!callback) reject(new Error(`Login exited ${code}: ${stderr}`)); });
    });
    child.stdout.on('data', (data) => { output += data; });
    const completed = new Promise((resolve, reject) => child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr))));
    await callbackReady;
    await completed;
    assert.equal(JSON.parse(output).method, 'oauth');
    assert(!output.includes('initial-access'));
    assert(!stderr.includes('initial-refresh'));
    assert.equal(command('whoami').authentication.method, 'oauth');
    assert.equal(command('whoami').viewer.name, 'Test user');
    let requests = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(requests.map((x) => x.grant), ['authorization_code', 'refresh_token']);
    assert(requests.every((x) => !x.hasSecret));
    env.CLIPISSUE_TEST_REJECT_ONCE = '1';
    assert.equal(command('whoami').authentication.method, 'oauth');
    requests = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(requests.length, 3);
    delete env.CLIPISSUE_TEST_REJECT_ONCE;
    const oauthFile = join(directory, '.config', 'clipissue', 'oauth.json');
    if (process.platform !== 'darwin') assert.equal(statSync(oauthFile).mode & 0o777, 0o600);
    assert.equal(command('login', 'test-api-key').method, 'api-key');
    if (process.platform === 'darwin') assert.equal(JSON.parse(readFileSync(join(directory, 'keychain.json'), 'utf8')).oauth, undefined);
    else assert(!existsSync(oauthFile));
    assert.equal(command('logout').success, true);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    rmSync(directory, { recursive: true, force: true });
  }
});
