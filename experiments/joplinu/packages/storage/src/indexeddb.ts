import { checkNoteId, type DocumentUpdateStore } from './index';

const DB_NAME = 'joplinu-local-updates-v1';
const STORE_NAME = 'updates';

interface Row {
	noteId: string;
	bytes: ArrayBuffer;
	checksum: string;
}

function hash(bytes: Uint8Array): Promise<string> {
	const copy = Uint8Array.from(bytes);
	return crypto.subtle.digest('SHA-256', copy).then(result =>
		Array.from(new Uint8Array(result), value => value.toString(16).padStart(2, '0')).join(''));
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
	});
}

function transactionComplete(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
		tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
	});
}

async function openDatabase(): Promise<IDBDatabase> {
	const request = indexedDB.open(DB_NAME, 1);
	request.onupgradeneeded = () => {
		const db = request.result;
		const store = db.createObjectStore(STORE_NAME, { keyPath: 'seq', autoIncrement: true });
		store.createIndex('noteId', 'noteId');
	};
	return requestResult(request);
}

/** Browser development fallback; native apps MUST use their privileged bridges. */
export function indexedDbUpdateStore(): DocumentUpdateStore {
	const connection = openDatabase();
	return {
		async load(noteId) {
			checkNoteId(noteId);
			const db = await connection;
			const tx = db.transaction(STORE_NAME, 'readonly');
			const completed = transactionComplete(tx);
			const rows = await requestResult(tx.objectStore(STORE_NAME).index('noteId').getAll(noteId)) as Row[];
			await completed;
			const updates: Uint8Array[] = [];
			for (const row of rows) {
				if (!(row.bytes instanceof ArrayBuffer)) throw new Error('Invalid local update record');
				const bytes = new Uint8Array(row.bytes);
				if (await hash(bytes) !== row.checksum) throw new Error('本地日志校验失败；已停止恢复，避免覆盖。');
				updates.push(bytes);
			}
			return updates;
		},
		async append(noteId, update) {
			checkNoteId(noteId);
			if (update.byteLength < 1 || update.byteLength > 8 * 1024 * 1024) throw new Error('Invalid Yjs update size');
			const bytes = Uint8Array.from(update);
			const checksum = await hash(bytes);
			const db = await connection;
			const tx = db.transaction(STORE_NAME, 'readwrite');
			const completed = transactionComplete(tx);
			tx.objectStore(STORE_NAME).add({ noteId, bytes: bytes.buffer, checksum } satisfies Row);
			await completed; // IDB request success alone does not mean commit.
		},
	};
}
