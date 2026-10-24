export type StorageErrorKind = 'not-found' | 'authentication' | 'permission' | 'network' | 'tls' | 'timeout' | 'cancelled' | 'credentials-unavailable' | 'invalid-config' | 'invalid-request' | 'unsupported' | 'integrity' | 'conflict' | 'throttled' | 'limit-exceeded';
export type Operation = 'put' | 'get' | 'list' | 'head' | 'delete';
export class StorageError extends Error {
	readonly name = 'StorageError';
	constructor(readonly kind: StorageErrorKind, readonly operation: Operation, readonly retryable = false, readonly status?: number) {
		// Never retain SDK errors/causes: they can contain signed URLs and credential identifiers.
		super(`Object storage ${operation}: ${kind}${status === undefined ? '' : ` (${status})`}`);
	}
}
export interface StorageObjectMetadata { key: string; size: number; modifiedAt?: number; etag?: string; contentType?: string }
export interface ObjectPage { objects: StorageObjectMetadata[]; nextCursor?: string }
export interface RequestOptions { signal?: AbortSignal }
export interface ObjectStorageProvider {
	readonly kind: 'oss' | 's3';
	readonly capabilities: { conditionalWrite: false; versioning: false; objectLock: false };
	putObject(key: string, data: Uint8Array, options?: RequestOptions): Promise<void>;
	getObject(key: string, options?: RequestOptions): Promise<Uint8Array>;
	listObjects(prefix: string, cursor?: string, options?: RequestOptions): Promise<ObjectPage>;
	headObject(key: string, options?: RequestOptions): Promise<StorageObjectMetadata | null>;
	deleteObject(key: string, options?: RequestOptions): Promise<void>;
	close?(): void;
}
export interface StorageCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
export type CredentialsSource = StorageCredentials | (() => Promise<StorageCredentials>);
export interface StorageConfig {
	endpoint: string; bucket: string; prefix?: string; pageSize?: number; timeoutMs?: number;
	maxAttempts?: number; retryDelayMs?: number; maxObjectBytes?: number;
	/** Only allows HTTP to loopback, for local service tests. Production always uses TLS. */
	allowInsecureLocalhost?: boolean;
}
export interface ValidConfig {
	endpoint: string; bucket: string; prefix: string; pageSize: number; timeoutMs: number;
	maxAttempts: number; retryDelayMs: number; maxObjectBytes: number;
}
export const basicCapabilities = Object.freeze({ conditionalWrite: false, versioning: false, objectLock: false } as const);

function integer(value: number | undefined, fallback: number, min: number, max: number) {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < min || result > max) throw new StorageError('invalid-config', 'head');
	return result;
}
function relativePath(path: string, allowEmpty: boolean) {
	if (typeof path !== 'string' || (!path && !allowEmpty) || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path) || path.split('/').some(part => part === '.' || part === '..') || path.includes('//')) throw new StorageError('invalid-request', 'head');
	return path;
}
export function validateConfig(config: StorageConfig): Readonly<ValidConfig> {
	let url: URL;
	try { url = new URL(config.endpoint.includes('://') ? config.endpoint : `https://${config.endpoint}`); }
	catch { throw new StorageError('invalid-config', 'head'); }
	const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if ((url.protocol !== 'https:' && !(config.allowInsecureLocalhost && loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new StorageError('invalid-config', 'head');
	if (typeof config.bucket !== 'string' || !config.bucket || config.bucket.length > 255 || /[\s/\\\u0000-\u001f\u007f]/.test(config.bucket)) throw new StorageError('invalid-config', 'head');
	let prefix: string; try { prefix = relativePath(config.prefix ?? '', true).replace(/\/$/, ''); } catch { throw new StorageError('invalid-config', 'head'); }
	if (new TextEncoder().encode(prefix).length > 800) throw new StorageError('invalid-config', 'head');
	return Object.freeze({ endpoint: url.origin, bucket: config.bucket, prefix: prefix ? prefix + '/' : '',
		pageSize: integer(config.pageSize, 1000, 1, 1000), timeoutMs: integer(config.timeoutMs, 15000, 10, 300000),
		maxAttempts: integer(config.maxAttempts, 3, 1, 8), retryDelayMs: integer(config.retryDelayMs, 150, 0, 10000), maxObjectBytes: integer(config.maxObjectBytes, 64 * 1024 * 1024, 1, 1024 * 1024 * 1024),
	});
}
export function objectKey(config: ValidConfig, relative: string, allowEmpty = false, operation: Operation = 'head') {
	let key: string; try { key = config.prefix + relativePath(relative, allowEmpty); } catch { throw new StorageError('invalid-request', operation); }
	if (new TextEncoder().encode(key).length > 1024) throw new StorageError('invalid-request', operation);
	return key;
}
export function localKey(config: ValidConfig, key: string, operation: Operation) {
	if (!key.startsWith(config.prefix)) throw new StorageError('integrity', operation);
	const relative = key.slice(config.prefix.length);
	try { relativePath(relative, false); } catch { throw new StorageError('integrity', operation); }
	return relative;
}
export async function credentials(source: CredentialsSource, operation: Operation): Promise<StorageCredentials> {
	let value: StorageCredentials;
	try { value = typeof source === 'function' ? await source() : source; } catch { throw new StorageError('credentials-unavailable', operation); }
	for (const field of [value?.accessKeyId, value?.secretAccessKey]) if (typeof field !== 'string' || !field || field.length > 4096 || field.includes('\0')) throw new StorageError('invalid-config', operation);
	if (value.sessionToken !== undefined && (typeof value.sessionToken !== 'string' || !value.sessionToken || value.sessionToken.length > 16384 || value.sessionToken.includes('\0'))) throw new StorageError('invalid-config', operation);
	return { accessKeyId: value.accessKeyId, secretAccessKey: value.secretAccessKey, ...(value.sessionToken ? { sessionToken: value.sessionToken } : {}) };
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
export function storageError(error: unknown, operation: Operation): StorageError {
	if (error instanceof StorageError) return error.operation === operation ? error : new StorageError(error.kind, operation, error.retryable, error.status);
	const value = record(error); const metadata = record(value.$metadata);
	const statusValue = value.status ?? value.statusCode ?? metadata.httpStatusCode;
	const status = typeof statusValue === 'number' && Number.isInteger(statusValue) && statusValue >= 100 && statusValue < 600 ? statusValue : undefined;
	const codes = [value.code, value.name];
	const has = (...names: string[]) => names.some(name => codes.includes(name));
	if (status === 501 || has('NotImplemented', 'NotSupported', 'UnsupportedOperation')) return new StorageError('unsupported', operation, false, status);
	if (has('CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN')) return new StorageError('tls', operation, false, status);
	if (has('InvalidDigest', 'BadDigest', 'CRC64CheckFailed', 'ChecksumMismatch')) return new StorageError('integrity', operation, false, status);
	if (has('InvalidAccessKeyId', 'SignatureDoesNotMatch', 'InvalidSecurityToken', 'ExpiredToken', 'SecurityTokenExpired', 'RequestTimeTooSkewed', 'InvalidToken') || status === 401) return new StorageError('authentication', operation, false, status);
	if (has('NoSuchBucket', 'InvalidBucketName', 'InvalidRegion', 'PermanentRedirect') || status === 301) return new StorageError('invalid-config', operation, false, status);
	if (status === 404 || has('NoSuchKey', 'NotFound', 'NoSuchObject')) return new StorageError('not-found', operation, false, status);
	if (status === 403 || has('AccessDenied')) return new StorageError('permission', operation, false, status);
	if (status === 409 || status === 412) return new StorageError('conflict', operation, false, status);
	if (status === 429 || has('SlowDown', 'Throttling', 'ThrottlingException')) return new StorageError('throttled', operation, true, status);
	if (status === 408 || has('TimeoutError', 'RequestTimeout', 'ConnectionTimeoutError', 'ETIMEDOUT')) return new StorageError('timeout', operation, true, status);
	if (has('AbortError', 'RequestAbortedError')) return new StorageError('cancelled', operation);
	if (status !== undefined && status >= 400 && status < 500) return new StorageError('invalid-request', operation, false, status);
	return new StorageError('network', operation, true, status);
}

async function delay(milliseconds: number, signal: AbortSignal | undefined, operation: Operation) {
	if (signal?.aborted) throw new StorageError('cancelled', operation);
	await new Promise<void>((resolve, reject) => {
		const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new StorageError('cancelled', operation)); };
		const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
		signal?.addEventListener('abort', abort, { once: true });
	});
}
export async function withRetry<T>(config: ValidConfig, operation: Operation, options: RequestOptions, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		if (options.signal?.aborted) throw new StorageError('cancelled', operation);
		const controller = new AbortController(); let deadline = false;
		const forward = () => controller.abort(); options.signal?.addEventListener('abort', forward, { once: true });
		const timer = setTimeout(() => { deadline = true; controller.abort(); }, config.timeoutMs);
		let aborted: (() => void) | undefined;
		try {
			const cancelled = new Promise<never>((_resolve, reject) => { aborted = () => reject(new StorageError(deadline ? 'timeout' : 'cancelled', operation, deadline)); controller.signal.addEventListener('abort', aborted, { once: true }); });
			return await Promise.race([action(controller.signal), cancelled]);
		} catch (error) {
			const failure = options.signal?.aborted ? new StorageError('cancelled', operation) : deadline ? new StorageError('timeout', operation, true) : storageError(error, operation);
			if (!failure.retryable || attempt >= config.maxAttempts) throw failure;
			clearTimeout(timer); if (aborted) controller.signal.removeEventListener('abort', aborted);
			await delay(Math.min(5000, config.retryDelayMs * 2 ** (attempt - 1)) * (.5 + Math.random() * .5), options.signal, operation);
		} finally { clearTimeout(timer); options.signal?.removeEventListener('abort', forward); if (aborted) controller.signal.removeEventListener('abort', aborted); }
	}
}

export function validateSize(size: number, operation: Operation) { if (!Number.isSafeInteger(size) || size < 0) throw new StorageError('integrity', operation); return size; }
export async function readBody(body: AsyncIterable<Uint8Array> & { destroy?(error?: Error): void }, max: number, expected: number | undefined, signal: AbortSignal): Promise<Uint8Array> {
	if (expected !== undefined) { validateSize(expected, 'get'); if (expected > max) { body.destroy?.(); throw new StorageError('limit-exceeded', 'get'); } }
	const chunks: Uint8Array[] = []; let length = 0;
	const abort = () => body.destroy?.(new Error('Object download cancelled'));
	signal.addEventListener('abort', abort, { once: true });
	try {
		if (signal.aborted) { body.destroy?.(); throw new StorageError('cancelled', 'get'); }
		for await (const chunk of body) {
			if (signal.aborted) throw new StorageError('cancelled', 'get');
			if (!(chunk instanceof Uint8Array)) throw new StorageError('integrity', 'get');
			length += chunk.length; if (length > max) { body.destroy?.(); throw new StorageError('limit-exceeded', 'get'); } chunks.push(chunk);
		}
		if (signal.aborted) throw new StorageError('cancelled', 'get');
		if (expected !== undefined && expected !== length) throw new StorageError('integrity', 'get');
		const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
	} finally { signal.removeEventListener('abort', abort); }
}
