import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { StorageError, basicCapabilities, credentials, localKey, objectKey, readBody, validateConfig, validateSize, withRetry, type ObjectStorageProvider, type StorageConfig, type CredentialsSource, type RequestOptions, type StorageObjectMetadata, type ObjectPage, type Operation } from '../../storage/src/index';

export interface S3Config extends StorageConfig { region: string; forcePathStyle?: boolean }

/** Node host adapter. The UI and synchronization core only depend on ObjectStorageProvider. */
export class S3CompatibleProvider implements ObjectStorageProvider {
	readonly kind = 's3';
	readonly capabilities = basicCapabilities;
	private readonly config;
	private readonly client: S3Client;
	private readonly dynamicCredentials: boolean;
	constructor(config: S3Config, source: CredentialsSource) {
		this.config = validateConfig(config);
		this.dynamicCredentials = typeof source === 'function';
		if (typeof config.region !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(config.region) || (config.forcePathStyle !== undefined && typeof config.forcePathStyle !== 'boolean')) throw new StorageError('invalid-config', 'head');
		this.client = new S3Client({
			endpoint: this.config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle ?? false,
			credentials: () => credentials(source, 'head'), maxAttempts: 1,
			// No S3 Express, acceleration or optional AWS-only checksum requirements.
			disableS3ExpressSessionAuth: true, followRegionRedirects: false,
			requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
		});
	}
	async putObject(key: string, data: Uint8Array, options: RequestOptions = {}): Promise<void> {
		if (!(data instanceof Uint8Array)) throw new StorageError('invalid-request', 'put');
		if (data.length > this.config.maxObjectBytes) throw new StorageError('limit-exceeded', 'put');
		const bytes = data.slice(); const remote = objectKey(this.config, key, false, 'put');
		await withRetry(this.config, 'put', options, async signal => {
			await this.refreshCredentials(signal, 'put');
			await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: remote, Body: bytes, ContentType: 'application/octet-stream' }), { abortSignal: signal });
		});
	}
	async getObject(key: string, options: RequestOptions = {}): Promise<Uint8Array> {
		const remote = objectKey(this.config, key, false, 'get');
		return withRetry(this.config, 'get', options, async signal => {
			await this.refreshCredentials(signal, 'get');
			const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: remote }), { abortSignal: signal });
			if (!result.Body) { if (result.ContentLength === 0) return new Uint8Array(); throw new StorageError('integrity', 'get'); }
			// The host adapter uses Node streams; no Node SDK is bundled into Android WebView.
			if (!(Symbol.asyncIterator in result.Body)) throw new StorageError('integrity', 'get');
			return readBody(result.Body as AsyncIterable<Uint8Array> & { destroy?(error?: Error): void }, this.config.maxObjectBytes, result.ContentLength, signal);
		});
	}
	async listObjects(prefix: string, cursor?: string, options: RequestOptions = {}): Promise<ObjectPage> {
		const remote = objectKey(this.config, prefix, true, 'list');
		return withRetry(this.config, 'list', options, async signal => {
			await this.refreshCredentials(signal, 'list');
			const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: remote, MaxKeys: this.config.pageSize, ...(cursor ? { ContinuationToken: cursor } : {}) }), { abortSignal: signal });
			const objects = (result.Contents ?? []).map(item => {
				if (typeof item.Key !== 'string' || item.Size === undefined || !item.Key.startsWith(remote)) throw new StorageError('integrity', 'list');
				return this.metadata(item.Key, item.Size, item.LastModified, item.ETag, 'list');
			});
			if (result.IsTruncated && !result.NextContinuationToken) throw new StorageError('integrity', 'list');
			return { objects, ...(result.IsTruncated ? { nextCursor: result.NextContinuationToken! } : {}) };
		});
	}
	async headObject(key: string, options: RequestOptions = {}): Promise<StorageObjectMetadata | null> {
		const remote = objectKey(this.config, key, false, 'head');
		try { return await withRetry(this.config, 'head', options, async signal => {
			await this.refreshCredentials(signal, 'head');
			const result = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: remote }), { abortSignal: signal });
			if (result.ContentLength === undefined) throw new StorageError('integrity', 'head');
			return { ...this.metadata(remote, result.ContentLength, result.LastModified, result.ETag), ...(result.ContentType ? { contentType: result.ContentType } : {}) };
		}); } catch (error) { if (error instanceof StorageError && error.kind === 'not-found') return null; throw error; }
	}
	async deleteObject(key: string, options: RequestOptions = {}): Promise<void> {
		const remote = objectKey(this.config, key, false, 'delete');
		try { await withRetry(this.config, 'delete', options, async signal => {
			await this.refreshCredentials(signal, 'delete');
			await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: remote }), { abortSignal: signal });
		}); }
		catch (error) { if (!(error instanceof StorageError && error.kind === 'not-found')) throw error; }
	}
	private async refreshCredentials(signal: AbortSignal, operation: Operation): Promise<void> {
		// SDK providers otherwise memoize identities without expiration indefinitely.
		// Use the public refresh option so a host can rotate credentials between requests.
		if (this.dynamicCredentials) await this.client.config.credentials({ forceRefresh: true });
		if (signal.aborted) throw new StorageError('cancelled', operation);
	}
	private metadata(key: string, size: number, modifiedAt: Date | undefined, etag: string | undefined, operation: Operation = 'head'): StorageObjectMetadata {
		if (modifiedAt && !Number.isFinite(modifiedAt.getTime())) throw new StorageError('integrity', operation);
		return { key: localKey(this.config, key, operation), size: validateSize(size, operation), ...(modifiedAt ? { modifiedAt: modifiedAt.getTime() } : {}), ...(etag ? { etag } : {}) };
	}
	close() { this.client.destroy(); }
}
