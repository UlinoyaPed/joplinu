import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { StorageError, credentials, objectKey, localKey, storageError, validateConfig, withRetry, readBody } from '../packages/storage/src/index';

const config = () => validateConfig({ endpoint: 'https://objects.example.com', bucket: 'notes', prefix: 'vaults/test/', maxAttempts: 3, retryDelayMs: 0, timeoutMs: 20 });
describe('vendor-neutral storage semantics', () => {
	it('requires TLS and explicit loopback exceptions, without accepting credentials inside endpoints', () => {
		for (const endpoint of ['http://objects.example.com', 'https://key:secret@objects.example.com', 'https://objects.example.com/path', 'https://objects.example.com?token=secret']) expect(() => validateConfig({ endpoint, bucket: 'notes' })).toThrow(StorageError);
		expect(validateConfig({ endpoint: 'http://127.0.0.1:9000', bucket: 'notes', allowInsecureLocalhost: true }).endpoint).toBe('http://127.0.0.1:9000');
		expect(() => validateConfig({ endpoint: 'http://192.168.1.5', bucket: 'notes', allowInsecureLocalhost: true })).toThrow(StorageError);
	});
	it('isolates keys and list prefixes without decoding literal object names', () => {
		const value = config(); expect(objectKey(value, 'updates/%2F中文.bin')).toBe('vaults/test/updates/%2F中文.bin');
		expect(objectKey(value, '', true)).toBe('vaults/test/'); expect(localKey(value, 'vaults/test/updates/a', 'list')).toBe('updates/a');
		for (const key of ['../other', '/absolute', 'a/../../other', 'a\\b', 'a//b']) expect(() => objectKey(value, key)).toThrow(StorageError);
		expect(() => localKey(value, 'another-vault/key', 'list')).toThrow(StorageError);
	});
	it('never exposes SDK error messages, signed URLs or causes in diagnostics', () => {
		const error = storageError({ name: 'AccessDenied', statusCode: 403, message: 'https://example?accessKey=secret', cause: new Error('secret-token') }, 'get');
		expect(error).toMatchObject({ kind: 'permission', retryable: false, status: 403 }); expect(String(error)).not.toContain('secret'); expect(JSON.stringify(error)).not.toContain('secret'); expect(error.cause).toBeUndefined();
		expect(storageError({ code: 'InvalidAccessKeyId', status: 403 }, 'put').kind).toBe('authentication');
		expect(storageError({ code: 'BadDigest', status: 400 }, 'get').kind).toBe('integrity');
		expect(storageError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'get')).toMatchObject({ kind: 'tls', retryable: false });
		expect(storageError(new StorageError('credentials-unavailable', 'head'), 'put')).toMatchObject({ operation: 'put', kind: 'credentials-unavailable' });
	});
	it('retries transient failures but stops on authentication and bounded exhaustion', async () => {
		let attempts = 0; expect(await withRetry(config(), 'put', {}, async () => { if (++attempts < 3) throw { status: 503 }; return 'done'; })).toBe('done'); expect(attempts).toBe(3);
		attempts = 0; await expect(withRetry(config(), 'put', {}, async () => { attempts++; throw { code: 'SignatureDoesNotMatch', status: 403 }; })).rejects.toMatchObject({ kind: 'authentication' }); expect(attempts).toBe(1);
		attempts = 0; await expect(withRetry(config(), 'put', {}, async () => { attempts++; throw { status: 503 }; })).rejects.toMatchObject({ retryable: true }); expect(attempts).toBe(3);
	});
	it('supports in-flight cancellation and bounded timeouts without a late success response', async () => {
		const controller = new AbortController(); let requests = 0;
		const pending = withRetry(config(), 'get', { signal: controller.signal }, async () => { requests++; await new Promise(resolve => setTimeout(resolve, 100)); return 'late'; }); controller.abort();
		await expect(pending).rejects.toMatchObject({ kind: 'cancelled', retryable: false }); expect(requests).toBe(1);
		await expect(withRetry({ ...config(), maxAttempts: 1, timeoutMs: 10 }, 'get', {}, async () => new Promise<string>(() => {}))).rejects.toMatchObject({ kind: 'timeout' });
	});
	it('rejects length corruption and oversized bodies while preserving binary bytes', async () => {
		const signal = new AbortController().signal;
		expect(await readBody(Readable.from([Buffer.from([0, 255]), Buffer.from([128])]), 3, 3, signal)).toEqual(new Uint8Array([0, 255, 128]));
		await expect(readBody(Readable.from([Buffer.from([1])]), 3, 2, signal)).rejects.toMatchObject({ kind: 'integrity' });
		await expect(readBody(Readable.from([Buffer.from([1, 2, 3])]), 2, undefined, signal)).rejects.toMatchObject({ kind: 'limit-exceeded' });
	});
	it('allows short-lived credentials from an external provider without retaining provider errors', async () => {
		const source = { accessKeyId: 'test-only', secretAccessKey: 'not-a-real-key', sessionToken: 'test-token' };
		expect(await credentials(async () => source, 'get')).toEqual(source);
		await expect(credentials(async () => { throw new Error('secret details'); }, 'get')).rejects.toMatchObject({ kind: 'credentials-unavailable' });
	});
});
