import { readFile, writeFile, rename, unlink, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { S3CompatibleProvider } from '../../storage-s3/src/index';
import { AlibabaOSSProvider } from '../../storage-oss/src/index';
import { credentials, validateConfig, StorageError, type ObjectStorageProvider, type StorageCredentials } from '../../storage/src/index';
import { probeStorage } from '../../storage/src/diagnostics';
import type { CloudConfig, CloudSetup, CloudInfo, CloudFailure, CloudRequest, CloudResponse } from '../../platform/src/cloud';

interface SecureStorage { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string; getSelectedStorageBackend?(): string }
interface Profile { config: CloudConfig; credentials: StorageCredentials }
class HostError extends Error { constructor(readonly kind: CloudFailure['kind']) { super(kind); } }

export class CloudHost {
	private readonly path: string;
	private active: { profile: Profile; provider: ObjectStorageProvider } | undefined;
	private loading: Promise<void> | undefined;
	private persisted = false;
	private loadError: string | undefined;
	private inFlight = 0;
	private changing = false;
	constructor(private readonly directory: string, private readonly secure: SecureStorage, private readonly allowLoopbackHTTP = false) { this.path = join(directory, 'cloud-settings-v1.enc'); }
	private available() { return this.secure.isEncryptionAvailable() && this.secure.getSelectedStorageBackend?.() !== 'basic_text'; }
	private async profile(value: unknown, previous?: Profile): Promise<Profile> {
		if (!value || typeof value !== 'object') throw new HostError('invalid-config');
		const setup = value as CloudSetup; const raw = setup.config;
		if (!raw || !['s3', 'oss'].includes(raw.kind) || ![raw.endpoint, raw.bucket, raw.prefix, raw.region].every(value => typeof value === 'string') || typeof raw.forcePathStyle !== 'boolean' || typeof raw.useCname !== 'boolean') throw new HostError('invalid-config');
		const validated = validateConfig({ endpoint: raw.endpoint, bucket: raw.bucket, prefix: raw.prefix, allowInsecureLocalhost: this.allowLoopbackHTTP });
		const config: CloudConfig = { kind: raw.kind, endpoint: validated.endpoint, bucket: validated.bucket, prefix: validated.prefix.replace(/\/$/, ''), region: raw.region, forcePathStyle: raw.forcePathStyle, useCname: raw.useCname };
		const saved = previous?.config.endpoint === config.endpoint && previous.config.kind === config.kind ? previous.credentials : undefined;
		return { config, credentials: await credentials(setup.credentials ?? saved!, 'head') };
	}
	private provider(profile: Profile): ObjectStorageProvider {
		const { config, credentials: source } = profile; const options = { ...config, allowInsecureLocalhost: this.allowLoopbackHTTP };
		const { region, ...ossOptions } = options;
		return config.kind === 's3' ? new S3CompatibleProvider(options, source) : new AlibabaOSSProvider({ ...ossOptions, ...(region ? { region } : {}) }, source);
	}
	private async load() {
		this.loading ??= this.loadSaved(); await this.loading;
	}
	private async loadSaved() {
		try {
			const stat = await lstat(this.path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error('Invalid credential file'); this.persisted = true;
			if (!this.available()) { this.loadError = '系统安全存储尚未解锁，已有凭据保持封存。'; return; }
			const stored = JSON.parse(this.secure.decryptString(await readFile(this.path)));
			const profile = await this.profile({ config: stored.config, credentials: stored.credentials }); this.active = { profile, provider: this.provider(profile) };
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.loadError = '无法读取已保管的云配置，请重新配置或清除配置后重试。'; }
	}
	private info(): CloudInfo { return { supported: true, configured: !!this.active, secureStorage: this.available(), persisted: this.persisted, ...(this.active ? { config: this.active.profile.config } : {}), ...(this.loadError ? { error: this.loadError } : {}) }; }
	async invoke(method: string, input?: unknown): Promise<CloudResponse<unknown>> {
		let mutation = false; let operation = false;
		try {
			await this.load();
			if (method === 'info') return { ok: true, value: this.info() };
			if (this.changing || (this.inFlight > 0 && ['configure', 'clear'].includes(method))) throw new HostError('conflict');
			if (['configure', 'clear'].includes(method)) { this.changing = true; mutation = true; }
			else { this.inFlight++; operation = true; }
			if (method === 'configure') {
				const setup = input as CloudSetup; if (typeof setup?.persist !== 'boolean') throw new HostError('invalid-config');
				const profile = await this.profile(setup, this.active?.profile); const provider = this.provider(profile);
				try {
					if (setup.persist) {
						if (!this.available()) throw new HostError('secure-storage-unavailable');
						const encrypted = this.secure.encryptString(JSON.stringify(profile)); await mkdir(this.directory, { recursive: true, mode: 0o700 });
						const temporary = this.path + '.' + crypto.randomUUID();
						try { await writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' }); await rename(temporary, this.path); }
						finally { await unlink(temporary).catch(() => {}); }
						this.persisted = true;
					}
				} catch (error) { provider.close?.(); throw error; }
				this.active?.provider.close?.(); this.active = { profile, provider }; this.loadError = undefined; return { ok: true, value: this.info() };
			}
			if (method === 'clear') { await unlink(this.path).catch(error => { if (error.code !== 'ENOENT') throw error; }); this.active?.provider.close?.(); this.active = undefined; this.persisted = false; this.loadError = undefined; return { ok: true, value: this.info() }; }
			if (!this.active) throw new HostError('not-configured');
			if (method === 'probe') return { ok: true, value: await probeStorage(this.active.provider) };
			if (method !== 'request') throw new HostError('unsupported');
			const request = input as CloudRequest;
			if (!request || typeof request.key !== 'string' || (request.cursor !== undefined && (typeof request.cursor !== 'string' || request.cursor.length > 10000))) throw new HostError('invalid-request');
			const provider = this.active.provider; let value: unknown = null;
			switch (request.operation) {
			case 'put': {
				if (typeof request.data !== 'string' || request.data.length > 90 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.data)) throw new HostError('invalid-request');
				await provider.putObject(request.key, Buffer.from(request.data, 'base64')); break;
			}
			case 'get': value = Buffer.from(await provider.getObject(request.key)).toString('base64'); break;
			case 'list': value = await provider.listObjects(request.key, request.cursor); break;
			case 'head': value = await provider.headObject(request.key); break;
			case 'delete': await provider.deleteObject(request.key); break;
			default: throw new HostError('unsupported');
			}
			return { ok: true, value };
		} catch (error) {
			const safe: CloudFailure = error instanceof StorageError ? { kind: error.kind, operation: error.operation, retryable: error.retryable, ...(error.status === undefined ? {} : { status: error.status }) } : { kind: error instanceof HostError ? error.kind : 'operation-failed' };
			return { ok: false, error: safe };
		} finally { if (mutation) this.changing = false; if (operation) this.inFlight--; }
	}
	close() { this.active?.provider.close?.(); }
}
