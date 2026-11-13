#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readZipEntries } from './zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'kovi.koplugin');
const PLUGIN_ZIP = path.join(ROOT, 'public', 'kovi-plugin.zip');
const CONST_FILE = path.join(PLUGIN_DIR, 'const.lua');
const META_FILE = path.join(PLUGIN_DIR, '_meta.lua');
const SERVER_FILE = path.join(ROOT, 'server.mjs');
const COVERS_FILE = path.join(ROOT, 'lib', 'covers.mjs');
const PACKAGE_FILE = path.join(ROOT, 'package.json');
const CALVER = /^\d{4}\.\d{2}\.\d{2}$/;
const PLUGIN_VERSION_PATTERN = /VERSION\s*=\s*"([^"]+)"/;
const META_VERSION_PATTERN = /\(v[\d.]+\)/;

const read = (file) => fs.readFileSync(file, 'utf8');
const firstGroup = (source, pattern) => (pattern.exec(source) || [])[1];
const zipName = (name) => name.slice(name.indexOf('/') + 1);

export function versions() {
  return {
    app: JSON.parse(read(PACKAGE_FILE)).version,
    plugin: firstGroup(read(CONST_FILE), PLUGIN_VERSION_PATTERN),
  };
}

function versionParts(value) {
  return String(value || '0').split('.').map((part) => Number.parseInt(part, 10) || 0).slice(0, 3);
}

function versionAtLeast(value, minimum) {
  const a = versionParts(value);
  const b = versionParts(minimum);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

function checkZip(problems) {
  const entries = new Map([...readZipEntries(PLUGIN_ZIP)]
    .filter(([name]) => !name.endsWith('/'))
    .map(([name, data]) => [zipName(name), data]));
  const source = new Map(fs.readdirSync(PLUGIN_DIR)
    .filter((name) => fs.statSync(path.join(PLUGIN_DIR, name)).isFile())
    .map((name) => [name, fs.readFileSync(path.join(PLUGIN_DIR, name))]));
  for (const [name, data] of source) {
    const packaged = entries.get(name);
    if (!packaged) problems.push(`public/kovi-plugin.zip is missing ${name}`);
    else if (!packaged.equals(data)) problems.push(`public/kovi-plugin.zip has a stale ${name}`);
  }
  for (const name of entries.keys()) {
    if (!source.has(name)) problems.push(`public/kovi-plugin.zip contains stale ${name}`);
  }
}

export function check() {
  const problems = [];
  const { app, plugin } = versions();
  const server = read(SERVER_FILE);
  if (!CALVER.test(app || '')) problems.push(`package.json version "${app}" is not CalVer`);
  if (!CALVER.test(plugin || '')) problems.push(`plugins/kovi.koplugin/const.lua version "${plugin}" is not CalVer`);

  const serverVersion = firstGroup(server, /const VERSION = '([^']+)'/);
  if (serverVersion !== app) problems.push(`server.mjs VERSION is ${serverVersion}, expected ${app} from package.json`);
  const coversVersion = firstGroup(read(COVERS_FILE), /const VERSION = '([^']+)'/);
  if (coversVersion !== app) problems.push(`lib/covers.mjs VERSION is ${coversVersion}, expected ${app} from package.json`);

  if (/const LATEST_PLUGIN_VERSION = ['"]/.test(server)) problems.push('server.mjs must derive LATEST_PLUGIN_VERSION from plugins/kovi.koplugin/const.lua');
  for (const name of ['MIN_COVER_PLUGIN_VERSION', 'MIN_INCREMENTAL_PLUGIN_VERSION']) {
    const floor = firstGroup(server, new RegExp(`const ${name} = '([^']+)'`));
    if (!floor) problems.push(`server.mjs is missing ${name}`);
    else if (!versionAtLeast(plugin, floor)) problems.push(`${name} (${floor}) is newer than the plugin version (${plugin})`);
  }

  if (!read(META_FILE).includes(`(v${plugin})`)) problems.push(`plugins/kovi.koplugin/_meta.lua must describe version v${plugin}`);
  checkZip(problems);
  return problems;
}

export function write() {
  const { app, plugin } = versions();
  const sync = (file, pattern, value) => {
    const source = read(file);
    const next = source.replace(pattern, value);
    if (next !== source) fs.writeFileSync(file, next);
  };
  sync(SERVER_FILE, /const VERSION = '[^']+'/, `const VERSION = '${app}'`);
  sync(COVERS_FILE, /const VERSION = '[^']+'/, `const VERSION = '${app}'`);
  sync(META_FILE, META_VERSION_PATTERN, `(v${plugin})`);
  const result = spawnSync('zip', ['-FSr', path.relative(path.join(ROOT, 'plugins'), PLUGIN_ZIP), 'kovi.koplugin'], {
    cwd: path.join(ROOT, 'plugins'),
    stdio: 'inherit',
  });
  if (result.error) throw new Error(`Cannot rebuild public/kovi-plugin.zip: ${result.error.message}`);
  if (result.status !== 0) throw new Error('zip failed while rebuilding public/kovi-plugin.zip');
}

const cli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (cli) {
  if (process.argv.includes('--write')) write();
  const problems = check();
  if (problems.length) {
    console.error('kovi version check failed:');
    for (const problem of problems) console.error(` - ${problem}`);
    process.exitCode = 1;
  } else {
    const { app, plugin } = versions();
    console.log(`kovi versions OK · app ${app} · plugin ${plugin}`);
  }
}
