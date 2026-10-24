import { sha256 } from '../../core/src/bytes';
import { StorageError, storageError, type ObjectStorageProvider, type RequestOptions, type StorageObjectMetadata, type StorageErrorKind } from './index';

export async function* listAll(provider: ObjectStorageProvider, prefix: string, options: RequestOptions = {}): AsyncGenerator<StorageObjectMetadata> {
	const seen = new Set<string>(); let cursor: string | undefined;
	for (let page = 0; page < 10000; page++) {
		if (options.signal?.aborted) throw new StorageError('cancelled', 'list');
		const result = await provider.listObjects(prefix, cursor, options);
		for (const object of result.objects) { if (!object.key.startsWith(prefix)) throw new StorageError('integrity', 'list'); yield object; }
		if (result.nextCursor === undefined) return;
		if (!result.nextCursor || seen.has(result.nextCursor)) throw new StorageError('integrity', 'list');
		seen.add(result.nextCursor); cursor = result.nextCursor;
	}
	throw new StorageError('limit-exceeded', 'list');
}

export interface ProbeStep { operation: 'list' | 'put' | 'head' | 'get' | 'delete'; status: 'ok' | 'failed' | 'not-tested'; error?: StorageErrorKind }
export interface ProbeResult { ok: boolean; steps: ProbeStep[]; cleanup: 'ok' | 'failed'; leftoverKeys: string[] }

/** Only creates random test bytes under a new random namespace. Never touches note objects. */
export async function probeStorage(provider: ObjectStorageProvider, options: RequestOptions = {}): Promise<ProbeResult> {
	if (options.signal?.aborted) throw new StorageError('cancelled', 'list');
	const prefix = `__joplinu_connection_test/${crypto.randomUUID()}/`;
	const key = `${prefix}probe.bin`; const bytes = crypto.getRandomValues(new Uint8Array(128));
	const steps: ProbeStep[] = [];
	const attempt = async (operation: ProbeStep['operation'], action: () => Promise<void>) => {
		try { await action(); steps.push({ operation, status: 'ok' }); return true; }
		catch (error) { steps.push({ operation, status: 'failed', error: storageError(error, operation).kind }); return false; }
	};
	await attempt('list', async () => { for await (const _object of listAll(provider, prefix, options)) { /* only the new test namespace */ } });
	if (options.signal?.aborted) return { ok: false, steps: [...steps, ...(['put', 'head', 'get', 'delete'] as const).map(operation => ({ operation, status: 'not-tested' as const }))], cleanup: 'ok', leftoverKeys: [] };
	let cleanup: 'ok' | 'failed' = 'ok';
	try {
		const written = await attempt('put', () => provider.putObject(key, bytes, options));
		if (written) {
			await attempt('head', async () => { const value = await provider.headObject(key, options); if (!value || value.size !== bytes.length) throw new StorageError('integrity', 'head'); });
			await attempt('get', async () => { if (await sha256(await provider.getObject(key, options)) !== await sha256(bytes)) throw new StorageError('integrity', 'get'); });
			await attempt('list', async () => { let found = false; for await (const object of listAll(provider, prefix, options)) if (object.key === key) found = true; if (!found) throw new StorageError('integrity', 'list'); });
		} else steps.push({ operation: 'head', status: 'not-tested' }, { operation: 'get', status: 'not-tested' });
	} finally {
		// An uploaded response can be lost. Attempt cleanup even when put reported failure.
		// Cleanup deliberately has its own timeout/retries rather than reusing an aborted caller signal.
		const deleted = await attempt('delete', async () => { await provider.deleteObject(key); if (await provider.headObject(key) !== null) throw new StorageError('integrity', 'delete'); });
		if (!deleted) cleanup = 'failed';
	}
	return { ok: steps.every(step => step.status === 'ok'), steps, cleanup, leftoverKeys: cleanup === 'failed' ? [key] : [] };
}
