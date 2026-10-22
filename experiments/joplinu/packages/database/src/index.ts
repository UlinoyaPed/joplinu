import { Capacitor, registerPlugin } from '@capacitor/core';

export interface StoredVault { revision: number; payload: string | null }
export interface VaultStorage {
	readonly kind: string;
	read(): Promise<StoredVault>;
	write(expectedRevision: number, payload: string): Promise<number>;
	check(): Promise<string>;
}

interface NativeDatabase {
	read(): Promise<StoredVault>;
	write(input: { expectedRevision: number; payload: string }): Promise<{ revision: number }>;
	check(): Promise<{ result: string }>;
}
declare global { interface Window { joplinuDatabase?: NativeDatabase } }
const android = registerPlugin<NativeDatabase>('JoplinuDatabase');
export const MAX_PAYLOAD_BYTES = 40 * 1024 * 1024;

function request<T>(value: IDBRequest<T>) {
	return new Promise<T>((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(new Error('本地数据库操作失败')); });
}
function completed(transaction: IDBTransaction) {
	return new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(new Error('本地事务未提交')); });
}

/** Browser preview only. Native clients use SQLite through a small typed bridge. */
export class IndexedVaultStorage implements VaultStorage {
	readonly kind = 'IndexedDB';
	private connection: Promise<IDBDatabase>;
	constructor(name = 'joplinu-library-v1') {
		this.connection = new Promise((resolve, reject) => {
			const open = indexedDB.open(name, 1);
			open.onupgradeneeded = () => open.result.createObjectStore('vault');
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(new Error('无法打开本地数据库；请检查浏览器存储权限'));
		});
	}
	async read() {
		const database = await this.connection;
		const transaction = database.transaction('vault', 'readonly');
		const done = completed(transaction);
		const result = await request(transaction.objectStore('vault').get('current')) as StoredVault | undefined;
		await done;
		return result ?? { revision: 0, payload: null };
	}
	async write(expectedRevision: number, payload: string) {
		if (new TextEncoder().encode(payload).length > MAX_PAYLOAD_BYTES) throw new Error('本地资料超过当前 40 MiB 限制，请先导出备份');
		const database = await this.connection;
		const transaction = database.transaction('vault', 'readwrite', { durability: 'strict' });
		const done = completed(transaction);
		const store = transaction.objectStore('vault');
		const current = await request(store.get('current')) as StoredVault | undefined;
		if ((current?.revision ?? 0) !== expectedRevision) {
			transaction.abort();
			await done.catch(() => {});
			throw new Error('其他窗口已修改本地资料。请导出当前备份，再重新加载；本窗口不会覆盖其他窗口。');
		}
		store.put({ revision: expectedRevision + 1, payload }, 'current');
		await done;
		return expectedRevision + 1;
	}
	async check() { await this.read(); return 'IndexedDB 读取正常'; }
}

export function openVaultStorage(): VaultStorage {
	const native = window.joplinuDatabase ?? (Capacitor.isNativePlatform() ? android : undefined);
	if (!native) return new IndexedVaultStorage();
	return {
		kind: 'SQLite', read: () => native.read(),
		write: async (expectedRevision, payload) => (await native.write({ expectedRevision, payload })).revision,
		check: async () => (await native.check()).result,
	};
}
