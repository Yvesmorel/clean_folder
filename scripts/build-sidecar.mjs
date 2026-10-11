import { build } from 'esbuild';
import { exec as pkg } from '@yao-pkg/pkg';
import * as fs from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
await fs.mkdir(path.join(root, 'sidecar/build'), { recursive: true });
await fs.mkdir(path.join(root, 'src-tauri/binaries'), { recursive: true });
const bundle = path.join(root, 'sidecar/build/worker.cjs');
await build({ entryPoints: ['sidecar/main.mjs'], outfile: bundle, bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  define: { 'import.meta.url': 'undefined' }, minify: false, sourcemap: false });
if (!process.argv.includes('--bundle-only')) {
  const targets = { win32: ['node22-win-x64', 'x86_64-pc-windows-msvc.exe'],
    linux: ['node22-linux-x64', 'x86_64-unknown-linux-gnu'], darwin: ['node22-macos-x64', 'x86_64-apple-darwin'] };
  const windows = process.argv.includes('--windows');
  if (process.arch !== 'x64' && !windows) throw new Error('This build configuration targets x64. Use a Windows x64 builder for distribution.');
  const [target, suffix] = targets[windows ? 'win32' : process.platform] ?? [];
  if (!target) throw new Error('Unsupported build platform.');
  const output = path.join(root, `src-tauri/binaries/clean-folder-worker-${suffix}`);
  await pkg([bundle, '--target', target, '--output', output]);
  console.log(`Bundled Node.js engine: ${output}`);
}
