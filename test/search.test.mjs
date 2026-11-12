import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const mock = fileURLToPath(new URL('./fixtures/mock-fetch.mjs', import.meta.url));

function run(args) {
  const directory = mkdtempSync(join(tmpdir(), 'clipissue-search-'));
  const log = join(directory, 'requests.jsonl');
  try {
    const result = spawnSync(process.execPath, ['--import', mock, entry, ...args, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, CLIPISSUE_API_KEY: 'test-key', CLIPISSUE_TEST_REQUEST_LOG: log },
    });
    const requests = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
    return { ...result, requests };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('search passes positional queries to Linear instead of listing recent issues', () => {
  for (const [args, query] of [
    [['search', 'clipissue'], 'clipissue'],
    [['search', 'login', 'timeout'], 'login timeout'],
    [['search', '--query', 'clipissue'], 'clipissue'],
    [['issues', '--query', 'clipissue'], 'clipissue'],
    [['search', '登录 超时', '--first', '7'], '登录 超时'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { issues: [] });
    assert.equal(result.requests.length, 1);
    assert.match(result.requests[0].query, /searchIssues/);
    assert.equal(result.requests[0].variables.term, query);
    assert.equal(result.requests[0].authorization, 'test-key');
    if (args.includes('--first')) assert.equal(result.requests[0].variables.first, 7);
  }
});

test('empty and conflicting search queries fail without accessing Linear', () => {
  for (const args of [['search'], ['search', '   '], ['search', '--query', ''], ['search', 'one', '--query', 'two']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).success, false);
    assert.equal(result.requests.length, 0);
  }
});
