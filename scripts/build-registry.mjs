import { readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadManifest } from '../src/manifest.mjs';
import { componentReadiness } from './registry-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../registry');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function buildRegistry(sourceRoot = root) {
  const catalog = JSON.parse(readFileSync(resolve(sourceRoot, 'catalog.source.json')));
  const assets = {};
  const ids = new Set();
  function asset(file) {
    if (!/^(loops|components|demos|authors|examples)\/[a-z0-9-]+\.(yaml|json|txt)$/.test(file)) throw Error('Unsafe registry path');
    if (lstatSync(resolve(sourceRoot, file.split('/')[0])).isSymbolicLink() || lstatSync(resolve(sourceRoot, file)).isSymbolicLink()) throw Error('Registry symlink');
    return assets[file] ??= readFileSync(resolve(sourceRoot, file));
  }
  for (const section of ['loops', 'components', 'demos']) {
    for (const entry of catalog[section]) {
      const key = `${section}/${entry.id}`;
      if (!/^[a-z0-9-]+$/.test(entry.id) || ids.has(key)) throw Error('Invalid or duplicate entry');
      ids.add(key);
      if (entry.license !== 'MIT') throw Error('Registry license requires review');
      if (entry.engine?.version !== catalog.core.version) throw Error('Engine pin mismatch');
      const file = entry.file ?? `${key}.json`;
      entry.sha256 = sha(asset(file));
      if (section === 'loops') {
        if (typeof entry.value !== 'string' || !entry.value.trim()) throw Error('Loop value is required');
        const manifest = loadManifest(resolve(sourceRoot, file));
        if (manifest.id !== entry.id || manifest.version !== entry.version) throw Error('Manifest identity mismatch');
      }
      if (entry.proof) asset(entry.proof);
      asset(`authors/${entry.author}.json`);
    }
  }
  const composition = JSON.parse(readFileSync(resolve(sourceRoot, 'composition.json')));
  if (composition.schemaVersion !== 1 || !Array.isArray(composition.templates)) throw Error('Invalid composition contract');
  const templateIds = new Set();
  for (const template of composition.templates) {
    if (!template.id || templateIds.has(template.id) || template.contentType !== 'loop-template' || !template.value?.trim()) throw Error('Invalid template contract');
    templateIds.add(template.id);
    template.readiness = componentReadiness(template, [...catalog.components, ...(composition.builtins ?? [])]);
  }
  for (const entry of [...catalog.loops, ...catalog.components]) componentReadiness(entry, [...catalog.components, ...(composition.builtins ?? [])]);
  catalog.composition = composition;
  for (const demo of catalog.demos) if (!catalog.loops.some(loop => loop.id === demo.loopId) && !composition.templates.some(template => template.id === demo.loopId)) throw Error('Missing demo loop');
  delete catalog.releaseSha256;
  catalog.releaseSha256 = sha(JSON.stringify(catalog));
  return { catalog, assets };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { catalog, assets } = buildRegistry();
  const index = process.argv.indexOf('--export');
  const destination = index < 0 ? root : resolve(process.argv[index + 1]);
  const files = { 'catalog.json': JSON.stringify(catalog, null, 2) + '\n', ...assets, 'composition.json': JSON.stringify(catalog.composition, null, 2) + '\n', LICENSE: readFileSync(resolve(root, 'LICENSE')) };
  if (process.argv.includes('--check')) {
    if (readFileSync(resolve(root, 'catalog.json'), 'utf8') !== files['catalog.json']) throw Error('Generated catalog drift');
  } else {
    for (const [file, body] of Object.entries(files)) {
      const path = resolve(destination, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body);
    }
    writeFileSync(resolve(destination, 'SHA256SUMS'), Object.entries(files).map(([file, body]) => `${sha(body)}  ${file}`).sort().join('\n') + '\n');
  }
  console.log(JSON.stringify({ version: catalog.releaseVersion, entries: catalog.loops.length + catalog.components.length + catalog.demos.length }));
}
