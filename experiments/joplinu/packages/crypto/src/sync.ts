import { fromBase64, toBase64 } from '../../core/src/bytes';

const text = new TextEncoder();
const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const iterations = 600000;
export interface SyncKeyManifest {
	format: 'JoplinU sync key'; version: 1; vault: string; key: string;
	kdf: 'PBKDF2-SHA256'; iterations: number; salt: string; iv: string; wrapped: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validateManifest(value: unknown): SyncKeyManifest {
	if (!value || typeof value !== 'object') throw new Error('无效的同步密钥');
	const v = value as SyncKeyManifest;
	if (v.format !== 'JoplinU sync key' || v.version !== 1 || !uuid.test(v.vault) || !uuid.test(v.key) || v.kdf !== 'PBKDF2-SHA256' || v.iterations !== iterations) throw new Error('不支持的同步密钥格式');
	for (const [name, size] of [['salt', 16], ['iv', 12], ['wrapped', 48]] as const) if (typeof v[name] !== 'string' || fromBase64(v[name]).length !== size) throw new Error('同步密钥字段损坏');
	return { format: v.format, version: 1, vault: v.vault, key: v.key, kdf: v.kdf, iterations, salt: v.salt, iv: v.iv, wrapped: v.wrapped };
}
const keyAad = (v: SyncKeyManifest) => text.encode(`JoplinU sync v1/key/${v.vault}/${v.key}`);
async function wrapping(password: string, salt: Uint8Array) {
	if (password.length < 12 || password.length > 1024) throw new Error('同步密码需要 12–1024 个字符');
	const material = await crypto.subtle.importKey('raw', text.encode(password), 'PBKDF2', false, ['deriveKey']);
	return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: Uint8Array.from(salt), iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function master(raw: Uint8Array) { return crypto.subtle.importKey('raw', Uint8Array.from(raw), 'HKDF', false, ['deriveKey']); }
export async function createSyncKey(password: string): Promise<{ manifest: SyncKeyManifest; key: CryptoKey }> {
	const salt = random(16); const iv = random(12); const raw = random(32);
	const manifest: SyncKeyManifest = { format: 'JoplinU sync key', version: 1, vault: crypto.randomUUID(), key: crypto.randomUUID(), kdf: 'PBKDF2-SHA256', iterations, salt: toBase64(salt), iv: toBase64(iv), wrapped: '' };
	try {
		manifest.wrapped = toBase64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: keyAad(manifest) }, await wrapping(password, salt), raw)));
		return { manifest, key: await master(raw) };
	} finally { raw.fill(0); }
}
export async function unlockSyncKey(input: unknown, password: string): Promise<CryptoKey> {
	const manifest = validateManifest(input);
	try {
		const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(fromBase64(manifest.iv)), additionalData: keyAad(manifest) }, await wrapping(password, fromBase64(manifest.salt)), Uint8Array.from(fromBase64(manifest.wrapped))));
		try { return await master(raw); } finally { raw.fill(0); }
	} catch { throw new Error('同步密码错误或密钥元数据损坏'); }
}
async function objectKey(key: CryptoKey, path: string) {
	return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: text.encode(`JoplinU sync v1/object/${path}`) }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
/** One independently derived key per random immutable object; version and path are authenticated. */
export async function encryptSyncObject(key: CryptoKey, path: string, plaintext: Uint8Array): Promise<Uint8Array> {
	if (plaintext.length > 48 * 1024 * 1024) throw new Error('同步更新超过单对象 48 MiB 限制，请先导出备份');
	const iv = random(12);
	const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: text.encode(`JoplinU sync v1/${path}`) }, await objectKey(key, path), Uint8Array.from(plaintext)));
	const result = new Uint8Array(13 + encrypted.length); result[0] = 1; result.set(iv, 1); result.set(encrypted, 13); return result;
}
export async function decryptSyncObject(key: CryptoKey, path: string, value: Uint8Array): Promise<Uint8Array> {
	if (value.length < 29 || value.length > 49 * 1024 * 1024 || value[0] !== 1) throw new Error('同步密文格式无效');
	try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(value.subarray(1, 13)), additionalData: text.encode(`JoplinU sync v1/${path}`) }, await objectKey(key, path), Uint8Array.from(value.subarray(13)))); }
	catch { throw new Error('同步对象认证失败；已停止合并，保留本地资料'); }
}
