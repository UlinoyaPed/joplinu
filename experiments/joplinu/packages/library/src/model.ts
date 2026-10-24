import * as Y from 'yjs';
import { toBase64, fromBase64 } from '../../core/src/bytes';
import { NoteDocument } from '../../document/src/index';

export type Mode = 'live' | 'rich' | 'source' | 'split';
export interface Preferences {
	language: 'zh-CN' | 'en-US'; dateFormat: 'locale' | 'iso'; theme: 'system' | 'light' | 'dark';
	sort: 'updated' | 'title'; folderSort: 'name' | 'created'; fontSize: number; lineHeight: number;
	font: 'mono' | 'sans'; spellcheck: boolean; defaultMode: Mode; math: boolean; diagrams: boolean;
	highlight: boolean; toc: boolean; media: boolean; history: boolean; historyDays: number; imageMaxWidth: number;
	sidebarWidth: number; noteListWidth: number; showSidebar: boolean; showNoteList: boolean;
}
export const defaultPreferences: Preferences = {
	language: 'zh-CN', dateFormat: 'locale', theme: 'system', sort: 'updated', folderSort: 'name', fontSize: 15,
	lineHeight: 1.9, font: 'mono', spellcheck: false, defaultMode: 'live', math: true, diagrams: true,
	highlight: true, toc: true, media: true, history: true, historyDays: 90, imageMaxWidth: 1600,
	sidebarWidth: 230, noteListWidth: 280, showSidebar: true, showNoteList: true,
};
export interface Folder { id: string; parentId: string | null; name: string; createdAt: number }
export interface HistoryEntry { id: string; source: string; createdAt: number; reason: string }
export interface Note {
	id: string; folderId: string | null; title: string; tags: string[]; state: string;
	createdAt: number; updatedAt: number; deletedAt: number | null; history: HistoryEntry[];
	location: { latitude: number; longitude: number } | null;
}
export interface Attachment { id: string; name: string; mime: string; data: string; sha256: string; createdAt: number }
export interface LogEntry { at: number; level: 'info' | 'error'; message: string }
export interface Vault {
	schema: 1; id: string; folders: Folder[]; notes: Note[]; attachments: Attachment[];
	preferences: Preferences; logs: LogEntry[];
}
export const newId = (): string => crypto.randomUUID();
export { toBase64, fromBase64, sha256 } from '../../core/src/bytes';
export const encodeDocument = (document: NoteDocument) => toBase64(Y.encodeStateAsUpdate(document.doc));
export function decodeDocument(state: string) {
	const document = new NoteDocument();
	try { document.applyRemote(fromBase64(state)); return document; }
	catch { document.destroy(); throw new Error('笔记 CRDT 数据损坏；原数据未重置'); }
}
export function createNote(title: string, folderId: string | null, source = ''): Note {
	const document = new NoteDocument(source);
	try { return { id: newId(), folderId, title: title.trim() || '无标题笔记', tags: [], state: encodeDocument(document), createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null, history: [], location: null }; }
	finally { document.destroy(); }
}
export function createVault(source = ''): Vault {
	const folder: Folder = { id: newId(), name: '我的笔记', parentId: null, createdAt: Date.now() };
	return { schema: 1, id: newId(), folders: [folder], notes: [createNote('欢迎使用 JoplinU', folder.id, source)], attachments: [], preferences: { ...defaultPreferences }, logs: [] };
}

export function descendants(vault: Vault, folderId: string): Set<string> {
	const result = new Set([folderId]);
	for (let changed = true; changed;) {
		changed = false;
		for (const folder of vault.folders) if (folder.parentId && result.has(folder.parentId) && !result.has(folder.id)) { result.add(folder.id); changed = true; }
	}
	return result;
}
export function moveFolder(vault: Vault, id: string, parentId: string | null) {
	const folder = vault.folders.find(item => item.id === id);
	if (!folder || (parentId && (!vault.folders.some(item => item.id === parentId) || descendants(vault, id).has(parentId)))) throw new Error('不能将文件夹移入自身或子文件夹');
	return { ...vault, folders: vault.folders.map(item => item.id === id ? { ...item, parentId } : item) };
}
export function folderPath(vault: Vault, id: string | null): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	while (id) {
		if (seen.has(id)) throw new Error('文件夹层级循环');
		seen.add(id);
		const folder = vault.folders.find(item => item.id === id);
		if (!folder) break;
		result.unshift(folder.name); id = folder.parentId;
	}
	return result;
}
/** Remove only the container. Keep notes (including trash), children and their identities. */
export function dissolveFolder(vault: Vault, id: string): Vault {
	const target = vault.folders.find(folder => folder.id === id);
	if (!target) throw new Error('文件夹不存在');
	return { ...vault, folders: vault.folders.filter(folder => folder.id !== id).map(folder => folder.parentId === id ? { ...folder, parentId: target.parentId } : folder),
		notes: vault.notes.map(note => note.folderId === id ? { ...note, folderId: target.parentId } : note) };
}
export function formatDate(value: number, preferences: Preferences) {
	return preferences.dateFormat === 'iso' ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : new Date(value).toLocaleString(preferences.language);
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的资料结构');
	return value as Record<string, unknown>;
}
function string(value: unknown, max = 500) { if (typeof value !== 'string' || value.length > max) throw new Error('无效的文本字段'); return value; }
function time(value: unknown) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 8640000000000000) throw new Error('无效的时间'); return value; }
function list(value: unknown, max = 10000): unknown[] { if (!Array.isArray(value) || value.length > max) throw new Error('无效的列表'); return value; }
function id(value: unknown) { const text = string(value, 100); if (!/^[a-zA-Z0-9-]{1,100}$/.test(text)) throw new Error('无效的标识符'); return text; }
function optionalId(value: unknown) { return value === null ? null : id(value); }
function enumeration<T extends string>(value: unknown, allowed: readonly T[]): T { if (!allowed.includes(value as T)) throw new Error('无效的设置选项'); return value as T; }
function number(value: unknown, min: number, max: number) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('设置数值超出范围'); return value; }

export function validatePreferences(value: unknown): Preferences {
	const p = object(value);
	const result: Preferences = {
		language: enumeration(p.language, ['zh-CN', 'en-US']), dateFormat: enumeration(p.dateFormat, ['locale', 'iso']),
		theme: enumeration(p.theme, ['system', 'light', 'dark']), sort: enumeration(p.sort, ['updated', 'title']), folderSort: enumeration(p.folderSort, ['name', 'created']),
		fontSize: number(p.fontSize, 12, 32), lineHeight: number(p.lineHeight, 1.2, 3), font: enumeration(p.font, ['mono', 'sans']),
		defaultMode: enumeration(p.defaultMode, ['live', 'rich', 'source', 'split']), historyDays: number(p.historyDays, 1, 3650), imageMaxWidth: number(p.imageMaxWidth, 0, 8192),
		spellcheck: false, math: false, diagrams: false, highlight: false, toc: false, media: false, history: false,
		sidebarWidth: p.sidebarWidth === undefined ? defaultPreferences.sidebarWidth : number(p.sidebarWidth, 180, 340),
		noteListWidth: p.noteListWidth === undefined ? defaultPreferences.noteListWidth : number(p.noteListWidth, 220, 420),
		showSidebar: true, showNoteList: true,
	};
	for (const key of ['spellcheck', 'math', 'diagrams', 'highlight', 'toc', 'media', 'history'] as const) {
		if (typeof p[key] !== 'boolean') throw new Error('无效的开关设置'); result[key] = p[key];
	}
	for (const key of ['showSidebar', 'showNoteList'] as const) {
		if (p[key] !== undefined && typeof p[key] !== 'boolean') throw new Error('无效的布局设置');
		result[key] = p[key] === undefined ? defaultPreferences[key] : p[key] as boolean;
	}
	return result;
}

/** Strict reconstruction prevents malformed imports, orphan IDs and prototype keys. */
export function validateVault(value: unknown): Vault {
	const v = object(value);
	if (v.schema !== 1) throw new Error('不支持的资料版本；原数据未修改');
	const folders: Folder[] = list(v.folders).map(value => { const f = object(value); return { id: id(f.id), name: string(f.name), parentId: optionalId(f.parentId), createdAt: time(f.createdAt) }; });
	const notes: Note[] = list(v.notes).map(value => {
		const n = object(value);
		const location = n.location === null ? null : { latitude: number(object(n.location).latitude, -90, 90), longitude: number(object(n.location).longitude, -180, 180) };
		return { id: id(n.id), folderId: optionalId(n.folderId), title: string(n.title), tags: list(n.tags, 100).map(t => string(t, 100)), state: string(n.state, 8 * 1024 * 1024),
			createdAt: time(n.createdAt), updatedAt: time(n.updatedAt), deletedAt: n.deletedAt === null ? null : time(n.deletedAt), location,
			history: list(n.history, 1000).map(value => { const h = object(value); return { id: id(h.id), source: string(h.source, 2 * 1024 * 1024), createdAt: time(h.createdAt), reason: string(h.reason) }; }),
		};
	});
	const attachments: Attachment[] = list(v.attachments, 1000).map(value => { const a = object(value); const sha256 = string(a.sha256, 64); if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('无效的附件校验值'); return { id: id(a.id), name: string(a.name), mime: string(a.mime, 200), data: string(a.data, 14 * 1024 * 1024), sha256, createdAt: time(a.createdAt) }; });
	const identifiers = new Set<string>();
	for (const entry of [...folders, ...notes, ...attachments]) { if (identifiers.has(entry.id)) throw new Error('重复标识符'); identifiers.add(entry.id); }
	const folderIds = new Set(folders.map(f => f.id));
	for (const folder of folders) if (folder.parentId && !folderIds.has(folder.parentId)) throw new Error('文件夹父目录不存在');
	for (const note of notes) if (note.folderId && !folderIds.has(note.folderId)) throw new Error('笔记文件夹不存在');
	const vault: Vault = { schema: 1, id: id(v.id), folders, notes, attachments, preferences: validatePreferences(v.preferences), logs: list(v.logs, 200).map(value => { const l = object(value); return { at: time(l.at), level: enumeration(l.level, ['info', 'error']), message: string(l.message, 500) }; }) };
	for (const folder of folders) folderPath(vault, folder.id);
	return vault;
}
