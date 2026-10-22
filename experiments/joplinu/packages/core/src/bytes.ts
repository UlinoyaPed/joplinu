export function toBase64(bytes: Uint8Array): string {
	let result = '';
	for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return btoa(result);
}
export function fromBase64(value: string): Uint8Array {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('无效的二进制编码');
	return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
export async function sha256(data: Uint8Array) {
	const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data));
	return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
