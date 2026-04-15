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
  banner: {
    // Provide a minimal `process` shim so that config.ts's fromEnv() and
    // log.ts's process.stderr usage gracefully no-op in JSC / Hermes / Electron
    // where the Node.js global is absent.
    js: [
      '(function(){"use strict";',
      'if(typeof process==="undefined"){',
      '  var process={env:{NODE_ENV:"production",PLATFORM:"embedded"},',
      '               stderr:{write:function(){}},',
      '               platform:"embedded",version:"v18.0.0"};',
      '}',
      '})();',
    ].join(''),
  },
  outfile: 'dist/luminclaw-core.js',
  minify: true,
  sourcemap: 'linked',
  metafile: true,
  logLevel: 'info',
});

console.log('✓ Built dist/luminclaw-core.js');
