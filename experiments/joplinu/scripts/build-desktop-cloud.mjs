import { build } from 'esbuild';
import { root } from './artifacts.mjs';
import { join } from 'node:path';
await build({ entryPoints: [join(root, 'packages/platform-host/src/cloud.ts')], outfile: join(root, 'apps/desktop/cloud.bundle.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'warning', plugins: [{ name: 'urllib-proxy-adapter', setup(build) { build.onResolve({ filter: /^proxy-agent$/ }, args => /[\\/]urllib[\\/]/.test(args.importer) ? { path: join(root, 'packages/platform-host/src/legacy-proxy.cjs') } : undefined); } }] });
