#!/usr/bin/env node
/**
 * Local convenience: symlink bin/linear.mjs into ~/.local/bin.
 */
import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'bin', 'linear.mjs');
const link = join(homedir(), '.local', 'bin', 'linear');
mkdirSync(join(homedir(), '.local', 'bin'), { recursive: true });
if (existsSync(link)) unlinkSync(link);
symlinkSync(target, link);
console.log(`linked: ${link} -> ${target}`);
