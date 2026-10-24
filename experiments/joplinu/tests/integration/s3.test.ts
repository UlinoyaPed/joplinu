import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { S3CompatibleProvider } from '../../packages/storage-s3/src/index';
import { listAll, probeStorage } from '../../packages/storage/src/diagnostics';
import type { StorageCredentials } from '../../packages/storage/src/index';
import { RealS3Server } from './server';
import { FaultProxy } from './fault-proxy';

describe('real SeaweedFS S3 API with AWS SDK v3', () => {
	const server = new RealS3Server();
	const instances: S3CompatibleProvider[] = [];
	const prefix = `integration/${crypto.randomUUID()}`;
	const provider = (extra: Partial<ConstructorParameters<typeof S3CompatibleProvider>[0]> = {}, readonly = false) => {
		const result = new S3CompatibleProvider({ endpoint: server.endpoint, bucket: server.bucket, region: 'us-east-1', forcePathStyle: true, prefix, pageSize: 2, allowInsecureLocalhost: true, retryDelayMs: 5, timeoutMs: 5000, ...extra }, readonly ? server.readerCredentials : server.credentials); instances.push(result); return result;
	};
	beforeAll(async () => { try { await server.start(); } catch (error) { await server.close(); throw error; } }, 90000);
	afterAll(async () => { for (const instance of instances) instance.close(); await server.close(); });

	it('uploads/downloads binary and empty objects with UTF-8 keys and real metadata', async () => {
		const storage = provider(); const bytes = new Uint8Array([0, 255, 128, 13, 10, 0]);
		await storage.putObject('updates/中文 &?.bin', bytes); expect(await storage.getObject('updates/中文 &?.bin')).toEqual(bytes);
		expect(await storage.headObject('updates/中文 &?.bin')).toMatchObject({ key: 'updates/中文 &?.bin', size: bytes.length });
		await storage.putObject('updates/empty.bin', new Uint8Array()); expect(await storage.getObject('updates/empty.bin')).toEqual(new Uint8Array());
	});
	it('walks all list pages without escaping the configured namespace', async () => {
		const storage = provider();
		await server.admin.send(new PutObjectCommand({ Bucket: server.bucket, Key: 'outside/preserved.bin', Body: 'outside' }));
		for (let i = 0; i < 7; i++) await storage.putObject(`pages/${i}.bin`, new Uint8Array([i]));
		const first = await storage.listObjects('pages/'); expect(first.objects).toHaveLength(2); expect(first.nextCursor).toBeTruthy();
		const objects = []; for await (const object of listAll(storage, 'pages/')) objects.push(object);
		expect(objects.map(object => object.key).sort()).toEqual(Array.from({ length: 7 }, (_, i) => `pages/${i}.bin`));
		await expect(storage.deleteObject('../outside/preserved.bin')).rejects.toMatchObject({ kind: 'invalid-request' });
		const untouched = await server.admin.send(new GetObjectCommand({ Bucket: server.bucket, Key: 'outside/preserved.bin' })); expect(await untouched.Body!.transformToString()).toBe('outside');
	});
	it('distinguishes missing objects from denied writes, and deletion is idempotent', async () => {
		const storage = provider(); expect(await storage.headObject('missing.bin')).toBeNull(); await expect(storage.getObject('missing.bin')).rejects.toMatchObject({ kind: 'not-found', retryable: false });
		await storage.deleteObject('missing.bin'); await storage.putObject('delete.bin', new Uint8Array([1])); await storage.deleteObject('delete.bin'); expect(await storage.headObject('delete.bin')).toBeNull();
		const reader = provider({}, true); await expect(reader.putObject('denied.bin', new Uint8Array([1]))).rejects.toMatchObject({ kind: 'permission', retryable: false });
	});
	it('rejects a real SigV4 request signed with the wrong secret', async () => {
		const invalid = new S3CompatibleProvider({ endpoint: server.endpoint, bucket: server.bucket, region: 'us-east-1', forcePathStyle: true, prefix, allowInsecureLocalhost: true }, { accessKeyId: server.credentials.accessKeyId, secretAccessKey: crypto.randomUUID() }); instances.push(invalid);
		await expect(invalid.getObject('updates/empty.bin')).rejects.toMatchObject({ kind: 'authentication', retryable: false });
	});
	it('refreshes a dynamic credential source after its secret changes', async () => {
		let current: StorageCredentials = { ...server.credentials, secretAccessKey: crypto.randomUUID() };
		const changing = new S3CompatibleProvider({ endpoint: server.endpoint, bucket: server.bucket, region: 'us-east-1', forcePathStyle: true, prefix, allowInsecureLocalhost: true }, async () => current); instances.push(changing);
		await expect(changing.getObject('updates/empty.bin')).rejects.toMatchObject({ kind: 'authentication' });
		current = { ...server.credentials }; expect(await changing.getObject('updates/empty.bin')).toEqual(new Uint8Array());
	});
	it('retries a committed upload whose response was lost using the original byte snapshot', async () => {
		const proxy = new FaultProxy(server.endpoint); await proxy.start();
		try {
			const storage = provider({ endpoint: proxy.endpoint }); const original = new Uint8Array([1, 2, 3, 4]); proxy.fault = 'lost-put-response';
			const upload = storage.putObject('retry/committed.bin', original); original.fill(99); await upload;
			expect(proxy.committedBeforeDisconnect).toBe(1); expect(proxy.puts).toBe(2); expect(await storage.getObject('retry/committed.bin')).toEqual(new Uint8Array([1, 2, 3, 4]));
		} finally { await proxy.close(); }
	});
	it('recovers from timeout and server throttling without infinite retries', async () => {
		const proxy = new FaultProxy(server.endpoint); await proxy.start();
		try {
			const storage = provider({ endpoint: proxy.endpoint, timeoutMs: 500 }); proxy.fault = 'throttle-put'; await storage.putObject('retry/throttle.bin', new Uint8Array([8])); expect(proxy.puts).toBe(2);
			proxy.fault = 'timeout-get'; expect(await storage.getObject('retry/throttle.bin')).toEqual(new Uint8Array([8])); expect(proxy.gets).toBe(2);
		} finally { await proxy.close(); }
	});
	it('honors cancellation and download limits, and cleans only its connection-test objects', async () => {
		const storage = provider({ maxObjectBytes: 2 }); await expect(storage.getObject('retry/committed.bin')).rejects.toMatchObject({ kind: 'limit-exceeded', retryable: false });
		const controller = new AbortController(); controller.abort(); await expect(storage.listObjects('', undefined, { signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' });
		const probe = await probeStorage(provider()); expect(probe.ok).toBe(true); expect(probe.cleanup).toBe('ok'); expect(probe.leftoverKeys).toEqual([]);
		const leftovers = []; for await (const object of listAll(provider(), '__joplinu_connection_test/')) leftovers.push(object); expect(leftovers).toEqual([]);
		expect(await provider().getObject('retry/committed.bin')).toEqual(new Uint8Array([1, 2, 3, 4]));
	});
	it('preserves acknowledged objects after the actual service restarts', async () => {
		const storage = provider(); await storage.putObject('recovery/persistent.bin', new Uint8Array([7, 8, 9])); await server.restart(); expect(await storage.getObject('recovery/persistent.bin')).toEqual(new Uint8Array([7, 8, 9]));
	}, 90000);
});
