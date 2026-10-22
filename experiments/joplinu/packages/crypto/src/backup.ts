import { fromBase64, toBase64 } from '../../core/src/bytes';

const encoder = new TextEncoder();
const iterations = 600000;
const aad = (part: string) => encoder.encode(`JoplinU encrypted backup v1 / ${part}`);
const random = (size: number) => crypto.getRandomValues(new Uint8Array(size));
async function passwordKey(password: string, salt: Uint8Array) {
	const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
	return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Independent backup encryption. This is not a cloud synchronization protocol. */
export async function encryptBackup(plaintext: string, password: string): Promise<string> {
	if (password.length < 12 || password.length > 1024) throw new Error('备份密码需要 12–1024 个字符');
	const salt = random(16); const keyIv = random(12); const dataIv = random(12);
	const wrappingKey = await passwordKey(password, salt);
	const rawKey = random(32);
	try {
		const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
		const wrappedKey = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: keyIv, additionalData: aad('key') }, wrappingKey, rawKey);
		const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: dataIv, additionalData: aad('payload') }, key, encoder.encode(plaintext));
		return JSON.stringify({ format: 'JoplinU encrypted backup', version: 1, kdf: 'PBKDF2-SHA256', iterations, salt: toBase64(salt), keyIv: toBase64(keyIv), dataIv: toBase64(dataIv), wrappedKey: toBase64(new Uint8Array(wrappedKey)), ciphertext: toBase64(new Uint8Array(ciphertext)) });
	} finally { rawKey.fill(0); }
}

export async function decryptBackup(encrypted: string, password: string): Promise<string> {
	if (encrypted.length > 85 * 1024 * 1024) throw new Error('加密备份过大');
	const envelope = JSON.parse(encrypted) as Record<string, unknown>;
	if (envelope.format !== 'JoplinU encrypted backup' || envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== iterations) throw new Error('不支持的加密备份版本');
	const field = (name: string, length?: number) => {
		if (typeof envelope[name] !== 'string') throw new Error('加密备份字段无效');
		const bytes = fromBase64(envelope[name]);
		if (length !== undefined && bytes.length !== length) throw new Error('加密备份字段长度无效');
		return new Uint8Array(bytes);
	};
	try {
		const wrappingKey = await passwordKey(password, field('salt', 16));
		const rawKey = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: field('keyIv', 12), additionalData: aad('key') }, wrappingKey, field('wrappedKey', 48)));
		try {
			const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
			const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: field('dataIv', 12), additionalData: aad('payload') }, key, field('ciphertext'));
			return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
		} finally { rawKey.fill(0); }
	} catch { throw new Error('备份密码错误或数据已损坏；当前资料未修改'); }
}
