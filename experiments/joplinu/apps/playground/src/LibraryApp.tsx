import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LibraryController } from '../../../packages/library/src/controller';
import { createNote, folderPath, formatDate, fromBase64, moveFolder, validatePreferences, type Note, type Preferences, type Vault } from '../../../packages/library/src/model';
import { createBackup, exportDirectory, importArchive, importDirectoryFiles, makeAttachment, mergeBackup, readBackup, readMarkdownFile, searchableNotes } from '../../../packages/library/src/transfer';
import { encryptBackup, decryptBackup } from '../../../packages/crypto/src/backup';
import { parseMarkdown } from '../../../packages/markdown/src/index';
import { exportFile, exportMarkdown } from '../../../packages/platform/src/export';
import { Editor } from './Editor';
import { Dialog, DialogErrorContext } from './Dialog';
import { FolderDialog, FolderTree, MetadataDialog, TagManager } from './LibraryDialogs';
import { NoteList } from './NoteList';
import { PaneResizer } from './PaneResizer';
import { Settings, type ExportKind, type ImportKind } from './Settings';
import type { RootContent } from 'mdast';
import { syncSession } from '../../../packages/sync/src/engine';
import { configuredProvider } from './SyncSettings';
import { cloudBridge, cloudValue } from '../../../packages/platform/src/cloud';

type Modal = { kind: 'settings' | 'attachments' | 'link' | 'metadata' | 'history' | 'empty-trash' | 'outline' | 'tags' } | { kind: 'folder'; id?: string } | { kind: 'attachment'; id: string } | { kind: 'move'; ids: string[] } | { kind: 'note-menu'; id: string };
const words = (node: RootContent): string => 'value' in node ? String(node.value) : 'children' in node ? node.children.map(child => words(child as RootContent)).join('') : '';
const escapeLabel = (text: string) => text.replace(/[\\[\]]/g, '\\$&').replace(/[\r\n]/g, ' ');

export function LibraryApp({ controller }: { controller: LibraryController }) {
	useSyncExternalStore(controller.subscribe, controller.getSnapshot);
	const sync = syncSession(controller); useSyncExternalStore(sync.subscribe, sync.getSnapshot);
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined; let attempted = -1; let disposed = false;
		const queue = () => {
			if (disposed || !sync.unlocked || sync.busy || !sync.hasPendingLocal || attempted === controller.contentVersion) return;
			clearTimeout(timer);
			timer = setTimeout(() => {
				if (disposed || sync.busy || !sync.unlocked) return;
				attempted = controller.contentVersion;
				void sync.queueLocal().then(async () => { const bridge = cloudBridge(); if (controller.syncState?.autoSync && controller.syncState.outbox.length && bridge?.scheduleTransfer) await cloudValue(bridge.scheduleTransfer()); }).catch(() => {});
			}, 1000);
		};
		const offController = controller.subscribe(queue); const offSync = sync.subscribe(queue); queue();
		return () => { disposed = true; clearTimeout(timer); offController(); offSync(); };
	}, [controller, sync]);
	useEffect(() => {
		const tick = () => { if (!sync.unlocked || sync.busy || !controller.syncState?.autoSync || document.visibilityState !== 'visible' || !navigator.onLine) return; void configuredProvider().then(provider => sync.sync(provider)).catch(() => {}); };
		const timer = setInterval(tick, 60000); window.addEventListener('online', tick);
		return () => { clearInterval(timer); window.removeEventListener('online', tick); };
	}, [controller, sync]);
	const vault = controller.vault;
	const p = vault.preferences;
	const t = (zh: string, en: string) => p.language === 'en-US' ? en : zh;
	const [selectedId, setSelectedId] = useState<string | undefined>(vault.notes.find(note => !note.deletedAt)?.id);
	const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
	const [folderId, setFolderId] = useState<string | null>(null);
	const [trash, setTrash] = useState(false);
	const [query, setQuery] = useState('');
	const [sidebar, setSidebar] = useState(false);
	const [mobileView, setMobileView] = useState<'editor' | 'notes'>('editor');
	const [tag, setTag] = useState<string>();
	const [checked, setChecked] = useState(new Set<string>());
	const [modal, setModal] = useState<Modal>();
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [busy, setBusy] = useState(false);
	const [historyId, setHistoryId] = useState<string>();
	const [permanentConfirmation, setPermanentConfirmation] = useState('');
	const importInput = useRef<HTMLInputElement>(null);
	const folderInput = useRef<HTMLInputElement>(null);
	const otherInput = useRef<HTMLInputElement>(null);
	const attachmentInput = useRef<HTMLInputElement>(null);
	const searchInput = useRef<HTMLInputElement>(null);
	const titleInput = useRef<HTMLInputElement>(null);
	const navigationRef = useRef<HTMLElement>(null);
	const pendingImport = useRef<{ kind: ImportKind; password: string; applyPreferences: boolean }>({ kind: 'markdown', password: '', applyPreferences: false });
	const current = vault.notes.find(note => note.id === selectedId);
	const noteDocument = current ? controller.document(current.id) : undefined;
	const activeDocument = useRef(noteDocument); activeDocument.current = noteDocument;
	const notes = useMemo(() => searchableNotes(vault, query, query.trim() ? null : folderId, trash, tag), [vault.notes, vault.folders, p.sort, p.language, query, folderId, trash, tag]);
	const tags = useMemo(() => { const counts = new Map<string, number>(); for (const note of vault.notes) if (!note.deletedAt) for (const name of new Set(note.tags)) counts.set(name, (counts.get(name) ?? 0) + 1); return [...counts].sort(([a], [b]) => a.localeCompare(b, p.language)); }, [vault.notes, p.language]);
	useEffect(() => setChecked(new Set()), [folderId, trash, query, tag]);
	useEffect(() => {
		const media = window.matchMedia('(max-width: 1100px)');
		const resized = () => setSidebar(false);
		media.addEventListener('change', resized); return () => media.removeEventListener('change', resized);
	}, []);
	useEffect(() => {
		if (!sidebar || modal || !window.matchMedia('(max-width: 1100px)').matches) return;
		const previous = document.activeElement as HTMLElement | null;
		const panes = [...document.querySelectorAll<HTMLElement>('.note-list-pane, .library-main')];
		for (const pane of panes) pane.inert = true;
		const focusable = () => [...navigationRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select') ?? []].filter(element => element.getClientRects().length > 0);
		focusable()[0]?.focus();
		const tab = (event: KeyboardEvent) => {
			if (event.key !== 'Tab' || document.querySelector('dialog[open]')) return;
			const targets = focusable(); const next = event.shiftKey ? targets.at(-1) : targets[0];
			if (document.activeElement === (event.shiftKey ? targets[0] : targets.at(-1))) { event.preventDefault(); next?.focus(); }
		};
		document.addEventListener('keydown', tab);
		return () => { for (const pane of panes) pane.inert = false; document.removeEventListener('keydown', tab); if (previous?.getClientRects().length) previous.focus(); };
	}, [sidebar, modal]);
	const updatePreferences = (fields: Partial<Preferences>) => controller.change({ ...controller.vault, preferences: { ...controller.vault.preferences, ...fields } });
	const headings = useMemo(() => noteDocument && p.toc ? parseMarkdown(noteDocument.source).children.filter(node => node.type === 'heading').map(node => ({ text: words(node), depth: node.type === 'heading' ? node.depth : 1, offset: node.position?.start.offset ?? 0 })) : [], [noteDocument?.source, p.toc]);
	const assets = useMemo(() => new Map(vault.attachments.map(attachment => [attachment.id, { url: URL.createObjectURL(new Blob([new Uint8Array(fromBase64(attachment.data))], { type: attachment.mime })), mime: attachment.mime }])), [vault.attachments]);
	useEffect(() => () => { for (const asset of assets.values()) URL.revokeObjectURL(asset.url); }, [assets]);
	useEffect(() => {
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const apply = () => { document.documentElement.dataset.theme = p.theme === 'system' ? (media.matches ? 'dark' : 'light') : p.theme; document.documentElement.lang = p.language; };
		apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
	}, [p.theme, p.language]);
	useEffect(() => {
		const beforeUnload = (event: BeforeUnloadEvent) => { if (controller.hasUnsavedChanges) { void controller.flush(); event.preventDefault(); event.returnValue = ''; } };
		const flush = () => { if (document.visibilityState === 'hidden') void controller.flush(); };
		window.addEventListener('beforeunload', beforeUnload); document.addEventListener('visibilitychange', flush);
		return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('visibilitychange', flush); };
	}, [controller]);
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !document.querySelector('dialog[open]')) setSidebar(false);
			if (!(event.ctrlKey || event.metaKey) || event.isComposing || event.keyCode === 229 || noteDocument?.isComposing) return;
			if (event.key.toLowerCase() === 's') { event.preventDefault(); void controller.flush(); }
			if (document.querySelector('dialog[open]')) return;
			if (event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); setSidebar(false); setMobileView('notes'); updatePreferences({ showNoteList: true }); setTimeout(() => searchInput.current?.focus(), 0); }
			if (event.key.toLowerCase() === 'n' && !event.shiftKey) { event.preventDefault(); addNote(); }
			if (event.shiftKey && event.key.toLowerCase() === 'l') { event.preventDefault(); updatePreferences({ showNoteList: !controller.vault.preferences.showNoteList }); }
			if (event.key === ',') { event.preventDefault(); setModal({ kind: 'settings' }); }
		};
		window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
	}, [controller, noteDocument, folderId, tag, p.language]);
	const run = (action: () => void | Promise<void>) => { setError(''); void Promise.resolve().then(action).catch(problem => setError(problem instanceof Error ? problem.message : '操作失败；原数据已保留')); };
	const close = () => setModal(undefined);
	const select = (note: Note) => {
		if (activeDocument.current?.isComposing) { setNotice('请先结束中文输入再切换笔记'); return; }
		setSelectedId(note.id); setSidebar(false); setMobileView('editor'); setHistoryId(undefined);
	};
	const openNote = (id: string) => {
		if (activeDocument.current?.isComposing) return;
		const note = controller.vault.notes.find(note => note.id === id && !note.deletedAt);
		if (!note) { setNotice('链接的笔记不存在或已在回收站中'); return; }
		setTrash(false); setFolderId(note.folderId); setTag(undefined); setQuery(''); select(note);
	};
	const activateFolder = (id: string | null, showTrash = false) => {
		if (activeDocument.current?.isComposing) { setNotice('请先结束中文输入'); return; }
		setFolderId(id); setTrash(showTrash); setTag(undefined); setQuery(''); setSidebar(false); setMobileView('notes'); if (!p.showNoteList) updatePreferences({ showNoteList: true });
		if (!current || !!current.deletedAt !== showTrash || (id !== null && current.folderId !== id)) setSelectedId(searchableNotes(controller.vault, '', id, showTrash)[0]?.id);
	};
	const activateTag = (name: string) => {
		if (activeDocument.current?.isComposing) { setNotice('请先结束中文输入'); return; }
		setTag(name); setFolderId(null); setTrash(false); setQuery(''); setSidebar(false); setMobileView('notes');
		if (!p.showNoteList) updatePreferences({ showNoteList: true });
		if (!current || current.deletedAt || !current.tags.includes(name)) setSelectedId(searchableNotes(controller.vault, '', null, false, name)[0]?.id);
	};
	const newEntry = (kind: Note['kind']) => {
		if (activeDocument.current?.isComposing) return;
		const note = { ...createNote(kind === 'todo' ? t('无标题待办', 'Untitled to-do') : t('无标题笔记', 'Untitled note'), folderId), kind, tags: tag ? [tag] : [] };
		controller.change({ ...controller.vault, notes: [...controller.vault.notes, note] });
		setTrash(false); setQuery(''); select(note);
		requestAnimationFrame(() => { titleInput.current?.focus(); titleInput.current?.select(); });
	};
	const addNote = () => newEntry('note');
	const smartView = (query: string) => { if (activeDocument.current?.isComposing) return; setQuery(query); setTag(undefined); setFolderId(null); setTrash(false); setSidebar(false); setMobileView('notes'); updatePreferences({ showNoteList: true }); };
	const insert = (text: string) => {
		if (!current || !noteDocument || current.deletedAt) throw new Error('请先打开一篇笔记');
		if (noteDocument.isComposing) throw new Error('请先结束中文输入');
		const { anchor, head } = noteDocument.restoreSelection();
		noteDocument.undo.stopCapturing(); noteDocument.edit([{ from: Math.min(anchor, head), to: Math.max(anchor, head), insert: text }], noteDocument.source);
	};
	const exportData = async (kind: ExportKind, password = '') => {
		const now = new Date().toISOString().slice(0, 10); const snapshot = controller.vault;
		if (kind === 'directory') await exportFile(await exportDirectory(snapshot), `JoplinU-folders-${now}.zip`, 'application/zip');
		else if (kind === 'settings') await exportFile(JSON.stringify({ format: 'JoplinU settings', version: 1, preferences: snapshot.preferences }, null, 2), 'JoplinU-settings.json', 'application/json');
		else if (kind === 'logs') await exportFile(JSON.stringify(snapshot.logs, null, 2), 'JoplinU-log.json', 'application/json');
		else { const backup = await createBackup(snapshot); await exportFile(kind === 'encrypted' ? await encryptBackup(backup, password) : backup, `JoplinU-${now}${kind === 'encrypted' ? '.encrypted' : ''}.json`, 'application/json'); }
		setNotice('已导出，请独立保管备份文件'); controller.log('资料导出完成');
	};
	const requestImport = (kind: ImportKind, password = '', applyPreferences = false) => {
		pendingImport.current = { kind, password, applyPreferences };
		if (kind === 'markdown') importInput.current?.click();
		else if (kind === 'directory') folderInput.current?.click();
		else if (otherInput.current) { otherInput.current.accept = kind === 'archive' ? '.zip,application/zip' : '.json,application/json'; otherInput.current.click(); }
	};
	const importFiles = (files: File[], kind: ImportKind) => run(async () => {
		if (!files.length) return;
		const { password, applyPreferences } = pendingImport.current;
		pendingImport.current = { kind: 'markdown', password: '', applyPreferences: false }; setBusy(true);
		try {
			if (kind === 'markdown' || kind === 'directory') {
				const selected = files.filter(file => /\.(md|markdown|txt)$/i.test(file.name));
				if (!selected.length || selected.length > 1000 || selected.reduce((size, file) => size + file.size, 0) > 20 * 1024 * 1024 || selected.some(file => file.size > 2 * 1024 * 1024)) throw new Error('支持最多 1000 个 Markdown 文件，每个不超过 2 MiB，总计不超过 20 MiB');
				const values = await Promise.all(selected.map(async file => ({ path: kind === 'directory' ? file.webkitRelativePath || file.name : file.name, source: await readMarkdownFile(file) })));
				if (activeDocument.current?.isComposing) throw new Error('请结束中文输入后重新导入');
				const before = controller.vault.notes.length; let next: Vault;
				if (kind === 'markdown' && values.length === 1) next = { ...controller.vault, notes: [...controller.vault.notes, createNote(selected[0]!.name.replace(/\.(md|markdown|txt)$/i, '').slice(0, 500), folderId, values[0]!.source)] };
				else { const baseline = controller.vault; next = await importDirectoryFiles(baseline, files.map(file => ({ path: kind === 'directory' ? file.webkitRelativePath || file.name : file.name, file }))); if (controller.vault !== baseline) throw new Error('导入期间资料已改变，请重试；原文已保留'); }
				controller.change(next); const imported = next.notes[before]!; setFolderId(imported.folderId); setTrash(false); setQuery(''); select(imported);
			} else {
				const file = files[0]!; if (file.size > 85 * 1024 * 1024) throw new Error('导入文件过大');
				if (kind === 'archive') {
					const bytes = new Uint8Array(await file.arrayBuffer()); const baseline = controller.vault; const next = await importArchive(baseline, bytes);
					if (controller.vault !== baseline) throw new Error('导入期间资料发生变化，请重试；已有内容未修改');
					controller.change(next);
				} else {
					let value = await file.text();
					if (kind === 'settings') {
						const profile = JSON.parse(value) as { format: unknown; version: unknown; preferences: unknown };
						if (profile.format !== 'JoplinU settings' || profile.version !== 1) throw new Error('配置档案格式不支持');
						controller.change({ ...controller.vault, preferences: validatePreferences(profile.preferences) });
					} else { if ((JSON.parse(value) as { format: string }).format === 'JoplinU encrypted backup') value = await decryptBackup(value, password); const incoming = await readBackup(value); controller.change(mergeBackup(controller.vault, incoming, applyPreferences)); }
				}
			}
			controller.log('资料导入完成'); await controller.flush(); if (controller.status !== 'saved') throw new Error('导入内容尚未保存，请导出当前备份并检查本地存储'); setNotice('导入完成，原有笔记已保留');
		} finally { setBusy(false); for (const input of [importInput.current, folderInput.current, otherInput.current]) if (input) input.value = ''; }
	});
	const addAttachments = (files: File[]) => run(async () => {
		if (!current || !noteDocument || current.deletedAt) throw new Error('请先打开一篇笔记');
		if (noteDocument.isComposing) throw new Error('请先结束中文输入');
		if (!files.length || files.length > 20) throw new Error('每次最多导入 20 个附件');
		const noteId = current.id; setBusy(true);
		try {
			const attachments = await Promise.all(files.map(file => makeAttachment(file, p.imageMaxWidth)));
			if (selectedRef.current !== noteId || noteDocument.isComposing) throw new Error('笔记或输入状态已改变，请重新导入附件');
			controller.change({ ...controller.vault, attachments: [...controller.vault.attachments, ...attachments] });
			insert(attachments.map(a => `${/^image\/(png|jpeg|gif|webp|avif)$/.test(a.mime) ? '!' : ''}[${escapeLabel(a.name)}](attachment:${a.id})`).join('\n') + '\n'); controller.log('附件导入完成');
		} finally { setBusy(false); if (attachmentInput.current) attachmentInput.current.value = ''; }
	});
	const downloadAttachment = async (id: string) => { const attachment = controller.vault.attachments.find(item => item.id === id); if (!attachment) throw new Error('附件不存在'); await exportFile(fromBase64(attachment.data), attachment.name, attachment.mime); };
	const drop = (event: React.DragEvent, targetFolder: string | null) => {
		event.preventDefault(); event.stopPropagation(); run(() => {
			const noteId = event.dataTransfer.getData('application/x-joplinu-note'); const draggedFolder = event.dataTransfer.getData('application/x-joplinu-folder');
			if (noteId) controller.updateNote(noteId, { folderId: targetFolder }); else if (draggedFolder) controller.change(moveFolder(controller.vault, draggedFolder, targetFolder));
		});
	};
	const trashNotes = (ids: string[], deleted: boolean) => run(() => { controller.trashNotes(ids, deleted); setChecked(new Set()); setNotice(deleted ? '已移入回收站，可以恢复' : '已恢复笔记'); });
	const listTitle = query === 'type:todo' ? t('待办事项', 'To-dos') : query === 'is:pinned' ? t('置顶笔记', 'Pinned notes') : query.trim() ? t('搜索结果', 'Search results') : tag ? `# ${tag}` : trash ? t('回收站', 'Trash') : folderPath(vault, folderId).at(-1) ?? t('全部笔记', 'All notes');
	const menuNote = modal?.kind === 'note-menu' ? vault.notes.find(note => note.id === modal.id) : undefined;
	const saveLabel = controller.status === 'saved' ? `已保存到本地 · ${controller.storage.kind}` : controller.status === 'error' ? '保存失败 · 请导出备份' : controller.status === 'saving' ? '正在保存…' : '本地修改待保存';
	const historyEntry = current?.history.find(entry => entry.id === historyId);
	const viewedAttachment = modal?.kind === 'attachment' ? vault.attachments.find(item => item.id === modal.id) : undefined;
	const feedback = <>{(error || controller.error) && <div role="alert" className="problem">{error || controller.error}<button onClick={() => run(() => exportData('backup'))}>导出当前备份</button>{error && <button onClick={() => setError('')}>关闭提示</button>}</div>}
			{notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')}>×</button></div>}{controller.syncRecoveryNote && <div className="notice" role="status">{controller.syncRecoveryNote}<button onClick={() => { activateFolder(null, true); controller.dismissSyncRecovery(); }}>查看回收站</button><button aria-label="关闭同步恢复提示" onClick={() => controller.dismissSyncRecovery()}>×</button></div>}{busy && <div role="status" className="notice">正在处理文件，请稍候…</div>}</>;
	return <DialogErrorContext.Provider value={error || controller.error}><div className={`library-shell ${!p.showSidebar ? 'sidebar-hidden' : ''} ${!p.showNoteList ? 'list-hidden' : ''} mobile-${mobileView}`} style={{ '--sidebar-width': `${p.sidebarWidth}px`, '--list-width': `${p.noteListWidth}px` } as React.CSSProperties}>
		{sidebar && <button className="navigation-scrim" aria-label="关闭笔记导航" onClick={() => setSidebar(false)} />}
		<aside ref={navigationRef} className={`library-sidebar ${sidebar ? 'open' : ''}`} aria-label="笔记导航">
			<div className="sidebar-brand"><a className="brand" href="#" onClick={event => event.preventDefault()}><span className="brand-icon">U</span>Joplin<span>U</span></a><button aria-label="设置" onClick={() => setModal({ kind: 'settings' })}>⚙</button></div>
			<button className="sidebar-new-note" aria-label="新建笔记" onClick={addNote}>{t('＋ 新建笔记', '+ New note')}</button><div className="sidebar-scroll">
			<div className="nav-heading"><span>{t('文件夹', 'Folders')}</span><button aria-label="新建文件夹" onClick={() => setModal({ kind: 'folder' })}>＋</button></div>
			<button className={`all-notes ${folderId === null && !trash && !tag && !query ? 'selected' : ''}`} onDragOver={event => event.preventDefault()} onDrop={event => drop(event, null)} onClick={() => activateFolder(null)}>{t('全部笔记', 'All notes')}<small>{vault.notes.filter(note => !note.deletedAt).length}</small></button>
			<button className={`all-notes ${query === 'type:todo' ? 'selected' : ''}`} onClick={() => smartView('type:todo')}>{t('待办事项', 'To-dos')}<small>{vault.notes.filter(note => !note.deletedAt && note.kind === 'todo' && note.completedAt === null).length}</small></button><button className={`all-notes ${query === 'is:pinned' ? 'selected' : ''}`} onClick={() => smartView('is:pinned')}>{t('置顶笔记', 'Pinned notes')}<small>{vault.notes.filter(note => !note.deletedAt && note.pinned).length}</small></button>
			<FolderTree vault={vault} selected={trash ? null : folderId} onSelect={activateFolder} onManage={id => setModal({ kind: 'folder', id })} onDrop={drop} />
			<button className={`all-notes ${trash ? 'selected' : ''}`} onClick={() => activateFolder(null, true)}>{t('回收站', 'Trash')}<small>{vault.notes.filter(note => note.deletedAt).length}</small></button>
			<div className="nav-heading"><span>{t('标签', 'Tags')}</span><button aria-label="管理标签" onClick={() => setModal({ kind: 'tags' })}>⋯</button></div><nav className="tag-list" aria-label="笔记标签">{tags.length ? tags.map(([name, count]) => <button key={name} className={tag === name ? 'selected' : ''} aria-pressed={tag === name} onClick={() => activateTag(name)}><span># {name}</span><small>{count}</small></button>) : <p className="sidebar-hint">在笔记“信息”中添加标签</p>}</nav></div>
			<div className="library-storage"><span className="status-dot" />{controller.storage.kind} · {t('本地笔记库', 'Local library')}<small>{sync.busy ? t('正在同步', 'Synchronizing') : sync.status === 'error' ? t('同步失败，请查看设置', 'Sync failed; see settings') : controller.syncState ? sync.unlocked ? t('加密同步已解锁', 'Encrypted sync unlocked') : t('加密同步已锁定', 'Encrypted sync locked') : t('云同步未连接', 'Cloud not connected')}</small></div>
		</aside>
		<PaneResizer label="调整文件夹栏宽度" property="--sidebar-width" value={p.sidebarWidth} min={180} max={340} initial={230} onChange={sidebarWidth => updatePreferences({ sidebarWidth })} />
		<NoteList feedback={feedback} onReturn={() => { if (!noteDocument?.isComposing) setMobileView('editor'); }} notes={notes} selectedId={selectedId} title={listTitle} preferences={p} query={query} searchRef={searchInput} onQuery={setQuery} checked={checked} onChecked={setChecked} onSelect={select} onCreate={addNote} onCreateTodo={() => newEntry('todo')} onToggleTodo={note => run(() => controller.toggleTodo(note.id))} onMenu={note => setModal({ kind: 'note-menu', id: note.id })} onNavigation={() => setSidebar(true)} onMove={ids => setModal({ kind: 'move', ids })} onTrash={trashNotes} trash={trash} onEmptyTrash={() => { setPermanentConfirmation(''); setModal({ kind: 'empty-trash' }); }} onSort={sort => updatePreferences({ sort })} />
		<PaneResizer label="调整笔记列表宽度" property="--list-width" value={p.noteListWidth} min={220} max={420} initial={280} onChange={noteListWidth => updatePreferences({ noteListWidth })} />
		<main className="library-main" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); addAttachments([...event.dataTransfer.files]); } }}>
			<header className="library-topbar"><button className="mobile-list-back" aria-label="打开笔记列表" onClick={() => { if (!noteDocument?.isComposing) setMobileView('notes'); }}>←</button><button className="mobile-navigation" aria-label="打开笔记导航" onClick={() => setSidebar(true)}>☰</button><div className="breadcrumb">{current ? folderPath(vault, current.folderId).join(' / ') || t('未分类', 'Unfiled') : t('个人笔记库', 'My library')}</div><div className="top-actions"><div className="pane-toggles"><button aria-label="切换文件夹栏" title="显示 / 隐藏文件夹栏" aria-pressed={p.showSidebar} onClick={() => updatePreferences({ showSidebar: !p.showSidebar })}>☷</button><button aria-label="切换笔记列表" title="显示 / 隐藏笔记列表 · Ctrl/Cmd+Shift+L" aria-pressed={p.showNoteList} onClick={() => updatePreferences({ showNoteList: !p.showNoteList })}>☰</button></div><button onClick={() => requestImport('markdown')}>{t('导入', 'Import')}</button><button disabled={!current} onClick={() => run(() => exportMarkdown(noteDocument?.source ?? '', `${current?.title || 'JoplinU'}.md`))}>导出 Markdown ↗</button><button aria-label="打开设置" onClick={() => setModal({ kind: 'settings' })}>⚙</button></div></header>
			<input ref={importInput} type="file" multiple accept=".md,.markdown,.txt,text/plain,text/markdown" aria-label="导入 Markdown" hidden onChange={event => importFiles([...event.target.files ?? []], 'markdown')} />
			<input ref={folderInput} type="file" multiple {...{ webkitdirectory: '' }} aria-label="导入文件夹" hidden onChange={event => importFiles([...event.target.files ?? []], 'directory')} />
			<input ref={otherInput} type="file" aria-label="导入资料文件" hidden onChange={event => importFiles([...event.target.files ?? []], pendingImport.current.kind)} />
			<input ref={attachmentInput} type="file" multiple aria-label="导入附件" hidden onChange={event => addAttachments([...event.target.files ?? []])} />
			{feedback}
			{current && noteDocument ? <>
				<div className="note-heading"><input ref={titleInput} aria-label="笔记标题" onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); window.dispatchEvent(new Event('joplinu-focus-editor')); } }} maxLength={500} value={current.title} readOnly={!!current.deletedAt} onChange={event => controller.updateNote(current.id, { title: event.target.value, updatedAt: Date.now() })} /><div className="note-actions">{current.deletedAt ? <button className="primary" onClick={() => { controller.updateNote(current.id, { deletedAt: null }); setTrash(false); setFolderId(current.folderId); }}>恢复笔记</button> : <><button aria-label="切换笔记类型" onClick={() => run(() => controller.setKind(current.id, current.kind === 'todo' ? 'note' : 'todo'))}>{current.kind === 'todo' ? '转为笔记' : '转为待办'}</button><button aria-label="切换笔记置顶" aria-pressed={current.pinned} onClick={() => run(() => controller.togglePin(current.id))}>{current.pinned ? '取消置顶' : '置顶'}</button>{current.kind === 'todo' && <label className="current-todo"><input type="checkbox" aria-label="完成当前待办" checked={current.completedAt !== null} onChange={() => run(() => controller.toggleTodo(current.id))} />{current.completedAt !== null ? '已完成' : '未完成'}</label>}<button onClick={() => attachmentInput.current?.click()}>附件</button><button onClick={() => setModal({ kind: 'link' })}>内链</button><button onClick={() => setModal({ kind: 'move', ids: [current.id] })}>移动</button><button onClick={() => setModal({ kind: 'metadata' })}>信息</button><button onClick={() => { setHistoryId(undefined); setModal({ kind: 'history' }); }}>历史</button>{p.toc && <button onClick={() => setModal({ kind: 'outline' })}>目录</button>}<button aria-label="将笔记移入回收站" onClick={() => { trashNotes([current.id], true); }}>⌫</button></>}</div></div>
				{current.deletedAt ? <section className="deleted-note"><h2>这篇笔记在回收站中</h2><p>正文、附件引用和历史仍然保留。恢复后可继续编辑。</p><pre>{noteDocument.source}</pre></section> : <div className="editor-with-outline"><Editor key={current.id} primary={noteDocument} preferences={p} assets={assets} onOpenNote={openNote} onOpenAttachment={id => setModal({ kind: 'attachment', id })} onRecovery={text => run(() => exportMarkdown(text, 'JoplinU-recovery.md'))} status={saveLabel} />{p.toc && headings.length > 0 && <nav className="document-outline" aria-label="标题目录"><span>目录</span>{headings.map((heading, i) => <button key={`${heading.offset}-${i}`} style={{ paddingLeft: Math.min(heading.depth, 4) * 8 }} onClick={() => window.dispatchEvent(new CustomEvent('joplinu-focus-source', { detail: heading.offset }))}>{heading.text || '无标题'}</button>)}</nav>}</div>}
			</> : <section className="empty-library"><span className="brand-icon">U</span><h1>{t('给想法一个位置', 'A place for your ideas')}</h1><p>创建笔记，或从 Markdown 文件夹开始。</p><button className="primary" onClick={addNote}>{t('新建笔记', 'New note')}</button></section>}
		</main>
		{modal?.kind === 'settings' && <Settings controller={controller} onClose={close} onExport={exportData} onImport={requestImport} onManageAttachments={() => setModal({ kind: 'attachments' })} run={run} />}
		{modal?.kind === 'tags' && <TagManager vault={vault} onClose={close} run={run} onRename={(from, to) => { controller.renameTag(from, to); if (tag === from) setTag(to.trim()); }} onRemove={name => { controller.removeTag(name); if (tag === name) setTag(undefined); }} />}
		{modal?.kind === 'folder' && <FolderDialog vault={vault} id={modal.id} defaultParent={folderId} onClose={close} onSave={next => { controller.change(next); if (folderId && !next.folders.some(folder => folder.id === folderId)) setFolderId(null); close(); }} run={run} />}
		{modal?.kind === 'move' && <Dialog title={modal.ids.length > 1 ? `移动 ${modal.ids.length} 篇笔记` : '移动笔记'} onClose={close}><div className="choice-list">{[{ id: null, name: '未分类' }, ...vault.folders.map(folder => ({ id: folder.id, name: folderPath(vault, folder.id).join(' / ') }))].map(folder => <button key={folder.id ?? 'unfiled'} onClick={() => run(() => { controller.moveNotes(modal.ids, folder.id); setFolderId(folder.id); setChecked(new Set()); close(); })}>{folder.name}</button>)}</div></Dialog>}
		{modal?.kind === 'note-menu' && menuNote && <Dialog title="笔记操作" onClose={close}><p>{menuNote.title || '无标题笔记'}</p><div className="choice-list"><button onClick={() => { close(); select(menuNote); }}>打开笔记</button>{!menuNote.deletedAt && <button onClick={() => run(() => { const copy = controller.duplicateNote(menuNote.id); setFolderId(copy.folderId); setQuery(''); setTag(undefined); select(copy); close(); setNotice('已创建独立副本，原笔记已保留'); })}>复制笔记</button>}<button onClick={() => setModal({ kind: 'move', ids: [menuNote.id] })}>移动笔记</button><button className={menuNote.deletedAt ? '' : 'danger'} onClick={() => { trashNotes([menuNote.id], !menuNote.deletedAt); close(); }}>{menuNote.deletedAt ? '恢复此笔记' : '移入回收站'}</button></div></Dialog>}
		{modal?.kind === 'metadata' && current && <MetadataDialog note={current} vault={vault} onClose={close} onSave={fields => { controller.updateNote(current.id, fields); close(); }} />}
		{modal?.kind === 'history' && current && <Dialog title="笔记历史" onClose={close} wide><div className="button-row"><button className="primary" onClick={() => controller.checkpoint(current.id)}>创建当前快照</button><span>{current.history.length} 个版本</span></div><div className="history-layout"><div className="choice-list">{current.history.map(entry => <button key={entry.id} className={historyId === entry.id ? 'selected' : ''} onClick={() => setHistoryId(entry.id)}>{formatDate(entry.createdAt, p)}<small>{entry.reason}</small></button>)}{!current.history.length && <p>尚无历史版本</p>}</div>{historyEntry ? <section><pre className="history-source">{historyEntry.source || '（空文档）'}</pre><button className="primary" onClick={() => run(() => { controller.restore(current.id, historyEntry.source); close(); setNotice('已恢复版本，恢复前的内容已另存快照'); })}>恢复此版本</button></section> : <p>选择一个版本查看原文。</p>}</div></Dialog>}
		{modal?.kind === 'link' && <Dialog title="插入笔记内链" onClose={close}><div className="choice-list">{vault.notes.filter(note => !note.deletedAt).map(note => <button key={note.id} onClick={() => run(() => { insert(`[${escapeLabel(note.title)}](note:${note.id})`); close(); })}>{note.title}<small>{folderPath(vault, note.folderId).join(' / ')}</small></button>)}</div></Dialog>}
		{modal?.kind === 'outline' && <Dialog title="标题目录" onClose={close}><div className="choice-list">{headings.map((heading, index) => <button key={index} onClick={() => { close(); setTimeout(() => window.dispatchEvent(new CustomEvent('joplinu-focus-source', { detail: heading.offset })), 0); }}>{'　'.repeat(Math.min(heading.depth - 1, 3))}{heading.text || '无标题'}</button>)}{!headings.length && <p>添加 Markdown 标题后会显示目录。</p>}</div></Dialog>}
		{modal?.kind === 'attachments' && <Dialog title="本地附件" onClose={close} wide><p>附件随完整备份保存。不会自动删除未引用附件，以免破坏历史版本。</p><div className="attachment-list">{vault.attachments.map(attachment => <div key={attachment.id}><strong>{attachment.name}</strong><small>{attachment.mime} · {Math.round(attachment.data.length * .75 / 1024)} KiB</small><div><button onClick={() => setModal({ kind: 'attachment', id: attachment.id })}>查看</button><button onClick={() => run(() => downloadAttachment(attachment.id))}>导出附件</button><button disabled={!current || !!current.deletedAt} onClick={() => run(() => { insert(`[${escapeLabel(attachment.name)}](attachment:${attachment.id})`); close(); })}>插入链接</button></div></div>)}{!vault.attachments.length && <p>还没有附件。打开笔记后点击“附件”导入。</p>}</div></Dialog>}
		{modal?.kind === 'attachment' && <Dialog title={viewedAttachment?.name ?? '附件'} onClose={close} wide>{viewedAttachment ? <><p>{viewedAttachment.mime}</p>{/^image\/(png|jpeg|gif|webp|avif)$/.test(viewedAttachment.mime) && <img className="attachment-image" src={assets.get(viewedAttachment.id)?.url} alt={viewedAttachment.name} />}{viewedAttachment.mime.startsWith('audio/') && <audio controls src={assets.get(viewedAttachment.id)?.url} />}{viewedAttachment.mime.startsWith('video/') && <video controls src={assets.get(viewedAttachment.id)?.url} />}<button className="primary" onClick={() => run(() => downloadAttachment(viewedAttachment.id))}>导出附件</button></> : <p>附件不存在，请恢复完整备份。</p>}</Dialog>}
		{modal?.kind === 'empty-trash' && <Dialog title="永久清空回收站" onClose={close}><p>将永久删除回收站中的所有笔记及其历史。附件会保留。请先导出备份。</p><button onClick={() => run(() => exportData('backup'))}>导出当前备份</button><label className="setting-field">输入“清空回收站”确认<input value={permanentConfirmation} onChange={event => setPermanentConfirmation(event.target.value)} /></label><button className="danger" disabled={permanentConfirmation !== '清空回收站'} onClick={() => { const remaining = vault.notes.filter(note => !note.deletedAt); controller.change({ ...vault, notes: remaining }); if (current?.deletedAt) setSelectedId(remaining[0]?.id); close(); controller.log('用户清空回收站'); }}>永久删除</button></Dialog>}
	</div></DialogErrorContext.Provider>;
}
