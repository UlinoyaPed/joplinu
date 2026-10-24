import OSS from 'ali-oss';
import { StorageError, basicCapabilities, credentials, localKey, objectKey, readBody, validateConfig, validateSize, withRetry, type ObjectStorageProvider, type StorageConfig, type CredentialsSource, type RequestOptions, type StorageObjectMetadata, type ObjectPage, type Operation, type StorageCredentials } from '../../storage/src/index';

export interface OSSConfig extends StorageConfig { region?: string; useCname?: boolean }

/** Official OSS SDK adapter; OSS authorization and pagination are independent of S3. */
export class AlibabaOSSProvider implements ObjectStorageProvider {
	readonly kind = 'oss';
	readonly capabilities = basicCapabilities;
	private readonly config;
	private readonly region: string;
	private active: { credentials: StorageCredentials; client: OSS } | undefined;
	constructor(config: OSSConfig, private readonly source: CredentialsSource) {
		this.config = validateConfig(config);
		const inferred = /^oss-([a-z0-9-]+?)(?:-internal)?\.aliyuncs\.com$/.exec(new URL(this.config.endpoint).hostname)?.[1];
		const region = config.region ?? (inferred?.startsWith('accelerate') ? undefined : inferred);
		if (!region || !/^(?:oss-)?[a-z0-9][a-z0-9-]{1,63}$/.test(region) || (config.useCname !== undefined && typeof config.useCname !== 'boolean')) throw new StorageError('invalid-config', 'head');
		this.region = region.startsWith('oss-') ? region : `oss-${region}`;
		this.useCname = config.useCname ?? false;
	}
	private readonly useCname: boolean;
	private async client(signal: AbortSignal, operation: Operation) {
		const value = await credentials(this.source, operation);
		if (signal.aborted) throw new StorageError('cancelled', operation);
		const previous = this.active;
		if (!previous || previous.credentials.accessKeyId !== value.accessKeyId || previous.credentials.secretAccessKey !== value.secretAccessKey || previous.credentials.sessionToken !== value.sessionToken) {
			const settings: OSS.Options & { retryMax: number } = {
				endpoint: this.config.endpoint, bucket: this.config.bucket, region: this.region, cname: this.useCname,
				accessKeyId: value.accessKeyId, accessKeySecret: value.secretAccessKey,
				...(value.sessionToken ? { stsToken: value.sessionToken } : {}),
				secure: this.config.endpoint.startsWith('https:'), authorizationV4: true, timeout: this.config.timeoutMs, retryMax: 0,
			};
			this.active = { credentials: value, client: new OSS(settings) };
		}
		return this.active!.client;
	}
	async putObject(key: string, data: Uint8Array, options: RequestOptions = {}): Promise<void> {
		if (!(data instanceof Uint8Array)) throw new StorageError('invalid-request', 'put');
		if (data.length > this.config.maxObjectBytes) throw new StorageError('limit-exceeded', 'put');
		const bytes = Buffer.from(data); const remote = objectKey(this.config, key, false, 'put');
		await withRetry(this.config, 'put', options, async signal => { const client = await this.client(signal, 'put'); await client.put(remote, bytes, { timeout: this.config.timeoutMs, mime: 'application/octet-stream' }); });
	}
	async getObject(key: string, options: RequestOptions = {}): Promise<Uint8Array> {
		const remote = objectKey(this.config, key, false, 'get');
		return withRetry(this.config, 'get', options, async signal => {
			const client = await this.client(signal, 'get'); const result = await client.getStream(remote, { timeout: this.config.timeoutMs });
			const stream: unknown = result.stream;
			if (!stream || typeof stream !== 'object' || !(Symbol.asyncIterator in stream)) throw new StorageError('integrity', 'get');
			const headers = result.res.headers as Record<string, unknown>;
			const length = headers['content-length'] === undefined ? undefined : Number(headers['content-length']);
			return readBody(stream as AsyncIterable<Uint8Array> & { destroy?(error?: Error): void }, this.config.maxObjectBytes, length, signal);
		});
	}
	async listObjects(prefix: string, cursor?: string, options: RequestOptions = {}): Promise<ObjectPage> {
		const remote = objectKey(this.config, prefix, true, 'list');
		return withRetry(this.config, 'list', options, async signal => {
			const client = await this.client(signal, 'list');
			const result = await client.listV2({ prefix: remote, 'max-keys': this.config.pageSize, ...(cursor ? { 'continuation-token': cursor } : {}) }, { timeout: this.config.timeoutMs });
			const objects = (result.objects ?? []).map(item => {
				if (typeof item.name !== 'string' || !item.name.startsWith(remote)) throw new StorageError('integrity', 'list');
				const modifiedAt = Date.parse(item.lastModified); if (!Number.isFinite(modifiedAt)) throw new StorageError('integrity', 'list');
				return { key: localKey(this.config, item.name, 'list'), size: validateSize(Number(item.size), 'list'), modifiedAt, ...(item.etag ? { etag: item.etag } : {}) };
			});
			if (result.isTruncated && !result.nextContinuationToken) throw new StorageError('integrity', 'list');
			return { objects, ...(result.isTruncated ? { nextCursor: result.nextContinuationToken } : {}) };
		});
	}
	async headObject(key: string, options: RequestOptions = {}): Promise<StorageObjectMetadata | null> {
		const remote = objectKey(this.config, key, false, 'head');
		try { return await withRetry(this.config, 'head', options, async signal => {
			const client = await this.client(signal, 'head'); const result = await client.head(remote, { timeout: this.config.timeoutMs });
			const headers = result.res.headers as Record<string, unknown>;
			if (headers['content-length'] === undefined) throw new StorageError('integrity', 'head');
			const modifiedAt = headers['last-modified'] === undefined ? undefined : Date.parse(String(headers['last-modified']));
			if (modifiedAt !== undefined && !Number.isFinite(modifiedAt)) throw new StorageError('integrity', 'head');
			return { key, size: validateSize(Number(headers['content-length']), 'head'), ...(modifiedAt === undefined ? {} : { modifiedAt }), ...(typeof headers.etag === 'string' ? { etag: headers.etag } : {}), ...(typeof headers['content-type'] === 'string' ? { contentType: headers['content-type'] } : {}) };
		}); } catch (error) { if (error instanceof StorageError && error.kind === 'not-found') return null; throw error; }
	}
	async deleteObject(key: string, options: RequestOptions = {}): Promise<void> {
		const remote = objectKey(this.config, key, false, 'delete');
		try { await withRetry(this.config, 'delete', options, async signal => { const client = await this.client(signal, 'delete'); await client.delete(remote, { timeout: this.config.timeoutMs }); }); }
		catch (error) { if (!(error instanceof StorageError && error.kind === 'not-found')) throw error; }
	}
}
