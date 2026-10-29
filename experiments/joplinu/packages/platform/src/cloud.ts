import { Capacitor, registerPlugin } from '@capacitor/core';
import { fromBase64, toBase64 } from '../../core/src/bytes';
import { StorageError, basicCapabilities, type ObjectStorageProvider, type StorageCredentials, type StorageObjectMetadata, type ObjectPage, type StorageErrorKind, type Operation, type RequestOptions } from '../../storage/src/index';
import type { ProbeResult } from '../../storage/src/diagnostics';

export interface CloudConfig { kind: 's3' | 'oss'; endpoint: string; bucket: string; region: string; prefix: string; forcePathStyle: boolean; useCname: boolean }
export interface CloudSetup { config: CloudConfig; credentials?: StorageCredentials; persist: boolean }
export interface CloudInfo { supported: boolean; configured: boolean; secureStorage: boolean; persisted: boolean; config?: CloudConfig; error?: string }
export interface CloudFailure { kind: StorageErrorKind | 'secure-storage-unavailable' | 'not-configured' | 'operation-failed'; operation?: Operation; retryable?: boolean; status?: number }
export type CloudResponse<T> = { ok: true; value: T } | { ok: false; error: CloudFailure };
export interface CloudRequest { operation: Operation; key: string; cursor?: string; data?: string; expectedConfig?: CloudConfig }
export interface NativeCloud {
	info(): Promise<CloudResponse<CloudInfo>>;
	configure(setup: CloudSetup): Promise<CloudResponse<CloudInfo>>;
	probe(): Promise<CloudResponse<ProbeResult>>;
	request(input: CloudRequest): Promise<CloudResponse<unknown>>;
	clear(): Promise<CloudResponse<CloudInfo>>;
}
declare global { interface Window { joplinuCloud?: NativeCloud } }
const androidCloud = registerPlugin<NativeCloud>('JoplinuCloud');
export class CloudError extends Error {
	constructor(readonly detail: CloudFailure) { super(detail.kind); this.name = 'CloudError'; }
}
export function cloudBridge(): NativeCloud | undefined {
	return window.joplinuCloud ?? (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('JoplinuCloud') ? androidCloud : undefined);
}
export async function cloudValue<T>(response: Promise<CloudResponse<T>>): Promise<T> {
	let result: CloudResponse<T>;
	try { result = await response; } catch { throw new CloudError({ kind: 'operation-failed' }); }
	if (!result.ok) throw new CloudError(result.error); return result.value;
}
export function cloudErrorMessage(error: unknown): string {
	if (!(error instanceof CloudError)) return '云存储操作失败，请检查网络或重新配置。';
	const labels: Partial<Record<CloudFailure['kind'], string>> = {
		'authentication': '凭据无效或已过期，请检查 Access Key 和临时令牌。', 'permission': '当前凭据缺少所需权限。', 'not-found': '对象不存在。', 'network': '网络连接失败。', 'timeout': '请求超时，请重试。', 'tls': 'TLS 证书校验失败，请检查 HTTPS 端点。', 'invalid-config': '配置无效，请检查端点、区域和 Bucket。', 'invalid-request': '请求参数无效。', 'credentials-unavailable': '无法取得存储凭据。', 'secure-storage-unavailable': '系统安全存储不可用。请选择仅本次会话使用，或先启用系统密钥环。', 'not-configured': '请先配置云存储。', 'integrity': '对象校验失败，已拒绝使用。', 'limit-exceeded': '对象超过当前传输大小限制。', 'throttled': '服务限流，请稍后重试。', 'cancelled': '操作已取消。',
	};
	return labels[error.detail.kind] ?? '云存储操作失败，请检查配置后重试。';
}

/** Native host signs requests and keeps long-lived cloud credentials out of note data. */
export class HostStorageProvider implements ObjectStorageProvider {
	readonly capabilities = basicCapabilities;
	constructor(readonly kind: 's3' | 'oss', private readonly bridge: NativeCloud, private readonly expectedConfig?: CloudConfig) {}
	private async call<T>(input: CloudRequest, options: RequestOptions = {}): Promise<T> {
		if (options.signal?.aborted) throw new StorageError('cancelled', input.operation);
		try { const result = await cloudValue(this.bridge.request({ ...input, ...(this.expectedConfig ? { expectedConfig: this.expectedConfig } : {}) })); if (options.signal?.aborted) throw new StorageError('cancelled', input.operation); return result as T; }
		catch (error) { if (error instanceof CloudError) throw new StorageError(error.detail.kind === 'operation-failed' || error.detail.kind === 'not-configured' || error.detail.kind === 'secure-storage-unavailable' ? 'network' : error.detail.kind, input.operation, error.detail.retryable ?? false, error.detail.status); throw error; }
	}
	async putObject(key: string, data: Uint8Array, options?: RequestOptions) { await this.call({ operation: 'put', key, data: toBase64(data) }, options); }
	async getObject(key: string, options?: RequestOptions) { return fromBase64(await this.call<string>({ operation: 'get', key }, options)); }
	listObjects(prefix: string, cursor?: string, options?: RequestOptions) { return this.call<ObjectPage>({ operation: 'list', key: prefix, ...(cursor ? { cursor } : {}) }, options); }
	headObject(key: string, options?: RequestOptions) { return this.call<StorageObjectMetadata | null>({ operation: 'head', key }, options); }
	async deleteObject(key: string, options?: RequestOptions) { await this.call({ operation: 'delete', key }, options); }
}
