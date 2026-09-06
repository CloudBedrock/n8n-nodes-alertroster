#!/usr/bin/env node
// Compare the routes this node calls against the AlertRoster OpenAPI document.
//
// AlertRoster publishes `GET /api/docs/openapi.json`, generated from its
// router, and fails its own build when an endpoint ships undescribed. This
// node is hand-written and had no equivalent, so it drifted silently. This
// script is the equivalent: it exits non-zero when
//
//   * the spec has an operation the node does not call and the allowlist
//     does not excuse (new server surface, or a forgotten operation);
//   * the node calls an operation the spec does not have (a route the server
//     renamed or removed);
//   * the allowlist excuses something that is now implemented, or that the
//     spec no longer has (a stale excuse).
//
// Call sites are found by a static scan for `request('METHOD', 'path')` in
// nodes/ and utils/, which is the only way the node talks to the server (see
// utils/AlertRosterHttp.ts). Template placeholders such as `${id}` and spec
// parameters such as `{id}` are both normalised to `{}` before comparing.
//
//   node scripts/check-openapi-coverage.mjs                # fetch from production
//   node scripts/check-openapi-coverage.mjs --spec URL     # any host, e.g. the dev tunnel
//   node scripts/check-openapi-coverage.mjs --spec ./openapi.json
//   ALERTROSTER_OPENAPI_URL=... node scripts/check-openapi-coverage.mjs
//
// Zero dependencies; Node 20+ for `fetch`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SPEC = 'https://alertroster.com/api/docs/openapi.json';
const SCAN_DIRS = ['nodes', 'utils'];
const ALLOWLIST_PATH = join(ROOT, 'scripts', 'openapi-coverage-allowlist.json');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function parseArgs(argv) {
  const args = { spec: process.env.ALERTROSTER_OPENAPI_URL || DEFAULT_SPEC, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--spec') {
      args.spec = argv[++i];
    } else if (argv[i] === '--verbose' || argv[i] === '-v') {
      args.verbose = true;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.spec) {
    throw new Error('--spec needs a URL or file path');
  }
  return args;
}

async function loadSpec(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Fetching ${source} failed: HTTP ${response.status}`);
    }
    return response.json();
  }
  return JSON.parse(readFileSync(source, 'utf8'));
}

/** `/api/v1/checkins/{id}/arm` and `/api/v1/checkins/${id}/arm` both become `/api/v1/checkins/{}/arm`. */
function normalisePath(path) {
  return path.replace(/\$\{[^}]*\}/g, '{}').replace(/\{[^}]*\}/g, '{}');
}

function specOperations(spec) {
  const ops = new Map();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      if (!item[method]) continue;
      const op = item[method];
      const security = (op.security ?? spec.security ?? [])
        .flatMap((entry) => Object.keys(entry))
        .join('|');
      ops.set(`${method.toUpperCase()} ${normalisePath(path)}`, {
        path,
        summary: op.summary ?? '',
        tag: (op.tags ?? [])[0] ?? '',
        security: security || 'none',
      });
    }
  }
  return ops;
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
    } else if (/\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      yield full;
    }
  }
}

/** Every `'METHOD', 'path'` argument pair passed to a client `request(...)`. */
function nodeOperations() {
  const ops = new Map();
  const pattern = /request(?:<[^>]*>)?\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*(['"`])([^'"`]+)\2/g;
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(pattern)) {
        const key = `${match[1]} ${normalisePath(match[3])}`;
        const line = text.slice(0, match.index).split('\n').length;
        const where = `${relative(ROOT, file)}:${line}`;
        ops.set(key, [...(ops.get(key) ?? []), where]);
      }
    }
  }
  return ops;
}

function loadAllowlist() {
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  const entries = new Map();
  for (const [key, reason] of Object.entries(raw.notImplemented ?? {})) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`Allowlist entry "${key}" needs a reason`);
    }
    entries.set(
      key.replace(/\s+/, ' ').replace(/ (\S+)$/, (_, p) => ` ${normalisePath(p)}`),
      reason,
    );
  }
  return entries;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spec = await loadSpec(args.spec);
  const wanted = specOperations(spec);
  const have = nodeOperations();
  const excused = loadAllowlist();

  const missing = [];
  const covered = [];
  for (const [key, op] of wanted) {
    if (have.has(key)) {
      covered.push(key);
    } else if (!excused.has(key)) {
      missing.push([key, op]);
    }
  }
  const stale = [...have.keys()].filter((key) => !wanted.has(key));
  const excusedButImplemented = [...excused.keys()].filter((key) => have.has(key));
  const excusedButGone = [...excused.keys()].filter((key) => !wanted.has(key));

  const fmt = (key) => `  ${key}`;
  const failures = [];

  if (missing.length) {
    failures.push(
      `${missing.length} operation(s) in the spec that the node does not implement (add them, or excuse each with a reason in scripts/openapi-coverage-allowlist.json):\n` +
        missing.map(([key, op]) => `${fmt(key)}  [${op.security}] ${op.summary}`).join('\n'),
    );
  }
  if (stale.length) {
    failures.push(
      `${stale.length} operation(s) the node calls that the spec does not have (renamed or removed server-side?):\n` +
        stale.map((key) => `${fmt(key)}  <- ${have.get(key).join(', ')}`).join('\n'),
    );
  }
  if (excusedButImplemented.length) {
    failures.push(
      `${excusedButImplemented.length} allowlist entr(y/ies) now implemented; remove from scripts/openapi-coverage-allowlist.json:\n` +
        excusedButImplemented.map(fmt).join('\n'),
    );
  }
  if (excusedButGone.length) {
    failures.push(
      `${excusedButGone.length} allowlist entr(y/ies) no longer in the spec; remove from scripts/openapi-coverage-allowlist.json:\n` +
        excusedButGone.map(fmt).join('\n'),
    );
  }

  const version = spec.info?.version ?? '?';
  console.log(
    `AlertRoster API ${version} from ${args.spec}: ${wanted.size} operations, ` +
      `${covered.length} implemented, ${wanted.size - covered.length - missing.length} excused, ` +
      `${missing.length} missing, ${stale.length} stale.`,
  );
  if (args.verbose) {
    console.log('\nImplemented:');
    for (const key of covered.sort()) console.log(fmt(key));
    console.log('\nExcused:');
    for (const [key, reason] of excused)
      if (wanted.has(key)) console.log(`${fmt(key)}  (${reason})`);
  }
  if (failures.length) {
    console.error('\n' + failures.join('\n\n'));
    process.exitCode = 1;
  } else {
    console.log('Coverage check passed.');
  }
}

main().catch((error) => {
  console.error(`check-openapi-coverage: ${error.message}`);
  process.exitCode = 2;
});
