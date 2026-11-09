import { build } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const result = await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  metafile: true,
});

const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const components = path.resolve(input).split(path.sep);
  const modules = components.lastIndexOf('node_modules');
  if (modules < 0) continue;
  const scoped = components[modules + 1].startsWith('@');
  packages.add(components.slice(0, modules + (scoped ? 3 : 2)).join(path.sep));
}

const notices = [];
for (const directory of [...packages].sort()) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const files = (await readdir(directory))
    .filter(name => /^(licen[cs]e|copying|notice)([._-]|$)/i.test(name))
    .sort();
  notices.push('=== ' + manifest.name + ' ' + manifest.version + ' ===');
  if (!files.length) throw new Error('Missing license text for bundled package ' + manifest.name);
  for (const filename of files) {
    notices.push(filename + '\n' + (await readFile(path.join(directory, filename), 'utf8')).trim());
  }
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n') + '\n');
