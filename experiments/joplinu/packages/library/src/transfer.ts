import { Unzip, UnzipInflate, strFromU8, strToU8, zipSync } from 'fflate';
import { minimalEdit } from '../../document/src/index';
import { mapMarkdownDestinations } from '../../markdown/src/index';
import { createNote, decodeDocument, encodeDocument, folderPath, fromBase64, newId, sha256, toBase64, validateVault, type Vault, type Attachment } from './model';

const LIMIT = 30 * 1024 * 1024;
const safeName = (value: string) => (value.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^\.+|[. ]+$/g, '').slice(0, 100) || '未命名');
export async function createBackup(vault: Vault) {
	const payload = JSON.stringify(vault);
	return JSON.stringify({ format: 'JoplinU backup', version: 1, sha256: await sha256(strToU8(payload)), payload }, null, 2);
}
export async function readBackup(value: string): Promise<Vault> {
	if (strToU8(value).length > 60 * 1024 * 1024) throw new Error('备份超过 60 MiB 导入上限');
	const envelope = JSON.parse(value) as Record<string, unknown>;
	if (envelope.format !== 'JoplinU backup' || envelope.version !== 1 || typeof envelope.payload !== 'string' || typeof envelope.sha256 !== 'string') throw new Error('不支持的备份格式');
	if (await sha256(strToU8(envelope.payload)) !== envelope.sha256) throw new Error('备份校验失败；当前资料未修改');
	const vault = validateVault(JSON.parse(envelope.payload));
	await checkVault(vault);
	return vault;
}
export async function checkVault(vault: Vault) {
	validateVault(vault);
	for (const note of vault.notes) { const document = decodeDocument(note.state); document.destroy(); }
	for (const attachment of vault.attachments) if (await sha256(fromBase64(attachment.data)) !== attachment.sha256) throw new Error(`附件校验失败：${attachment.id}`);
	return `${vault.folders.length} 个文件夹、${vault.notes.length} 篇笔记、${vault.attachments.length} 个附件校验通过`;
}

export function rewriteLocalReferences(source: string, ids: Map<string, string>): string {
	return mapMarkdownDestinations(source, destination => { const url = /^(note|attachment):([a-zA-Z0-9-]+)$/.exec(destination); return url && ids.has(url[2]!) ? `${url[1]}:${ids.get(url[2]!)}` : undefined; });
}

/** Restore as an additional subtree. Never overwrite or delete current notes. */
export function mergeBackup(current: Vault, incoming: Vault, applyPreferences = false): Vault {
	const root = { id: newId(), parentId: null, name: `恢复 ${new Date().toISOString().slice(0, 10)}`, createdAt: Date.now() };
	const ids = new Map([...incoming.folders, ...incoming.notes, ...incoming.attachments].map(item => [item.id, newId()]));
	const rewrite = (source: string) => rewriteLocalReferences(source, ids);
	const notes = incoming.notes.map(note => {
		const document = decodeDocument(note.state);
		try {
			const edit = minimalEdit(document.source, rewrite(document.source));
			if (edit) document.edit([edit]);
			return { ...note, id: ids.get(note.id)!, folderId: note.folderId ? ids.get(note.folderId)! : root.id, state: encodeDocument(document), history: note.history.map(entry => ({ ...entry, id: newId(), source: rewrite(entry.source) })) };
		} finally { document.destroy(); }
	});
	return { ...current, preferences: applyPreferences ? { ...incoming.preferences } : current.preferences,
		folders: [...current.folders, root, ...incoming.folders.map(folder => ({ ...folder, id: ids.get(folder.id)!, parentId: folder.parentId ? ids.get(folder.parentId)! : root.id }))],
		notes: [...current.notes, ...notes], attachments: [...current.attachments, ...incoming.attachments.map(a => ({ ...a, id: ids.get(a.id)! }))],
	};
}

export async function exportDirectory(vault: Vault) {
	const entries: Record<string, Uint8Array> = Object.create(null);
	for (const folder of vault.folders) {
		const parents: string[] = [];
		let current: typeof folder | undefined = folder;
		while (current) { parents.unshift(`${safeName(current.name)}~${current.id.slice(0, 8)}`); current = vault.folders.find(f => f.id === current!.parentId); }
		entries[parents.join('/') + '/'] = new Uint8Array();
	}
	for (const note of vault.notes.filter(note => !note.deletedAt)) {
		const parents: string[] = [];
		let current = vault.folders.find(folder => folder.id === note.folderId);
		while (current) { parents.unshift(`${safeName(current.name)}~${current.id.slice(0, 8)}`); current = vault.folders.find(folder => folder.id === current!.parentId); }
		const document = decodeDocument(note.state);
		try { entries[[...parents, `${safeName(note.title)}~${note.id.slice(0, 8)}.md`].join('/')] = strToU8(document.source); }
		finally { document.destroy(); }
	}
	// A full manifest makes this archive lossless in JoplinU, while .md files remain readable without it.
	entries['.joplinu/backup.json'] = strToU8(await createBackup(vault));
	for (const attachment of vault.attachments) entries[`resources/${attachment.id}-${safeName(attachment.name)}`] = fromBase64(attachment.data);
	if (Object.values(entries).reduce((size, bytes) => size + bytes.length, 0) > LIMIT) throw new Error('目录 ZIP 解压内容超过 30 MiB，请使用完整备份导出');
	return zipSync(entries, { level: 6 });
}

export function unzipLimited(bytes: Uint8Array): Record<string, Uint8Array> {
	if (bytes.length > LIMIT) throw new Error('ZIP 超过 30 MiB 上限');
	const result: Record<string, Uint8Array> = Object.create(null);
	let count = 0; let total = 0; let failure: Error | undefined;
	const unzip = new Unzip(file => {
		if (++count > 5000 || file.name.length > 1000 || /(^\/|\\|^[a-zA-Z]:|(^|\/)\.\.?(\/|$))/.test(file.name) || Object.hasOwn(result, file.name)) { failure = new Error('ZIP 包含危险路径、重复路径或过多文件'); return; }
		if (file.originalSize !== undefined && file.originalSize > LIMIT) { failure = new Error('ZIP 解压大小超限'); return; }
		const chunks: Uint8Array[] = [];
		result[file.name] = new Uint8Array();
		file.ondata = (error, chunk, final) => {
			if (error) { failure = new Error('ZIP 解压失败'); return; }
			total += chunk.length;
			if (total > LIMIT) { failure = new Error('ZIP 解压大小超限'); file.terminate(); return; }
			chunks.push(chunk);
			if (final) { const data = new Uint8Array(chunks.reduce((n, item) => n + item.length, 0)); let offset = 0; for (const item of chunks) { data.set(item, offset); offset += item.length; } result[file.name] = data; }
		};
		if (!failure) file.start();
	});
	unzip.register(UnzipInflate);
	// Bound each decompression callback; stop before processing the remainder after a limit failure.
	for (let offset = 0; offset < bytes.length && !failure; offset += 8192) unzip.push(bytes.subarray(offset, offset + 8192), offset + 8192 >= bytes.length);
	if (failure) throw failure;
	return result;
}

export async function importArchive(current: Vault, bytes: Uint8Array): Promise<Vault> {
	const files = unzipLimited(bytes);
	if (files['.joplinu/backup.json']) {
		const incoming = await readBackup(strFromU8(files['.joplinu/backup.json']));
		return mergeBackup(current, incoming);
	}
	return importDirectoryFiles(current, Object.entries(files).filter(([path]) => !path.endsWith('/')).map(([path, data]) => ({ path, file: new File([new Uint8Array(data)], path.split('/').at(-1)!, { type: mimeForPath(path) }) })));
}

const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf' };
const mimeForPath = (path: string) => mimeTypes[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream';

export function resolveRelativePath(markdownPath: string, url: string): string | undefined {
	if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url) || /[\\\u0000-\u001f]/.test(url)) return;
	let decoded: string; try { decoded = decodeURIComponent(url.split(/[?#]/)[0]!); } catch { return; }
	if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(decoded) || /[\\\u0000-\u001f]/.test(decoded)) return;
	const parts = markdownPath.split('/'); parts.pop();
	for (const part of decoded.split('/')) { if (!part || part === '.') continue; if (part === '..') { if (!parts.length) return; parts.pop(); } else parts.push(part); }
	return parts.join('/');
}

/** Generic Markdown folders import referenced resources and convert relative .md links into local note links. */
export async function importDirectoryFiles(current: Vault, files: { path: string; file: File }[]) {
	if (files.length > 5000 || files.reduce((size, entry) => size + entry.file.size, 0) > 20 * 1024 * 1024) throw new Error('文件夹超过 5000 个文件或 20 MiB 上限');
	const paths = new Map(files.map(entry => [entry.path, entry.file]));
	if (paths.size !== files.length) throw new Error('文件夹包含重复路径');
	for (const path of paths.keys()) if (!path || /(^\/|\\|^[a-zA-Z]:|(^|\/)\.\.?(\/|$))/.test(path)) throw new Error('文件夹包含危险路径');
	const markdown = files.filter(entry => /\.(md|markdown|txt)$/i.test(entry.path));
	const texts = await Promise.all(markdown.map(async entry => ({ path: entry.path, source: await entry.file.text() })));
	const result = importMarkdownFiles(current, texts);
	const imported = result.notes.slice(current.notes.length);
	const notes = new Map(markdown.map((entry, index) => [entry.path, imported[index]!.id]));
	const referenced = new Set<string>();
	for (const text of texts) mapMarkdownDestinations(text.source, url => { const path = resolveRelativePath(text.path, url); if (path && paths.has(path) && !notes.has(path)) referenced.add(path); return undefined; });
	const attachments = new Map<string, Attachment>();
	for (const path of referenced) attachments.set(path, await makeAttachment(paths.get(path)!, current.preferences.imageMaxWidth));
	for (let index = 0; index < texts.length; index++) {
		const text = texts[index]!;
		const source = mapMarkdownDestinations(text.source, url => { const path = resolveRelativePath(text.path, url); if (!path) return; if (notes.has(path)) return `note:${notes.get(path)}`; if (attachments.has(path)) return `attachment:${attachments.get(path)!.id}`; return; });
		if (source === text.source) continue;
		const note = imported[index]!; const document = decodeDocument(note.state);
		try { const edit = minimalEdit(document.source, source); if (edit) document.edit([edit]); note.state = encodeDocument(document); } finally { document.destroy(); }
	}
	return { ...result, attachments: [...result.attachments, ...attachments.values()] };
}
export function importMarkdownFiles(current: Vault, files: { path: string; source: string }[]): Vault {
	if (!files.length || files.length > 1000) throw new Error('请选择 1–1000 个 Markdown 文件');
	const root = { id: newId(), parentId: null, name: '导入的笔记', createdAt: Date.now() };
	const folders = [...current.folders, root];
	const notes = [...current.notes];
	const paths = new Map<string, string>([['', root.id]]);
	for (const file of files) {
		if (!file.path || /(^\/|\\|^[a-zA-Z]:|(^|\/)\.\.?(\/|$))/.test(file.path) || file.path.length > 1000 || strToU8(file.source).length > 2 * 1024 * 1024) throw new Error('导入路径无效或文件超过 2 MiB');
		const segments = file.path.split('/').filter(Boolean);
		const filename = segments.pop()!;
		let parentId = root.id;
		let path = '';
		for (const segment of segments) {
			path += '/' + segment;
			if (!paths.has(path)) { const folder = { id: newId(), parentId, name: segment.slice(0, 500), createdAt: Date.now() }; folders.push(folder); paths.set(path, folder.id); }
			parentId = paths.get(path)!;
		}
		notes.push(createNote(filename.replace(/\.(md|markdown|txt)$/i, '').slice(0, 500), parentId, file.source));
	}
	return { ...current, folders, notes };
}

export async function makeAttachment(file: File, imageMaxWidth: number): Promise<Attachment> {
	if (file.size > 8 * 1024 * 1024) throw new Error('附件超过当前 8 MiB 上限');
	let data = new Uint8Array(await file.arrayBuffer());
	let mime = file.type || mimeForPath(file.name);
	// Never execute SVG/HTML. Raster decoding and resizing is explicit and only applies to static images.
	if (imageMaxWidth && /image\/(jpeg|png|webp)/.test(mime)) {
		const bitmap = await createImageBitmap(file);
		try {
			if (bitmap.width * bitmap.height > 40_000_000) throw new Error('图片像素过大');
			if (bitmap.width > imageMaxWidth) {
				const canvas = document.createElement('canvas'); canvas.width = imageMaxWidth; canvas.height = Math.round(bitmap.height * imageMaxWidth / bitmap.width);
				canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
				const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片缩放失败')), mime, .9));
				data = new Uint8Array(await blob.arrayBuffer()); mime = blob.type;
			}
		} finally { bitmap.close(); }
	}
	return { id: newId(), name: file.name.slice(0, 500), mime, data: toBase64(data), sha256: await sha256(data), createdAt: Date.now() };
}

const searchCache = new WeakMap<object, string>();
export function searchableNotes(vault: Vault, query: string, folderId: string | null, trash: boolean) {
	const words = query.trim().toLocaleLowerCase(vault.preferences.language).split(/\s+/).filter(Boolean);
	return vault.notes.filter(note => !!note.deletedAt === trash && (!folderId || note.folderId === folderId)).filter(note => {
		if (!words.length) return true;
		let text = searchCache.get(note);
		if (text === undefined) { const document = decodeDocument(note.state); try { text = [note.title, ...note.tags, document.source].join('\n'); searchCache.set(note, text); } finally { document.destroy(); } }
		const content = [text, ...folderPath(vault, note.folderId)].join('\n').toLocaleLowerCase(vault.preferences.language); return words.every(word => content.includes(word));
	}).sort((a, b) => vault.preferences.sort === 'title' ? a.title.localeCompare(b.title, vault.preferences.language) : b.updatedAt - a.updatedAt);
}
