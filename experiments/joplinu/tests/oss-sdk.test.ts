import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AlibabaOSSProvider } from '../packages/storage-oss/src/index';
import { listAll } from '../packages/storage/src/diagnostics';

// Local wire-format fixture. These tests do not establish compatibility with real Alibaba OSS.
describe('official OSS SDK transport contract (local fixture)', () => {
	let server: Server; let endpoint = '';
	const objects = new Map<string, Buffer>(); const authorizations: string[] = [];
	const source = { accessKeyId: `fixture-${crypto.randomUUID()}`, secretAccessKey: crypto.randomUUID() };
	const xml = (value: string) => value.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);
	let rejectNext = false; let putCount = 0;
	beforeAll(async () => {
		server = createServer(async (request, response) => {
			const url = new URL(request.url!, 'http://localhost'); const key = decodeURIComponent(url.pathname.slice(1));
			authorizations.push(String(request.headers.authorization ?? ''));
			if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
				const prefix = url.searchParams.get('prefix') ?? ''; const offset = Number(url.searchParams.get('continuation-token') ?? 0); const count = Number(url.searchParams.get('max-keys') ?? 1000);
				const matching = [...objects.keys()].filter(key => key.startsWith(prefix)).sort(); const names = matching.slice(offset, offset + count); const more = matching.length > offset + count;
				response.writeHead(200, { 'content-type': 'application/xml' }); response.end(`<ListBucketResult><Name>fixture</Name><Prefix>${xml(prefix)}</Prefix><MaxKeys>${count}</MaxKeys><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${offset + count}</NextContinuationToken>` : ''}${names.map(name => `<Contents><Key>${xml(name)}</Key><LastModified>2026-10-24T00:00:00.000Z</LastModified><ETag>opaque-tag</ETag><Type>Normal</Type><Size>${objects.get(name)!.length}</Size><StorageClass>Standard</StorageClass></Contents>`).join('')}</ListBucketResult>`); return;
			}
			if (request.method === 'PUT') {
				putCount++; const chunks = []; for await (const chunk of request) chunks.push(chunk as Buffer);
				if (rejectNext) { rejectNext = false; response.writeHead(503, { 'content-type': 'application/xml' }); response.end('<Error><Code>ServiceUnavailable</Code><Message>fixture retry</Message></Error>'); return; }
				objects.set(key, Buffer.concat(chunks)); response.writeHead(200, { etag: 'opaque-tag' }); response.end(); return;
			}
			if (request.method === 'DELETE') { objects.delete(key); response.writeHead(204); response.end(); return; }
			const value = objects.get(key);
			if (!value) { response.writeHead(404, { 'content-type': 'application/xml' }); response.end('<Error><Code>NoSuchKey</Code><Message>fixture missing</Message></Error>'); return; }
			response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': value.length, 'last-modified': 'Sat, 24 Oct 2026 00:00:00 GMT', etag: 'opaque-tag' }); response.end(request.method === 'HEAD' ? undefined : value);
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(async () => { server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve())); });
	const provider = () => new AlibabaOSSProvider({ endpoint, bucket: 'fixture', region: 'cn-hangzhou', useCname: true, allowInsecureLocalhost: true, prefix: 'vault/', pageSize: 2, retryDelayMs: 1 }, source);
	it('uses OSS V4 and preserves binary data, metadata, missing-object and delete semantics', async () => {
		const storage = provider(); const value = new Uint8Array([0, 255, 128, 10]); await storage.putObject('中文.bin', value); expect(await storage.getObject('中文.bin')).toEqual(value); expect(await storage.headObject('中文.bin')).toMatchObject({ key: '中文.bin', size: value.length });
		expect(authorizations.every(value => value.startsWith('OSS4-HMAC-SHA256 '))).toBe(true);
		expect(await storage.headObject('missing')).toBeNull(); await expect(storage.getObject('missing')).rejects.toMatchObject({ kind: 'not-found' }); await storage.deleteObject('中文.bin'); expect(await storage.headObject('中文.bin')).toBeNull();
	});
	it('uses OSS continuation tokens and retries a transient SDK request', async () => {
		const storage = provider(); for (let i = 0; i < 5; i++) await storage.putObject(`pages/${i}`, new Uint8Array([i]));
		const result = []; for await (const object of listAll(storage, 'pages/')) result.push(object.key); expect(result).toEqual(Array.from({ length: 5 }, (_, i) => `pages/${i}`));
		const before = putCount; rejectNext = true; await storage.putObject('retry.bin', new Uint8Array([6])); expect(putCount - before).toBe(2); expect(await storage.getObject('retry.bin')).toEqual(new Uint8Array([6]));
	});
});
