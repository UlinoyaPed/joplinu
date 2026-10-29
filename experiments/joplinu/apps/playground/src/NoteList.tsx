import { useRef, useState, type RefObject, type ReactNode } from 'react';
import { formatDate, type Note, type Preferences } from '../../../packages/library/src/model';

interface Props {
	notes: Note[]; selectedId: string | undefined; title: string; preferences: Preferences;
	query: string; searchRef: RefObject<HTMLInputElement | null>; onQuery(value: string): void;
	checked: Set<string>; onChecked(value: Set<string>): void;
	onSelect(note: Note): void; onCreate(): void; onCreateTodo(): void; onToggleTodo(note: Note): void; onMenu(note: Note): void; onNavigation(): void;
	onMove(ids: string[]): void; onTrash(ids: string[], deleted: boolean): void; onEmptyTrash(): void;
	onSort(value: Preferences['sort']): void; trash: boolean;
	feedback: ReactNode; onReturn(): void;
}

export function NoteList(props: Props) {
	const { notes, selectedId, title, preferences: p, query, searchRef, checked, trash } = props;
	const [selecting, setSelecting] = useState(false);
	const anchor = useRef<string | undefined>(undefined);
	const ids = notes.filter(note => checked.has(note.id)).map(note => note.id);
	const toggle = (id: string, range = false) => {
		const next = new Set(checked);
		const start = notes.findIndex(note => note.id === anchor.current); const end = notes.findIndex(note => note.id === id);
		if (range && start >= 0 && end >= 0) for (let i = Math.min(start, end); i <= Math.max(start, end); i++) next.add(notes[i]!.id);
		else if (next.has(id)) next.delete(id); else next.add(id);
		anchor.current = id; props.onChecked(next);
	};
	return <section className="note-list-pane" aria-label="笔记列表面板">
		<header className="note-list-header"><button className="mobile-navigation" aria-label="从列表打开笔记导航" onClick={props.onNavigation}>☰</button><h2 title={title}>{title}</h2><span>{notes.length}</span>{selectedId && <button className="mobile-list-back" aria-label="返回当前笔记" onClick={props.onReturn}>→</button>}<button aria-label="新建待办" title="新建待办笔记" onClick={props.onCreateTodo}>☑</button><button className="new-note-button" aria-label="在当前列表新建笔记" title="新建笔记 · Ctrl/Cmd+N" onClick={props.onCreate}>＋</button></header>
		<div className="note-search"><input ref={searchRef} className="library-search" type="search" maxLength={4000} aria-label="搜索笔记" placeholder={p.language === 'en-US' ? 'Search notes…' : '搜索全部笔记…'} value={query} onChange={event => props.onQuery(event.target.value)} /></div>
		<details className="search-help"><summary>搜索语法</summary><p>空格组合条件，双引号搜索短语，减号排除。<br /><code>title:计划 tag:重要 -body:取消</code><br /><code>type:todo is:uncompleted</code><br /><code>notebook:"我的笔记" is:pinned</code><br /><code>any:1 咖啡 茶 -tag:归档</code></p></details>
		<div className="note-list-tools"><select aria-label="列表排序" value={p.sort} onChange={event => props.onSort(event.target.value as Preferences['sort'])}><option value="updated">最近修改</option><option value="title">标题 A–Z</option></select><button aria-pressed={selecting} onClick={() => { setSelecting(value => !value); props.onChecked(new Set()); }}>批量选择</button></div>
		{selecting && <div className="bulk-actions" aria-label="批量笔记操作"><label><input type="checkbox" aria-label="全选当前列表" checked={!!notes.length && ids.length === notes.length} onChange={event => props.onChecked(event.target.checked ? new Set(notes.map(note => note.id)) : new Set())} />{ids.length} 篇</label><button disabled={!ids.length} onClick={() => props.onMove(ids)}>移动所选</button><button disabled={!ids.length} onClick={() => props.onTrash(ids, !trash)}>{trash ? '恢复所选' : '回收所选'}</button></div>}
		<div className="list-feedback">{props.feedback}</div>
		<div className="note-list" aria-label="笔记列表">{notes.length ? notes.map(note => <div className={`note-row ${selectedId === note.id ? 'current' : ''}`} key={note.id}>
			{selecting && <label className="note-check-hit"><input className="note-checkbox" type="checkbox" aria-label={`选择笔记 ${note.title || '无标题笔记'}`} checked={checked.has(note.id)} onChange={() => toggle(note.id)} /></label>}
			{note.kind === 'todo' && <label className="note-check-hit"><input className="note-checkbox" type="checkbox" disabled={trash} aria-label={`完成待办 ${note.title || '无标题笔记'}`} checked={note.completedAt !== null} onChange={() => props.onToggleTodo(note)} /></label>}
			<button className={selectedId === note.id ? 'note-item selected' : 'note-item'} aria-current={selectedId === note.id ? 'true' : undefined} draggable={!trash} onDragStart={event => event.dataTransfer.setData('application/x-joplinu-note', note.id)} onClick={event => {
				if (event.ctrlKey || event.metaKey || (event.shiftKey && selecting)) { setSelecting(true); toggle(note.id, event.shiftKey); } else props.onSelect(note);
			}} onContextMenu={event => { event.preventDefault(); props.onMenu(note); }}><strong className={note.completedAt !== null ? 'todo-completed' : ''}>{note.pinned && <span className="pin-indicator" aria-label="已置顶">★ </span>}{note.title || '无标题笔记'}</strong><time>{formatDate(note.updatedAt, p)}</time>{note.tags.length > 0 && <span>{note.tags.map(tag => `#${tag}`).join(' ')}</span>}</button>
			<button className="note-more" aria-label={`笔记操作 ${note.title || '无标题笔记'}`} onClick={() => props.onMenu(note)}>⋯</button>
		</div>) : <p className="empty-list">{query ? '没有匹配的笔记' : '此处还没有笔记'}</p>}</div>
		{trash && <button className="empty-trash-button danger" disabled={!notes.length} onClick={props.onEmptyTrash}>清空回收站</button>}
	</section>;
}
