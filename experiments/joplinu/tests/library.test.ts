import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { zipSync, strToU8 } from 'fflate';
import { createVault, createNote, decodeDocument, encodeDocument, folderPath, moveFolder, newId, validateVault, sha256, toBase64 } from '../packages/library/src/model';
import { LibraryController } from '../packages/library/src/controller';
import type { StoredVault, VaultStorage } from '../packages/database/src/index';
import { createBackup, exportDirectory, importArchive, importDirectoryFiles, importMarkdownFiles, mergeBackup, readBackup, readMarkdownFile, rewriteLocalReferences, searchableNotes, unzipLimited } from '../packages/library/src/transfer';
import { encryptBackup, decryptBackup } from '../packages/crypto/src/backup';

class MemoryStorage implements VaultStorage {
	kind = 'fault-injection'; record: StoredVault = { revision: 0, payload: null }; fail = false; delay = 0;
	async read() { return this.record; }
	async write(revision: number, payload: string) {
		if (this.delay) await new Promise(resolve => setTimeout(resolve, this.delay));
		if (this.fail) throw new Error('disk full');
		if (revision !== this.record.revision) throw new Error('stale revision');
		this.record = { revision: revision + 1, payload }; return revision + 1;
	}
	async check() { return 'ok'; }
}

describe('local library data safety', () => {
	it('persists Yjs state, supports continued concurrent editing after reload, and restores history', async () => {
		const storage = new MemoryStorage(); const library = new LibraryController(storage);
		await library.open('原文'); await library.flush();
		const id = library.vault.notes[0]!.id; const document = library.document(id);
		library.checkpoint(id); document.edit([{ from: 2, to: 2, insert: '编辑' }]); await library.flush();
		const reopened = new LibraryController(storage); await reopened.open();
		const restored = reopened.document(id); expect(restored.source).toBe('原文编辑');
		expect(Y.encodeStateVector(restored.doc)).toEqual(Y.encodeStateVector(document.doc));
		document.edit([{ from: 0, to: 0, insert: '甲' }]); restored.edit([{ from: restored.source.length, to: restored.source.length, insert: '乙' }]);
		restored.applyRemote(Y.encodeStateAsUpdate(document.doc)); expect(restored.source).toBe('甲原文编辑乙');
		reopened.restore(id, '原文'); expect(restored.source).toBe('原文'); expect(reopened.vault.notes[0]!.history[0]!.source).toBe('甲原文编辑乙');
		library.dispose(); reopened.dispose();
	});
	it('never reports saved while a write is pending, preserves edits made during an async write', async () => {
		const storage = new MemoryStorage(); storage.delay = 20; const library = new LibraryController(storage);
		await library.open('A'); const document = library.document(library.vault.notes[0]!.id);
		const pending = library.flush(); expect(library.status).toBe('saving');
		document.edit([{ from: 1, to: 1, insert: 'B' }]); await pending;
		expect(library.status).toBe('saved'); expect(library.hasUnsavedChanges).toBe(false);
		const vault = validateVault(JSON.parse(storage.record.payload!)); const restored = decodeDocument(vault.notes[0]!.state);
		expect(restored.source).toBe('AB'); restored.destroy(); library.dispose();
	});
	it('keeps recovery data after a storage failure and retries only with the same revision', async () => {
		const storage = new MemoryStorage(); const library = new LibraryController(storage); await library.open('original'); await library.flush();
		storage.fail = true; library.document(library.vault.notes[0]!.id).edit([{ from: 8, to: 8, insert: '保留' }]); await library.flush();
		expect(library.status).toBe('error'); expect(library.hasUnsavedChanges).toBe(true);
		const backup = await readBackup(await createBackup(library.vault)); const recovered = decodeDocument(backup.notes[0]!.state); expect(recovered.source).toBe('original保留'); recovered.destroy();
		storage.fail = false; await library.flush(); expect(library.status).toBe('saved'); library.dispose();
	});
	it('rejects history restoration during composition without modifying content or history', async () => {
		const library = new LibraryController(new MemoryStorage()); await library.open('原文'); const id = library.vault.notes[0]!.id;
		const document = library.document(id); const owner = {}; document.beginComposition(owner);
		expect(() => library.restore(id, '其他内容')).toThrow(/结束中文输入/); expect(library.vault.notes[0]!.history).toHaveLength(0); expect(document.source).toBe('原文');
		document.endComposition(owner); library.dispose();
	});
	it('rejects competing writers and corrupt loads without overwriting acknowledged data', async () => {
		const storage = new MemoryStorage(); const first = new LibraryController(storage); await first.open('base'); await first.flush();
		const second = new LibraryController(storage); await second.open(); first.document(first.vault.notes[0]!.id).edit([{ from: 0, to: 0, insert: 'first' }]); await first.flush();
		const saved = storage.record.payload; second.document(second.vault.notes[0]!.id).edit([{ from: 0, to: 0, insert: 'second' }]); await second.flush();
		expect(second.status).toBe('error'); expect(storage.record.payload).toBe(saved); first.dispose(); second.dispose();
		storage.record.payload = 'not JSON'; const broken = new LibraryController(storage); await expect(broken.open()).rejects.toThrow(); expect(storage.record.payload).toBe('not JSON'); broken.dispose();
	});
	it('rejects cycles, missing folders, duplicate identities and invalid settings', () => {
		const vault = createVault('内容'); const root = vault.folders[0]!; const child = { id: newId(), name: '子目录', parentId: root.id, createdAt: Date.now() }; vault.folders.push(child);
		expect(folderPath(vault, child.id)).toEqual(['我的笔记', '子目录']); expect(() => moveFolder(vault, root.id, child.id)).toThrow();
		expect(() => validateVault({ ...vault, folders: [...vault.folders, child] })).toThrow(/重复/);
		expect(() => validateVault({ ...vault, preferences: { ...vault.preferences, fontSize: 100 } })).toThrow();
		expect(() => validateVault({ ...vault, folders: [] })).toThrow(/不存在/);
	});
	it('imports nested Markdown directories without rewriting bytes and searches body/tags', () => {
		const vault = importMarkdownFiles(createVault(), [{ path: '项目/想法/中文.md', source: '# 标题  \r\n\r\n~~~js\r\n1\r\n~~~\r\n' }]);
		const note = vault.notes.at(-1)!; expect(folderPath(vault, note.folderId)).toEqual(['导入的笔记', '项目', '想法']);
		const document = decodeDocument(note.state); expect(document.source).toContain('~~~js\r\n'); document.destroy();
		note.tags = ['工作']; expect(searchableNotes(vault, '工作 标题', null, false).map(note => note.id)).toEqual([note.id]);
		expect(() => importMarkdownFiles(vault, [{ path: '../escape.md', source: '' }])).toThrow();
	});
	it('rejects invalid UTF-8 instead of silently replacing Chinese bytes, and retains BOM/CRLF', async () => {
		await expect(readMarkdownFile(new File([new Uint8Array([0xff, 0xa1, 0xb0])], 'GBK.md'))).rejects.toThrow(/UTF-8/);
		const text = '\uFEFF# 中文\r\n\r\n原文  \r\n'; expect(await readMarkdownFile(new File([text], 'UTF8.md'))).toBe(text);
	});
	it('imports relative Markdown links and only referenced attachments within selected files', async () => {
		const vault = createVault(); vault.preferences.imageMaxWidth = 0;
		const source = '[下一篇](../b.md)\n\n[附件](../files/说明.pdf)\n\n`../b.md`\n';
		const result = await importDirectoryFiles(vault, [
			{ path: 'notes/sub/a.md', file: new File([source], 'a.md') }, { path: 'notes/b.md', file: new File(['第二篇'], 'b.md') },
			{ path: 'notes/files/说明.pdf', file: new File(['pdf-bytes'], '说明.pdf') }, { path: 'notes/files/unused.txt.bak', file: new File(['not imported'], 'unused.txt.bak') },
		]);
		expect(result.attachments).toHaveLength(1); const first = decodeDocument(result.notes[1]!.state);
		expect(first.source).toBe(`[下一篇](note:${result.notes[2]!.id})\n\n[附件](attachment:${result.attachments[0]!.id})\n\n\`../b.md\`\n`); first.destroy();
		expect(result.attachments[0]!.mime).toBe('application/pdf');
	});
});

describe('complete backup and folder archive', () => {
	it('exports every same-title note even when their identifier prefixes collide', async () => {
		const vault = createVault('第一篇'); vault.notes[0]!.title = 'CON'; vault.notes[0]!.id = '12345678-1111-4111-8111-111111111111';
		const second = createNote('CON', vault.folders[0]!.id, '第二篇'); second.id = '12345678-2222-4222-8222-222222222222'; vault.notes.push(second);
		const files = unzipLimited(await exportDirectory(vault)); const markdown = Object.entries(files).filter(([path]) => path.endsWith('.md'));
		expect(markdown).toHaveLength(2); expect(markdown.map(([, bytes]) => new TextDecoder().decode(bytes)).sort()).toEqual(['第一篇', '第二篇'].sort());
		expect(markdown.every(([path]) => path.split('/').at(-1)!.startsWith('_CON~'))).toBe(true);
	});
	it('round-trips history, settings, trash, attachments and CRDT without overwriting current notes', async () => {
		const incoming = createVault('待备份'); const first = incoming.notes[0]!; const id = newId();
		const attachment = { id, name: '中文.txt', mime: 'text/plain', data: toBase64(strToU8('附件')), sha256: await sha256(strToU8('附件')), createdAt: Date.now() };
		incoming.attachments.push(attachment); incoming.notes.push(createNote('删除的笔记', null, '回收站正文')); incoming.notes[1]!.deletedAt = Date.now();
		const document = decodeDocument(first.state); document.edit([{ from: 3, to: 3, insert: ` [附件](attachment:${id})` }]); first.state = encodeDocument(document); document.destroy();
		first.history.push({ id: newId(), source: '旧版本', createdAt: Date.now(), reason: 'test' }); incoming.preferences.theme = 'dark';
		const backup = await createBackup(incoming); const checked = await readBackup(backup); expect(checked).toEqual(incoming);
		const current = createVault('不可覆盖'); const merged = mergeBackup(current, checked, true);
		expect(merged.notes[0]).toEqual(current.notes[0]); expect(merged.notes).toHaveLength(3); expect(merged.preferences.theme).toBe('dark');
		const restored = decodeDocument(merged.notes[1]!.state); expect(restored.source).toContain(`attachment:${merged.attachments[0]!.id}`); restored.destroy();
		expect(merged.notes[1]!.history[0]!.source).toBe('旧版本'); expect(merged.notes[2]!.deletedAt).toBeTruthy();
		const archive = await exportDirectory(incoming); const zip = unzipLimited(archive); expect(Object.keys(zip).some(name => name.endsWith('.md'))).toBe(true);
		const zipRestored = await importArchive(current, archive); expect(zipRestored.notes).toHaveLength(3); expect(zipRestored.attachments[0]!.sha256).toBe(attachment.sha256);
	});
	it('rewrites only actual internal link destinations, preserving code and literal examples', () => {
		const source = '[正文 note:old](note:old "note:old")\n\n`note:old`\n\n~~~\n[n](note:old)\n~~~\n\n![附件](attachment:old)\n\n[x]: note:old\n';
		const result = rewriteLocalReferences(source, new Map([['old', 'new']]));
		expect(result).toBe(source.replace('](note:old "note:old")', '](note:new "note:old")').replace('](attachment:old)', '](attachment:new)').replace('[x]: note:old', '[x]: note:new'));
	});
	it('rejects tampering, dangerous ZIP paths and damaged attachments before applying imports', async () => {
		const vault = createVault('safe'); const backup = JSON.parse(await createBackup(vault)); backup.payload += ' ';
		await expect(readBackup(JSON.stringify(backup))).rejects.toThrow(/校验/);
		expect(() => unzipLimited(zipSync({ '../outside.md': strToU8('bad') }))).toThrow(/路径/);
		vault.attachments.push({ id: newId(), name: 'bad', mime: 'text/plain', data: toBase64(strToU8('bad')), sha256: '0'.repeat(64), createdAt: Date.now() });
		await expect(readBackup(await createBackup(vault))).rejects.toThrow(/附件校验/);
	});
	it('encrypts with fresh keys and authenticates password, wrapped key and ciphertext', async () => {
		const plaintext = await createBackup(createVault('私人中文笔记'));
		const first = await encryptBackup(plaintext, 'correct password 123'); const second = await encryptBackup(plaintext, 'correct password 123');
		expect(first).not.toBe(second); expect(first).not.toContain('私人中文笔记'); expect(await decryptBackup(first, 'correct password 123')).toBe(plaintext);
		await expect(decryptBackup(first, 'incorrect password')).rejects.toThrow(/密码错误/);
		const broken = JSON.parse(first); const ciphertext = broken.ciphertext as string; broken.ciphertext = (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1);
		await expect(decryptBackup(JSON.stringify(broken), 'correct password 123')).rejects.toThrow(/数据已损坏/);
		await expect(encryptBackup(plaintext, 'short')).rejects.toThrow();
	}, 15000);
});
