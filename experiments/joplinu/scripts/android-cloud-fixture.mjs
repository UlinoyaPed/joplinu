import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from './artifacts.mjs';

// Isolated real S3 service for the existing native CI job. Never uses personal cloud credentials.
const directory = await mkdtemp(join(tmpdir(), 'joplinu-android-cloud-'));
await build({ entryPoints: [join(root, 'tests/integration/server.ts')], outfile: join(directory, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
const { RealS3Server } = createRequire(import.meta.url)(join(directory, 'service.cjs'));
const service = new RealS3Server(); let bootstrap;
let closing = false;
async function close() { if (closing) return; closing = true; bootstrap?.closeAllConnections(); bootstrap?.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
process.once('SIGINT', () => void close().finally(() => process.exit(0)));
try {
	await service.start();
	bootstrap = createServer((request, response) => {
		response.setHeader('content-type', 'application/json'); response.setHeader('cache-control', 'no-store');
		if (request.url === '/ready') { response.end('{"ready":true}'); return; }
		if (request.url !== '/config') { response.writeHead(404); response.end('{}'); return; }
		response.end(JSON.stringify({ config: { kind: 's3', endpoint: service.endpoint.replace('127.0.0.1', '10.0.2.2'), bucket: service.bucket, region: 'us-east-1', prefix: `android/${crypto.randomUUID()}`, forcePathStyle: true, useCname: false }, credentials: service.credentials, persist: true }));
	});
	await new Promise(resolve => bootstrap.listen(10081, '127.0.0.1', resolve));
	console.log('Android real S3 fixture ready; temporary credentials are only served on runner loopback.');
} catch { await close(); throw new Error('Android real S3 fixture could not start'); }
