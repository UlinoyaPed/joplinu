import { Capacitor, registerPlugin } from '@capacitor/core';

export interface StoredVault {
	revision: number;
	payload: string | null;
	noteUpdates?: Record<string, string[]>;
}
export interface JournalWrite {
	updates: Record<string, string>;
	replace: string[];
	remove: string[];
}
export interface VaultStorage {
	readonly kind: string;
	read(): Promise<StoredVault>;
	write(expectedRevision: number, payload: string, journal?: JournalWrite): Promise<number>;
	check(): Promise<string>;
}
interface NativeDatabase {
	read(): Promise<StoredVault>;
	write(input: { expectedRevision: number; payload: string; journal?: JournalWrite }): Promise<{ revision: number }>;
	check(): Promise<{ result: string }>;
}
declare global { interface Window { joplinuDatabase?: NativeDatabase } }
const android = registerPlugin<NativeDatabase>('JoplinuDatabase');

export const MAX_PAYLOAD_BYTES = 40 * 1024 * 1024;
export const MAX_UPDATE_BYTES = 8 * 1024 * 1024;
const NOTE_ID = /^[a-zA-Z0-9-]{1,100}$/;

function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.onsuccess = () => resolve(value.result);
		value.onerror = () => reject(new Error('本地数据库操作失败'));
	});
}
function completed(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = transaction.onerror = () => reject(new Error('本地事务未提交'));
	});
}
function bytesFromBase64(value: string): Uint8Array {
	if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
		throw new Error('无效的本地 Yjs 日志编码');
	}
	const decoded = atob(value);
	if (!decoded.length || decoded.length > MAX_UPDATE_BYTES) throw new Error('Yjs 日志超出大小限制');
	return Uint8Array.from(decoded, char => char.charCodeAt(0));
}
async function digest(encoded: string): Promise<string> {
	const bytes = bytesFromBase64(encoded);
	const result = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
	return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}
interface JournalRow { noteId: string; revision: number; data: string; checksum: string }
function validateJournal(journal: JournalWrite): void {
	if (!journal || !journal.updates || !Array.isArray(journal.replace) || !Array.isArray(journal.remove)) throw new Error('无效的增量保存请求');
	if (Object.keys(journal.updates).length > 10000 || journal.replace.length > 10000 || journal.remove.length > 10000) throw new Error('增量保存请求过大');
	for (const [id, data] of Object.entries(journal.updates)) {
		if (!NOTE_ID.test(id)) throw new Error('无效的笔记标识符');
		bytesFromBase64(data);
	}
	for (const id of [...journal.replace, ...journal.remove]) if (!NOTE_ID.test(id)) throw new Error('无效的笔记标识符');
	for (const id of journal.replace) if (!Object.hasOwn(journal.updates, id)) throw new Error('压缩日志缺少快照');
	for (const id of journal.remove) if (Object.hasOwn(journal.updates, id)) throw new Error('不能同时删除和写入笔记日志');
}

/** Browser preview only. Native apps use transactional SQLite. The v2 database intentionally has no v1 migration. */
export class IndexedVaultStorage implements VaultStorage {
	readonly kind = 'IndexedDB';
	private readonly connection: Promise<IDBDatabase>;
	constructor(name = 'joplinu-library-v2') {
		this.connection = new Promise((resolve, reject) => {
			const open = indexedDB.open(name, 1);
			open.onupgradeneeded = () => {
				open.result.createObjectStore('vault');
				const updates = open.result.createObjectStore('note-updates', { keyPath: ['noteId', 'revision'] });
				updates.createIndex('by-note', 'noteId');
			};
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(new Error('无法打开本地数据库；请检查浏览器存储权限'));
		});
	}
	async read(): Promise<StoredVault> {
		const database = await this.connection;
		const transaction = database.transaction(['vault', 'note-updates'], 'readonly');
		const done = completed(transaction);
		const vaultRequest = request(transaction.objectStore('vault').get('current'));
		const journalRequest = request(transaction.objectStore('note-updates').getAll());
		const [record, rows] = await Promise.all([vaultRequest, journalRequest]) as [StoredVault | undefined, JournalRow[]];
		await done;
		const noteUpdates: Record<string, string[]> = Object.create(null);
		for (const row of rows) {
			if (!NOTE_ID.test(row.noteId) || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
				await digest(row.data) !== row.checksum) throw new Error('本地 Yjs 日志校验失败；已阻止加载，避免覆盖');
			(noteUpdates[row.noteId] ??= []).push(row.data);
		}
		return { revision: record?.revision ?? 0, payload: record?.payload ?? null, noteUpdates };
	}
	async write(expectedRevision: number, payload: string, journal: JournalWrite = { updates: {}, replace: [], remove: [] }): Promise<number> {
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
			new TextEncoder().encode(payload).length > MAX_PAYLOAD_BYTES) throw new Error('本地资料超过当前 40 MiB 限制');
		validateJournal(journal);
		const checksums = new Map<string, string>();
		for (const [id, data] of Object.entries(journal.updates)) checksums.set(id, await digest(data));
		const database = await this.connection;
		const transaction = database.transaction(['vault', 'note-updates'], 'readwrite', { durability: 'strict' });
		const done = completed(transaction);
		const vault = transaction.objectStore('vault');
		const updates = transaction.objectStore('note-updates');
		try {
			const current = await request(vault.get('current')) as StoredVault | undefined;
			if ((current?.revision ?? 0) !== expectedRevision) {
				throw new Error('其他窗口已修改本地资料。请导出备份并重新加载；本窗口不会覆盖其他窗口。');
			}
			for (const id of new Set([...journal.replace, ...journal.remove])) {
				const keys = await request(updates.index('by-note').getAllKeys(id));
				for (const key of keys) updates.delete(key);
			}
			for (const [noteId, data] of Object.entries(journal.updates)) {
				updates.add({ noteId, revision: expectedRevision + 1, data, checksum: checksums.get(noteId)! } satisfies JournalRow);
			}
			vault.put({ revision: expectedRevision + 1, payload }, 'current');
		} catch (error) {
			transaction.abort();
			await done.catch(() => {});
			throw error;
		}
		await done;
		return expectedRevision + 1;
	}
	async check(): Promise<string> {
		await this.read();
		return 'IndexedDB 资料与 Yjs 日志校验正常';
	}
}
export function openVaultStorage(): VaultStorage {
	const native = window.joplinuDatabase ?? (Capacitor.isNativePlatform() ? android : undefined);
	if (!native) {
		if (navigator.userAgent.includes('Electron/')) throw new Error('Electron 本地存储桥接未加载，拒绝切换到浏览器存储');
		return new IndexedVaultStorage();
	}
	return {
		kind: 'SQLite',
		read: () => native.read(),
		write: async (expectedRevision, payload, journal) => (await native.write({ expectedRevision, payload, ...(journal ? { journal } : {}) })).revision,
		check: async () => (await native.check()).result,
	};
}
