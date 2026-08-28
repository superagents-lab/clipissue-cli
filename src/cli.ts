/**
 * clipissue — Clipissue CLI.
 *
 * Mirrors the capability set of the Cindy Linear plugin, exposed as shell
 * commands with `--json` output for agents and CI.
 *
 * Credential policy:
 *   - API key lives in macOS Keychain (or a 0600 config file elsewhere);
 *   - `CLIPISSUE_API_KEY` env (legacy: `LINEAR_API_KEY`) is honored for CI,
 *     but never printed;
 *   - the key is never accepted as a CLI argument.
 */

import { clearApiKey, hasApiKey, loadApiKey, saveApiKey } from './credential.ts';
import { describeError, gql, type GqlResult } from './linear.ts';
import { jsonOut, tableOut, type TableColumn } from './output.ts';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Result = { ok: true; value: unknown } | { ok: false; message: string };

interface Flags {
  json: boolean;
  teamKey: string | null;
  query: string | null;
  first: number | null;
  includeArchived: boolean;
  states: string[];
  completedAfter: string | null;
  completedBefore: string | null;
  topLevel: boolean;
  args: string[];
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    json: false,
    teamKey: null,
    query: null,
    first: null,
    includeArchived: false,
    states: [],
    completedAfter: null,
    completedBefore: null,
    topLevel: false,
    args: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    switch (a) {
      case '--json':
        flags.json = true;
        break;
      case '--team':
        flags.teamKey = argv[++i] ?? null;
        break;
      case '--query':
        flags.query = argv[++i] ?? null;
        break;
      case '--first':
        flags.first = Number(argv[++i]);
        break;
      case '--include-archived':
        flags.includeArchived = true;
        break;
      case '--state':
        flags.states.push(
          ...(argv[++i] ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      case '--completed-after':
        flags.completedAfter = argv[++i] ?? null;
        break;
      case '--completed-before':
        flags.completedBefore = argv[++i] ?? null;
        break;
      case '--top-level':
        flags.topLevel = true;
        break;
      default:
        if (a.startsWith('-')) {
          throw new Error(`unknown flag: ${a}`);
        }
        flags.args.push(a);
    }
  }
  return flags;
}

function clampInt(value: number | null, fallback: number, min: number, max: number): number {
  if (value === null || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

// Linear's create/update inputs type these fields as Float. Passing them as
// JSON strings fails GraphQL validation ("Float cannot represent non numeric
// value"), so coerce them to numbers here and validate up front to give the
// user a useful message instead of a raw GraphQL error dump.
const NUMERIC_INPUT_FIELDS = new Set(['priority', 'estimate', 'sortOrder']);

function parseFieldValuePairs(pairs: string[]): Result {
  const input: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return { ok: false, message: `invalid field=value: ${pair}` };
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    if (NUMERIC_INPUT_FIELDS.has(key)) {
      if (!/^-?\d+(\.\d+)?$/.test(raw)) {
        const hint =
          key === 'priority'
            ? ' (priority: 0=none 1=urgent 2=high 3=medium 4=low)'
            : '';
        return { ok: false, message: `${key} must be a number, got "${raw}"${hint}` };
      }
      input[key] = Number(raw);
    } else {
      input[key] = raw;
    }
  }
  return { ok: true, value: input };
}

function withApiKey(fn: (key: string) => Promise<Result>): Promise<Result> {
  const key = loadApiKey();
  if (!key) {
    return Promise.resolve({
      ok: false,
      message: 'No Linear API key found. Run `clipissue login <api-key>` first.',
    });
  }
  return fn(key);
}

function unwrapData(r: GqlResult, path: string[]): Result {
  if (!r.ok) return { ok: false, message: describeError(r) };
  let node: unknown = r.data;
  for (const key of path) {
    if (node && typeof node === 'object' && key in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[key];
    } else {
      return { ok: false, message: `Unexpected Linear response: missing ${key}` };
    }
  }
  return { ok: true, value: node };
}

// --- commands -------------------------------------------------------------

async function cmdLogin(key: string): Promise<Result> {
  saveApiKey(key);
  return { ok: true, value: { success: true, message: 'API key saved to keychain.' } };
}

async function cmdLogout(): Promise<Result> {
  clearApiKey();
  return { ok: true, value: { success: true, message: 'API key removed.' } };
}

async function cmdWhoami(apiKey: string): Promise<Result> {
  const r = await gql(
    apiKey,
    '{ viewer { id name email displayName url } organization { id name urlKey } }',
  );
  if (!r.ok) return { ok: false, message: describeError(r) };
  const data = r.data as { viewer?: Record<string, unknown>; organization?: Record<string, unknown> };
  return {
    ok: true,
    value: {
      viewer: data.viewer ?? {},
      organization: data.organization ?? {},
      apiKey: {
        source: (process.env['CLIPISSUE_API_KEY'] ?? process.env['LINEAR_API_KEY'])
          ? 'env'
          : 'keychain',
        tail: null,
      },
    },
  };
}

async function cmdTeams(apiKey: string, first: number): Promise<Result> {
  const r = await gql(
    apiKey,
    'query($first: Int!) { teams(first: $first) { nodes { id key name description } } }',
    { first },
  );
  return unwrapData(r, ['teams', 'nodes']);
}

async function cmdProjects(apiKey: string, flags: Flags): Promise<Result> {
  const first = clampInt(flags.first, 25, 1, 50);
  const includeArchived = flags.includeArchived;
  const r = await gql(
    apiKey,
    `query($first: Int!, $includeArchived: Boolean) {
      projects(first: $first, includeArchived: $includeArchived, orderBy: updatedAt) {
        nodes {
          id name description state url slugId progress
          teams { nodes { id key name } }
          lead { id name }
        }
      }
    }`,
    { first: Math.min(50, first * 2), includeArchived },
  );
  if (!r.ok) return { ok: false, message: describeError(r) };
  const data = r.data as { projects?: { nodes?: Array<Record<string, unknown>> } };
  let nodes = data.projects?.nodes ?? [];
  if (flags.teamKey) {
    const key = flags.teamKey.trim().toLowerCase();
    nodes = nodes.filter((p) => {
      const teams = (p.teams as { nodes?: Array<{ key?: string }> })?.nodes ?? [];
      return teams.some((t) => String(t.key ?? '').toLowerCase() === key);
    });
  }
  if (flags.query?.trim()) {
    const q = flags.query.trim().toLowerCase();
    nodes = nodes.filter((p) => {
      const name = String(p.name ?? '').toLowerCase();
      const desc = String(p.description ?? '').toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  }
  nodes = nodes.slice(0, first);
  return { ok: true, value: { projects: nodes } };
}

const ISSUE_FIELDS =
  'id identifier title priority url createdAt updatedAt completedAt state { id name type } assignee { id name } team { id key name } project { id name } parent { id identifier }';

const COMMENT_FIELDS =
  'id body url createdAt updatedAt editedAt resolvedAt parent { id } user { id name displayName } externalUser { id name displayName } botActor { id name userDisplayName type subType } onBehalfOf { id name displayName }';

function commentAuthor(comment: Record<string, unknown>): string {
  const user = comment.user as Record<string, unknown> | null | undefined;
  if (user) return String(user.displayName ?? user.name ?? '(unknown)');
  const external = comment.externalUser as Record<string, unknown> | null | undefined;
  if (external) return String(external.displayName ?? external.name ?? '(unknown)');
  const bot = comment.botActor as Record<string, unknown> | null | undefined;
  if (bot) return String(bot.userDisplayName ?? bot.name ?? '(bot)');
  const onBehalf = comment.onBehalfOf as Record<string, unknown> | null | undefined;
  if (onBehalf) return String(onBehalf.displayName ?? onBehalf.name ?? '(unknown)');
  return '(unknown)';
}

function collapseText(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

function commentsFromConnection(connection: { nodes?: unknown[] } | null | undefined): unknown[] {
  const nodes = connection?.nodes ?? [];
  return [...nodes].sort((a, b) => {
    const at = String((a as Record<string, unknown>).createdAt ?? '');
    const bt = String((b as Record<string, unknown>).createdAt ?? '');
    return at.localeCompare(bt);
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildIssueFilter(flags: Flags): Record<string, unknown> | null {
  const filter: Record<string, unknown> = {};
  if (flags.teamKey) filter.team = { key: { eq: flags.teamKey } };
  if (flags.states.length > 0) filter.state = { name: { in: flags.states } };
  if (flags.topLevel) filter.parent = { null: true };
  const completedAt: Record<string, string> = {};
  if (flags.completedAfter) completedAt.gte = flags.completedAfter;
  if (flags.completedBefore) completedAt.lt = flags.completedBefore;
  if (Object.keys(completedAt).length > 0) filter.completedAt = completedAt;
  return Object.keys(filter).length > 0 ? filter : null;
}

async function cmdIssues(apiKey: string, flags: Flags): Promise<Result> {
  const first = clampInt(flags.first, 20, 1, 250);
  const query = flags.query?.trim();
  if (query) {
    const r = await gql(
      apiKey,
      `query($term: String!, $first: Int!) {
        searchIssues(term: $term, first: $first) {
          nodes { ${ISSUE_FIELDS} }
        }
      }`,
      { term: query, first },
    );
    if (!r.ok) return { ok: false, message: describeError(r) };
    return {
      ok: true,
      value: {
        issues: ((r.data as { searchIssues?: { nodes?: unknown[] } }).searchIssues?.nodes ?? []).slice(0, first),
      },
    };
  }
  const filter = buildIssueFilter(flags);
  const r = await gql(
    apiKey,
    `query($first: Int!, $filter: IssueFilter) {
      issues(first: $first, filter: $filter, orderBy: updatedAt) {
        nodes { ${ISSUE_FIELDS} }
      }
    }`,
    { first, filter },
  );
  if (!r.ok) return { ok: false, message: describeError(r) };
  const nodes = (r.data as { issues?: { nodes?: unknown[] } }).issues?.nodes ?? [];
  return { ok: true, value: { issues: nodes } };
}

async function cmdStates(apiKey: string, flags: Flags): Promise<Result> {
  const first = clampInt(flags.first, 100, 1, 250);
  const stateFields = 'id name type position';
  if (flags.teamKey) {
    const r = await gql(
      apiKey,
      `query($key: String!, $first: Int!) {
        teams(filter: { key: { eq: $key } }) {
          nodes {
            id key name
            states(first: $first) { nodes { ${stateFields} } }
          }
        }
      }`,
      { key: flags.teamKey, first },
    );
    if (!r.ok) return { ok: false, message: describeError(r) };
    const team = (r.data as { teams?: { nodes?: Array<{ id: string; key: string; name: string; states?: { nodes?: unknown[] } }> } })
      .teams?.nodes?.[0];
    if (!team) return { ok: false, message: `team not found: ${flags.teamKey}` };
    return {
      ok: true,
      value: {
        team: { id: team.id, key: team.key, name: team.name },
        states: team.states?.nodes ?? [],
      },
    };
  }
  const r = await gql(
    apiKey,
    `query($first: Int!) { workflowStates(first: $first) { nodes { ${stateFields} } } }`,
    { first },
  );
  if (!r.ok) return { ok: false, message: describeError(r) };
  return unwrapData(r, ['workflowStates', 'nodes']);
}

async function cmdViews(apiKey: string, first: number): Promise<Result> {
  const r = await gql(
    apiKey,
    'query($first: Int!) { customViews(first: $first) { nodes { id name description } } }',
    { first },
  );
  if (!r.ok) return { ok: false, message: describeError(r) };
  const nodes = (r.data as { customViews?: { nodes?: unknown[] } }).customViews?.nodes ?? [];
  return { ok: true, value: { views: nodes } };
}

async function resolveViewId(apiKey: string, nameOrId: string): Promise<Result> {
  if (UUID_RE.test(nameOrId)) return { ok: true, value: nameOrId };
  const listed = await cmdViews(apiKey, 250);
  if (!listed.ok) return listed;
  const views = (listed.value as { views: Array<{ id: string; name: string }> }).views;
  const lower = nameOrId.toLowerCase();
  const match =
    views.find((v) => v.name === nameOrId) ?? views.find((v) => String(v.name).toLowerCase() === lower);
  if (!match) return { ok: false, message: `view not found: ${nameOrId}` };
  return { ok: true, value: match.id };
}

async function cmdView(apiKey: string, nameOrId: string, first: number): Promise<Result> {
  const resolved = await resolveViewId(apiKey, nameOrId);
  if (!resolved.ok) return resolved;
  const r = await gql(
    apiKey,
    `query($id: String!, $first: Int!) {
      customView(id: $id) {
        id name
        issues(first: $first) { nodes { ${ISSUE_FIELDS} } }
      }
    }`,
    { id: String(resolved.value), first },
  );
  if (!r.ok) return { ok: false, message: describeError(r) };
  const view = (r.data as { customView?: { id: string; name: string; issues?: { nodes?: unknown[] } } }).customView;
  if (!view) return { ok: false, message: `view not found: ${nameOrId}` };
  return { ok: true, value: { view: { id: view.id, name: view.name }, issues: view.issues?.nodes ?? [] } };
}

async function cmdGet(apiKey: string, id: string, first: number): Promise<Result> {
  const r = await gql(
    apiKey,
    `query($id: String!, $first: Int!) {
      issue(id: $id) {
        ${ISSUE_FIELDS}
        description
        assignee { email }
        labels { nodes { id name } }
        comments(first: $first, orderBy: createdAt) {
          nodes { ${COMMENT_FIELDS} }
        }
      }
    }`,
    { id, first },
  );
  if (!r.ok) return { ok: false, message: describeError(r) };
  const data = r.data as { issue?: { comments?: { nodes?: unknown[] } } | null };
  if (data.issue === null || data.issue === undefined) {
    return { ok: false, message: `issue not found: ${id}` };
  }
  const issue = data.issue;
  return {
    ok: true,
    value: {
      issue: { ...issue, comments: commentsFromConnection(issue.comments) },
    },
  };
}

async function cmdComments(apiKey: string, id: string, first: number): Promise<Result> {
  const r = await gql(
    apiKey,
    `query($id: String!, $first: Int!) {
      issue(id: $id) {
        id identifier title
        comments(first: $first, orderBy: createdAt) {
          nodes { ${COMMENT_FIELDS} }
        }
      }
    }`,
    { id, first },
  );
  if (!r.ok) return { ok: false, message: describeError(r) };
  const issue = (
    r.data as {
      issue?: {
        id: string;
        identifier: string;
        title: string;
        comments?: { nodes?: unknown[] };
      } | null;
    }
  ).issue;
  if (issue === null || issue === undefined) {
    return { ok: false, message: `issue not found: ${id}` };
  }
  return {
    ok: true,
    value: {
      issue: { id: issue.id, identifier: issue.identifier, title: issue.title },
      comments: commentsFromConnection(issue.comments),
    },
  };
}

async function resolveTeamId(apiKey: string, teamKey: string): Promise<string> {
  const r = await gql(
    apiKey,
    'query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name } } }',
    { key: teamKey },
  );
  if (!r.ok) throw new Error(describeError(r));
  const node = (r.data as { teams?: { nodes?: Array<{ id: string }> } }).teams?.nodes?.[0];
  if (!node) throw new Error(`team not found: ${teamKey}`);
  return node.id;
}

// Raw GraphQL input has no `state` field — only stateId. Accept state=<name>
// as a convenience alias and resolve it against the team's workflow states.
async function fetchTeamStates(apiKey: string, teamId: string): Promise<Result> {
  const r = await gql(
    apiKey,
    'query($id: String!) { team(id: $id) { states(first: 100) { nodes { id name type } } } }',
    { id: teamId },
  );
  if (!r.ok) return { ok: false, message: describeError(r) };
  const states =
    (r.data as { team?: { states?: { nodes?: Array<{ id: string; name: string; type: string }> } } })
      .team?.states?.nodes ?? [];
  if (states.length === 0) {
    return { ok: false, message: 'no workflow states found for this team' };
  }
  return { ok: true, value: states };
}

async function resolveStateField(
  apiKey: string,
  teamId: string,
  teamKey: string,
  nameOrType: string,
): Promise<Result> {
  const fetched = await fetchTeamStates(apiKey, teamId);
  if (!fetched.ok) return fetched;
  const states = fetched.value as Array<{ id: string; name: string; type: string }>;
  const lower = nameOrType.toLowerCase();
  const byName =
    states.find((s) => s.name === nameOrType) ??
    states.find((s) => s.name.toLowerCase() === lower);
  if (byName) return { ok: true, value: byName.id };
  const byType = states.filter((s) => s.type.toLowerCase() === lower);
  if (byType.length === 1 && byType[0]) return { ok: true, value: byType[0].id };
  const reason =
    byType.length > 1
      ? `"${nameOrType}" matches multiple states: ${byType.map((s) => s.name).join(', ')}`
      : `unknown state "${nameOrType}"`;
  return {
    ok: false,
    message: `${reason} for team ${teamKey}. States: ${states.map((s) => s.name).join(', ')}. ` +
      `Or pass stateId=<uuid> from \`clipissue states --team ${teamKey} --json\`.`,
  };
}

async function cmdCreate(apiKey: string, flags: Flags): Promise<Result> {
  const title = flags.args[0] ?? '';
  if (!title.trim()) {
    return { ok: false, message: 'title is required: linear create "<title>" [--team KEY]' };
  }
  const teamInput = flags.teamKey;
  if (!teamInput) {
    return { ok: false, message: '--team <key> is required to create an issue' };
  }
  const parsed = parseFieldValuePairs(flags.args.slice(1));
  if (!parsed.ok) return parsed;
  const teamId = await resolveTeamId(apiKey, teamInput);
  const createInput = parsed.value as Record<string, unknown>;
  const stateName = createInput['state'];
  if (typeof stateName === 'string') {
    if (createInput['stateId'] !== undefined) {
      return { ok: false, message: 'pass either state=<name> or stateId=<uuid>, not both' };
    }
    const resolved = await resolveStateField(apiKey, teamId, teamInput, stateName);
    if (!resolved.ok) return resolved;
    createInput['stateId'] = resolved.value;
    delete createInput['state'];
  }
  const input: Record<string, unknown> = {
    teamId,
    title,
    ...(createInput as Record<string, unknown>),
  };
  const r = await gql(
    apiKey,
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier title description url state { name } team { key } } }
    }`,
    { input },
  );
  if (!r.ok) return { ok: false, message: describeError(r) };
  const payload = r.data as { issueCreate?: { success?: boolean; issue?: unknown } };
  if (!payload.issueCreate?.success || !payload.issueCreate.issue) {
    return { ok: false, message: 'Linear did not confirm the issue was created' };
  }
  return { ok: true, value: { issue: payload.issueCreate.issue } };
}

async function cmdUpdate(apiKey: string, flags: Flags): Promise<Result> {
  const id = flags.args[0] ?? '';
  if (!id.trim()) return { ok: false, message: 'id is required: linear update <id> <field=value> ...' };
  const parsed = parseFieldValuePairs(flags.args.slice(1));
  if (!parsed.ok) return parsed;
  const input = parsed.value as Record<string, unknown>;
  if (Object.keys(input).length === 0) {
    return { ok: false, message: 'no fields to update: linear update <id> <field=value> ...' };
  }
  const stateName = input['state'];
  if (typeof stateName === 'string') {
    if (input['stateId'] !== undefined) {
      return { ok: false, message: 'pass either state=<name> or stateId=<uuid>, not both' };
    }
    const got = await gql(
      apiKey,
      'query($id: String!) { issue(id: $id) { team { id key } } }',
      { id },
    );
    if (!got.ok) return { ok: false, message: describeError(got) };
    const team = (got.data as { issue?: { team?: { id: string; key: string } | null } }).issue?.team;
    if (!team) {
      return { ok: false, message: `cannot resolve state=<name>: issue ${id} has no team; pass stateId=<uuid> instead` };
    }
    const resolved = await resolveStateField(apiKey, team.id, team.key, stateName);
    if (!resolved.ok) return resolved;
    input['stateId'] = resolved.value;
    delete input['state'];
  }
  const r = await gql(
    apiKey,
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { id identifier title description url state { name } assignee { name } priority } }
    }`,
    { id, input },
  );
  if (!r.ok) return { ok: false, message: describeError(r) };
  const payload = r.data as { issueUpdate?: { success?: boolean; issue?: unknown } };
  if (!payload.issueUpdate?.success || !payload.issueUpdate.issue) {
    return { ok: false, message: 'Linear did not confirm the issue was updated' };
  }
  return { ok: true, value: { issue: payload.issueUpdate.issue } };
}

async function cmdComment(apiKey: string, rest: string[]): Promise<Result> {
  const issueId = rest[0] ?? '';
  const body = rest[1] ?? '';
  if (!issueId.trim() || !body.trim()) {
    return { ok: false, message: 'usage: clipissue comment <issueId> "<body>"' };
  }
  const r = await gql(
    apiKey,
    `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) { success comment { id body url createdAt } }
    }`,
    { input: { issueId, body } },
  );
  if (!r.ok) return { ok: false, message: describeError(r) };
  const payload = r.data as { commentCreate?: { success?: boolean; comment?: unknown } };
  if (!payload.commentCreate?.success) {
    return { ok: false, message: 'Linear did not confirm the comment was created' };
  }
  return { ok: true, value: { comment: payload.commentCreate.comment } };
}

// --- dispatch -------------------------------------------------------------

// --- skills -----------------------------------------------------------------

// 包根：源码模式是 src/ 的上一级，编译模式是 dist/ 的上一级，两者都是仓库根。
// 单文件二进制（bun build --compile）下 import.meta.url 指向虚拟路径
// （/$bunfs），此时包根没有真实文件，所有读取都需 existsSync / try 保护。
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// 版本号：编译二进制时用 `bun build --define:BUILD_VERSION='"x.y.z"'` 注入；
// 源码 / npm 形态下回退读取 package.json。
declare const BUILD_VERSION: string | undefined;
const PKG_VERSION: string = (() => {
  if (typeof BUILD_VERSION !== 'undefined' && BUILD_VERSION) {
    return BUILD_VERSION;
  }
  try {
    return (
      (
        JSON.parse(
          readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
        ) as { version?: string }
      ).version ?? '0.0.0'
    );
  } catch {
    return '0.0.0';
  }
})();

// SKILL.md 源，按优先级回退：
// 1. 显式环境变量覆盖；
// 2. 二进制安装形态：~/.local/bin/clipissue-cli/skills/clipissue/SKILL.md
//    （GUI 解压的 tar.gz 布局，二进制旁边就是 skills/ 目录）；
// 3. 源码 / npm 形态：包根下的 skills/。
function resolveSkillSource(): string | null {
  const candidates = [
    process.env.CLIPISSUE_SKILL_SOURCE,
    join(dirname(process.execPath), 'skills', 'clipissue', 'SKILL.md'),
    join(dirname(dirname(process.execPath)), 'skills', 'clipissue', 'SKILL.md'),
    join(PACKAGE_ROOT, 'skills', 'clipissue', 'SKILL.md'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

const SKILL_SOURCE = resolveSkillSource();
const AGENTS_SKILLS_DIR = join(homedir(), '.agents', 'skills');
const SKILL_TARGET_DIR = join(AGENTS_SKILLS_DIR, 'clipissue');
const SKILL_TARGET = join(SKILL_TARGET_DIR, 'SKILL.md');

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

async function cmdSkillsInstall(): Promise<Result> {
  if (!SKILL_SOURCE || !existsSync(SKILL_SOURCE)) {
    return { ok: false, message: `skill source not found: ${SKILL_SOURCE ?? '(none)'}` };
  }
  // 开发模式：目标是软链接（指向仓库）时不动它，避免覆盖用户的开发链接。
  if (isSymlink(SKILL_TARGET_DIR) || isSymlink(SKILL_TARGET)) {
    return {
      ok: true,
      value: {
        installed: false,
        skipped: 'symlink',
        path: SKILL_TARGET_DIR,
        message: 'Target is a symlink (dev mode); left untouched.',
      },
    };
  }
  mkdirSync(SKILL_TARGET_DIR, { recursive: true });
  writeFileSync(SKILL_TARGET, readFileSync(SKILL_SOURCE));
  return { ok: true, value: { installed: true, path: SKILL_TARGET } };
}

async function cmdSkillsUninstall(): Promise<Result> {
  // 软链接同样不碰：那是开发者的链接，不是本命令装出来的。
  if (isSymlink(SKILL_TARGET_DIR) || isSymlink(SKILL_TARGET)) {
    return {
      ok: true,
      value: {
        uninstalled: false,
        skipped: 'symlink',
        path: SKILL_TARGET_DIR,
        message: 'Target is a symlink (dev mode); left untouched.',
      },
    };
  }
  if (existsSync(SKILL_TARGET_DIR)) {
    rmSync(SKILL_TARGET_DIR, { recursive: true, force: true });
    return { ok: true, value: { uninstalled: true, path: SKILL_TARGET_DIR } };
  }
  return { ok: true, value: { uninstalled: false, path: SKILL_TARGET_DIR } };
}

async function cmdSkillsStatus(): Promise<Result> {
  const installed = existsSync(SKILL_TARGET_DIR) || existsSync(SKILL_TARGET);
  return {
    ok: true,
    value: {
      installed,
      symlink: installed && (isSymlink(SKILL_TARGET_DIR) || isSymlink(SKILL_TARGET)),
      path: SKILL_TARGET_DIR,
      source: SKILL_SOURCE,
    },
  };
}

function printResult(result: Result, json: boolean, human: () => string): void {
  if (result.ok) {
    if (json) {
      console.log(jsonOut(result.value));
    } else {
      console.log(human());
    }
    process.exitCode = 0;
  } else {
    console.error(JSON.stringify({ success: false, error: result.message }, null, 2));
    process.exitCode = 1;
  }
}

async function run(argv: string[]): Promise<void> {
  // `clipissue --version` / `clipissue -v` shortcut, before flag parsing.
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(PKG_VERSION);
    return;
  }
  let flags: Flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    console.error(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }, null, 2));
    process.exitCode = 1;
    return;
  }

  const command = flags.args[0] ?? '';
  const rest = flags.args.slice(1);

  switch (command) {
    case 'login': {
      const key = rest[0] ?? '';
      if (!key) {
        console.error(JSON.stringify({ success: false, error: 'usage: clipissue login <api-key>' }, null, 2));
        process.exitCode = 1;
        return;
      }
      const result = await cmdLogin(key);
      const message = result.ok ? String((result.value as { message: string }).message) : result.message;
      printResult(result, flags.json, () => message);
      return;
    }
    case 'logout': {
      const result = await cmdLogout();
      const message = result.ok ? String((result.value as { message: string }).message) : result.message;
      printResult(result, flags.json, () => message);
      return;
    }
    case 'whoami': {
      if (!hasApiKey()) {
        printResult(
          { ok: false, message: 'No Linear API key found. Run `clipissue login <api-key>` first.' },
          flags.json,
          () => '',
        );
        return;
      }
      const result = await withApiKey((k) => cmdWhoami(k));
      printResult(
        result,
        flags.json,
        () => {
          const v = (result as { value: { viewer: Record<string, unknown> } }).value.viewer;
          return `Logged in as ${String(v.name ?? v.email ?? 'unknown')}`;
        },
      );
      return;
    }
    case 'teams': {
      const first = clampInt(flags.first, 25, 1, 50);
      const result = await withApiKey((k) => cmdTeams(k, first));
      printResult(
        result,
        flags.json,
        () => {
          const rows = (result as { value: unknown[] }).value as Array<Record<string, unknown>>;
          const cols: TableColumn<Record<string, unknown>>[] = [
            { header: 'KEY', value: (r) => String(r.key ?? '') },
            { header: 'NAME', value: (r) => String(r.name ?? '') },
            { header: 'ID', value: (r) => String(r.id ?? '') },
          ];
          return tableOut(rows, cols);
        },
      );
      return;
    }
    case 'projects': {
      const result = await withApiKey((k) => cmdProjects(k, flags));
      printResult(
        result,
        flags.json,
        () => {
          const rows = (result as { value: { projects: Array<Record<string, unknown>> } }).value.projects;
          const cols: TableColumn<Record<string, unknown>>[] = [
            { header: 'NAME', value: (r) => String(r.name ?? '') },
            { header: 'STATE', value: (r) => String(r.state ?? '') },
            { header: 'PROGRESS', value: (r) => String(r.progress ?? '') },
            { header: 'ID', value: (r) => String(r.id ?? '') },
          ];
          return tableOut(rows, cols);
        },
      );
      return;
    }
    case 'issues':
    case 'search': {
      const result = await withApiKey((k) => cmdIssues(k, flags));
      printResult(
        result,
        flags.json,
        () => {
          const rows = (result as { value: { issues: Array<Record<string, unknown>> } }).value.issues;
          const cols: TableColumn<Record<string, unknown>>[] = [
            { header: 'IDENTIFIER', value: (r) => String(r.identifier ?? '') },
            { header: 'TITLE', value: (r) => String(r.title ?? '') },
            { header: 'STATE', value: (r) => String(((r.state as Record<string, unknown>) ?? {}).name ?? '') },
            { header: 'ID', value: (r) => String(r.id ?? '') },
          ];
          return tableOut(rows, cols);
        },
      );
      return;
    }
    case 'states': {
      const result = await withApiKey((k) => cmdStates(k, flags));
      printResult(
        result,
        flags.json,
        () => {
          const payload = (result as { value: { team?: { key: string; name: string }; states: Array<Record<string, unknown>> } }).value;
          const header = payload.team ? `States for ${payload.team.key} (${payload.team.name})\n` : '';
          const rows = payload.states;
          const cols: TableColumn<Record<string, unknown>>[] = [
            { header: 'NAME', value: (r) => String(r.name ?? '') },
            { header: 'TYPE', value: (r) => String(r.type ?? '') },
            { header: 'POS', value: (r) => String(r.position ?? '') },
            { header: 'ID', value: (r) => String(r.id ?? '') },
          ];
          return header + tableOut(rows, cols);
        },
      );
      return;
    }
    case 'views': {
      const first = clampInt(flags.first, 100, 1, 250);
      const result = await withApiKey((k) => cmdViews(k, first));
      printResult(
        result,
        flags.json,
        () => {
          const rows = (result as { value: { views: Array<Record<string, unknown>> } }).value.views;
          const cols: TableColumn<Record<string, unknown>>[] = [
            { header: 'NAME', value: (r) => String(r.name ?? '') },
            { header: 'ID', value: (r) => String(r.id ?? '') },
          ];
          return tableOut(rows, cols);
        },
      );
      return;
    }
    case 'view': {
      const nameOrId = rest[0] ?? '';
      if (!nameOrId) {
        console.error(JSON.stringify({ success: false, error: 'usage: clipissue view <name|id>' }, null, 2));
        process.exitCode = 1;
        return;
      }
      const first = clampInt(flags.first, 100, 1, 250);
      const result = await withApiKey((k) => cmdView(k, nameOrId, first));
      printResult(
        result,
        flags.json,
        () => {
          const rows = (result as { value: { issues: Array<Record<string, unknown>> } }).value.issues;
          const cols: TableColumn<Record<string, unknown>>[] = [
            { header: 'IDENTIFIER', value: (r) => String(r.identifier ?? '') },
            { header: 'TITLE', value: (r) => String(r.title ?? '') },
            { header: 'STATE', value: (r) => String(((r.state as Record<string, unknown>) ?? {}).name ?? '') },
          ];
          return tableOut(rows, cols);
        },
      );
      return;
    }
    case 'get': {
      const id = rest[0] ?? '';
      if (!id) {
        console.error(JSON.stringify({ success: false, error: 'usage: clipissue get <issueId>' }, null, 2));
        process.exitCode = 1;
        return;
      }
      const first = clampInt(flags.first, 50, 1, 250);
      const result = await withApiKey((k) => cmdGet(k, id, first));
      const getValue = result.ok ? result.value : null;
      printResult(result, flags.json, () => jsonOut(getValue));
      return;
    }
    case 'comments': {
      const id = rest[0] ?? '';
      if (!id) {
        console.error(JSON.stringify({ success: false, error: 'usage: clipissue comments <issueId>' }, null, 2));
        process.exitCode = 1;
        return;
      }
      const first = clampInt(flags.first, 50, 1, 250);
      const result = await withApiKey((k) => cmdComments(k, id, first));
      printResult(result, flags.json, () => {
        const rows = (result as { value: { comments: Array<Record<string, unknown>> } }).value.comments;
        const cols: TableColumn<Record<string, unknown>>[] = [
          { header: 'TIME', value: (r) => String(r.createdAt ?? '') },
          {
            header: 'AUTHOR',
            value: (r) => {
              const name = commentAuthor(r);
              return r.parent ? `↳ ${name}` : name;
            },
          },
          { header: 'BODY', value: (r) => collapseText(String(r.body ?? ''), 80) },
          { header: 'ID', value: (r) => String(r.id ?? '') },
        ];
        return tableOut(rows, cols);
      });
      return;
    }
    case 'create': {
      const result = await withApiKey((k) => cmdCreate(k, { ...flags, args: rest }));
      printResult(result, flags.json, () => {
        const v = (result as { value: { issue: Record<string, unknown> } }).value.issue;
        return `Created ${String(v.identifier ?? v.id ?? '')}: ${String(v.url ?? '')}`;
      });
      return;
    }
    case 'update': {
      const result = await withApiKey((k) => cmdUpdate(k, { ...flags, args: rest }));
      printResult(result, flags.json, () => {
        const v = (result as { value: { issue: Record<string, unknown> } }).value.issue;
        return `Updated ${String(v.identifier ?? v.id ?? '')}`;
      });
      return;
    }
    case 'comment': {
      const result = await withApiKey((k) => cmdComment(k, rest));
      printResult(result, flags.json, () => {
        const v = (result as { value: { comment: Record<string, unknown> } }).value.comment;
        return `Commented ${String(v.url ?? v.id ?? '')}`;
      });
      return;
    }
    case 'skills': {
      const sub = rest[0] ?? '';
      switch (sub) {
        case 'install': {
          const result = await cmdSkillsInstall();
          printResult(result, flags.json, () => {
            const v = (result as { value: { installed?: boolean; message?: string } }).value;
            return v.installed
              ? `Skill installed to ${SKILL_TARGET_DIR}`
              : `Skipped: ${v.message ?? 'unknown'}`;
          });
          return;
        }
        case 'uninstall': {
          const result = await cmdSkillsUninstall();
          printResult(result, flags.json, () => {
            const v = (result as { value: { uninstalled?: boolean; message?: string } }).value;
            return v.uninstalled
              ? `Skill removed from ${SKILL_TARGET_DIR}`
              : `Skipped: ${v.message ?? 'unknown'}`;
          });
          return;
        }
        case 'status': {
          const result = await cmdSkillsStatus();
          printResult(result, flags.json, () => {
            const v = (result as { value: { installed: boolean; symlink: boolean } }).value;
            return v.installed
              ? `Installed (${v.symlink ? 'symlink' : 'copied'}): ${SKILL_TARGET_DIR}`
              : 'Not installed. Run `clipissue skills install`.';
          });
          return;
        }
        default: {
          console.error(
            JSON.stringify(
              { success: false, error: `unknown skills subcommand: ${sub || '(none)'}; use install | uninstall | status` },
              null,
              2,
            ),
          );
          process.exitCode = 1;
          return;
        }
      }
    }
    case 'version':
    case '-v':
    case '--version': {
      console.log(PKG_VERSION);
      return;
    }
    case 'help':
    case '-h':
    case '--help': {
      console.log(helpText());
      return;
    }
    default: {
      console.error(JSON.stringify({ success: false, error: `unknown command: ${command || '(none)'}` }, null, 2));
      console.error('Run `clipissue help` for usage.');
      process.exitCode = 1;
      return;
    }
  }
}

function helpText(): string {
  return `clipissue — Clipissue CLI

Usage:
  clipissue login <api-key>              Save your Linear API key (Keychain)
  clipissue logout                       Remove the saved key
  clipissue whoami [--json]              Show the current user and organization
  clipissue teams [--json] [--first N]   List teams
  clipissue states [--json] [--team KEY] [--first N]   List workflow states (for stateId)
  clipissue projects [--json] [--team KEY] [--query TEXT] [--first N] [--include-archived]
  clipissue issues [--json] [--query TEXT] [--team KEY] [--first N]
                [--state "Todo,In Progress"] [--top-level]
                [--completed-after ISO] [--completed-before ISO]
  clipissue search <query> [--json]      Search issues (alias for issues --query)
  clipissue views [--json] [--first N]   List custom views
  clipissue view <name|id> [--json] [--first N]   Issues in a custom view
  clipissue get <issueId> [--json] [--first N]   Show one issue (includes comments)
  clipissue comments <issueId> [--json] [--first N]   List comments on an issue
  clipissue create "<title>" --team KEY [field=value ...] [--json]
  clipissue update <issueId> <field=value> ... [--json]
  clipissue comment <issueId> "<body>" [--json]

Numeric fields (priority, estimate, sortOrder) are sent as JSON numbers.
priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low.
state=<name> (create/update) resolves the name against the team's workflow
states and sends stateId, e.g. state=Done; unknown names list valid ones.
  clipissue skills install | uninstall | status
  clipissue version                      Print the CLI version

Skills:
  install       Copy the agent skill to ~/.agents/skills/clipissue
  uninstall     Remove the copied skill (symlinks are left untouched)
  status        Show whether the skill is installed

Globals:
  --json                              Machine-readable output
  CLIPISSUE_API_KEY                   Env var alternative to Keychain (CI only;
                                      legacy LINEAR_API_KEY still honored)

The API key is read from macOS Keychain (or CLIPISSUE_API_KEY). It is never
accepted as a CLI argument and never printed.
`;
}

run(process.argv.slice(2));
