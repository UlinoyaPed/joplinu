import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlibabaOSSProvider } from '../../packages/storage-oss/src/index';
import { listAll, probeStorage } from '../../packages/storage/src/diagnostics';

/** Opt-in real endpoint test. Missing credentials fail explicitly; there is no fixture fallback. */
describe('real Alibaba OSS API (explicit environment credentials)', () => {
	let provider: AlibabaOSSProvider | undefined;
	const ownKeys = new Set<string>(); const namespace = `__joplinu_integration/${crypto.randomUUID()}/`;
	const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Real OSS testing requires ${name} via environment/secret bindings. No mock fallback is used.`); return value; };
	beforeAll(() => {
		const endpoint = required('JOPLINU_OSS_ENDPOINT'); const bucket = required('JOPLINU_OSS_BUCKET'); const prefix = required('JOPLINU_OSS_TEST_PREFIX');
		const accessKeyId = required('JOPLINU_OSS_ACCESS_KEY_ID'); const secretAccessKey = required('JOPLINU_OSS_SECRET_ACCESS_KEY');
		const region = process.env.JOPLINU_OSS_REGION; const sessionToken = process.env.JOPLINU_OSS_SESSION_TOKEN;
		provider = new AlibabaOSSProvider({ endpoint, bucket, prefix, pageSize: 2, ...(region ? { region } : {}) }, { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) });
	});
	afterAll(async () => {
		if (!provider) return;
		const cleanup = await Promise.allSettled([...ownKeys].map(key => provider!.deleteObject(key)));
		if (cleanup.some(result => result.status === 'rejected')) throw new Error('Real OSS diagnostic cleanup failed; only this test run’s newly created objects may remain');
	});
	it('verifies real read/write/list/head/delete permissions and integrity', async () => {
		const report = await probeStorage(provider!); expect(report.ok).toBe(true); expect(report.cleanup).toBe('ok');
	});
	it('round-trips opaque bytes and walks real OSS continuation tokens', async () => {
		for (let index = 0; index < 5; index++) {
			const key = `${namespace}${index}-中文.bin`; ownKeys.add(key); const bytes = new Uint8Array([index, 0, 128, 255]);
			await provider!.putObject(key, bytes); expect(await provider!.getObject(key)).toEqual(bytes); expect(await provider!.headObject(key)).toMatchObject({ key, size: bytes.length });
		}
		const page = await provider!.listObjects(namespace); expect(page.objects).toHaveLength(2); expect(page.nextCursor).toBeTruthy();
		const objects = []; for await (const object of listAll(provider!, namespace)) objects.push(object.key); expect(objects.sort()).toEqual([...ownKeys].sort());
		await provider!.deleteObject([...ownKeys][0]!); expect(await provider!.headObject([...ownKeys][0]!)).toBeNull();
	});
});
