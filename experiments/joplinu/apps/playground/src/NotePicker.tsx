import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { folderPath, type Note, type Vault } from '../../../packages/library/src/model';
import { Dialog } from './Dialog';

/** Metadata-only lookup: opening navigation never decodes every note body. */
export function NotePicker({ vault, linking = false, onChoose, onClose }: { vault: Vault; linking?: boolean; onChoose(note: Note): void; onClose(): void }) {
	const english = vault.preferences.language === 'en-US';
	const [query, setQuery] = useState('');
	const [index, setIndex] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const id = useId();
	const entries = useMemo(() => vault.notes.filter(note => !note.deletedAt).map(note => {
		const path = folderPath(vault, note.folderId).join(' / ');
		return { note, path, title: note.title.toLocaleLowerCase(vault.preferences.language), search: [note.title, path, ...note.tags].join('\n').toLocaleLowerCase(vault.preferences.language) };
	}).sort((a, b) => b.note.updatedAt - a.note.updatedAt || a.note.id.localeCompare(b.note.id)), [vault.notes, vault.folders, vault.preferences.language]);
	const matches = useMemo(() => {
		const terms = query.trim().toLocaleLowerCase(vault.preferences.language).split(/\s+/).filter(Boolean);
		return entries.filter(entry => terms.every(term => entry.search.includes(term))).sort((a, b) => {
			const rank = (entry: typeof a) => terms.length && terms.every(term => entry.title.includes(term)) ? 1 : 0;
			return rank(b) - rank(a);
		});
	}, [entries, query, vault.preferences.language]);
	const visible = matches.slice(0, 60);
	const active = Math.min(index, Math.max(0, visible.length - 1));
	useEffect(() => { input.current?.focus(); }, []);
	useEffect(() => { list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' }); }, [active, query]);
	return <Dialog title={linking ? (english ? 'Insert note link' : '插入笔记内链') : (english ? 'Go to note' : '快速切换笔记')} onClose={onClose}>
		<label className="note-picker-search">{english ? 'Title, folder or tag' : '搜索标题、文件夹或标签'}<input ref={input} role="combobox" aria-label="快速查找笔记" aria-expanded="true" aria-controls={id} aria-autocomplete="list" aria-activedescendant={visible.length ? `${id}-${active}` : undefined} maxLength={500} value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => {
			if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (visible.length) setIndex((active + (event.key === 'ArrowDown' ? 1 : visible.length - 1)) % visible.length); }
			if (event.key === 'Enter') { event.preventDefault(); if (visible[active]) onChoose(visible[active].note); }
		}} /></label>
		<p className="note-picker-count" role="status">{matches.length} {english ? 'notes' : '篇笔记'}{matches.length > visible.length && (english ? ' · showing the first 60; narrow your search' : ' · 显示前 60 篇，请继续输入缩小范围')}</p>
		<div ref={list} id={id} role="listbox" aria-label="快速查找结果" className="note-picker-results">{visible.map((entry, item) => <button key={entry.note.id} id={`${id}-${item}`} role="option" aria-selected={active === item} tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => onChoose(entry.note)}><strong>{entry.note.title || (english ? 'Untitled note' : '无标题笔记')}</strong><small>{entry.path || (english ? 'Unfiled' : '未分类')}{entry.note.tags.length > 0 && ` · ${entry.note.tags.map(tag => `#${tag}`).join(' ')}`}</small></button>)}</div>
		{!matches.length && <p>{english ? 'No matching notes' : '没有匹配的笔记'}</p>}
	</Dialog>;
}
