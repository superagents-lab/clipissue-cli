#!/usr/bin/env node
/**
 * Local convenience: symlink bin/clipissue.mjs into ~/.local/bin.
 */
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'bin', 'clipissue.mjs');
const link = join(homedir(), '.local', 'bin', 'clipissue');
mkdirSync(join(homedir(), '.local', 'bin'), { recursive: true });
// rmSync(force) also replaces a dangling symlink, which existsSync misses.
rmSync(link, { force: true });
symlinkSync(target, link);
console.log(`linked: ${link} -> ${target}`);
