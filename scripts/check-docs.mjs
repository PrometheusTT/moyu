#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['.git', '.claude', 'dist', 'node_modules', 'vendor']);
const markdownFiles = [];

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) collect(join(directory, entry.name));
      continue;
    }
    if (entry.isFile() && extname(entry.name) === '.md') markdownFiles.push(join(directory, entry.name));
  }
}

function localTarget(raw) {
  let target = raw.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  if (/^(?:[a-z][a-z+.-]*:|#)/i.test(target)) return undefined;
  target = target.split('#', 1)[0].split('?', 1)[0];
  if (target === '') return undefined;
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

collect(root);

const missing = [];
const markdownLink = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/g;
const htmlLink = /\b(?:href|src)=["']([^"']+)["']/gi;

for (const file of markdownFiles) {
  const source = readFileSync(file, 'utf8');
  for (const pattern of [markdownLink, htmlLink]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const target = localTarget(match[1]);
      if (target === undefined) continue;
      const absolute = target.startsWith('/') ? resolve(root, `.${target}`) : resolve(dirname(file), target);
      if (!existsSync(absolute)) missing.push(`${relative(root, file)} -> ${target}`);
    }
  }
}

if (missing.length > 0) {
  console.error('Broken local documentation links:\n');
  for (const item of missing) console.error(`- ${item}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation links OK (${markdownFiles.length} Markdown files).`);
}
