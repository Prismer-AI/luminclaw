// esbuild.embedded.mjs
// Builds dist/luminclaw-core.js — single-file IIFE for JavaScriptCore (iOS),
// Hermes (Android), Electron, etc.
//
// Run: node esbuild.embedded.mjs

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

await build({
  entryPoints: ['src/embedded.ts'],
  bundle: true,
  platform: 'neutral',
  format: 'iife',
  globalName: 'LuminClaw',
  target: ['es2022'],
  external: [],
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.PLATFORM': '"embedded"',
    '__VERSION__': JSON.stringify(pkg.version),
  },
  outfile: 'dist/luminclaw-core.js',
  minify: true,
  sourcemap: 'linked',
  metafile: true,
  logLevel: 'info',
});

console.log('✓ Built dist/luminclaw-core.js');
