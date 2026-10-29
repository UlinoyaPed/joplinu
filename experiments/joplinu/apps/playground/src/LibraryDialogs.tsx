import { useState } from 'react';
import { descendants, dissolveFolder, folderPath, formatDate, moveFolder, newId, type Note, type Vault } from '../../../packages/library/src/model';
import { Dialog } from './Dialog';

export function TagManager({ vault, onClose, onRename, onRemove, run }: { vault: Vault; onClose(): void; onRename(from: string, to: string): void; onRemove(name: string): void; run(action: () => void): void }) {
	const counts = new Map<string, number>(); for (const note of vault.notes) for (const tag of new Set(note.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
	const names = [...counts.keys()].sort((a, b) => a.localeCompare(b, vault.preferences.language));
	const [selected, setSelected] = useState<string>(); const [name, setName] = useState(''); const [confirm, setConfirm] = useState(false);
	return <Dialog title="管理标签" onClose={onClose} wide><p className="hint">重命名会更新所有笔记（包括回收站）的标签；重名标签会合并。删除标签不会删除笔记或修改正文。</p><div className="history-layout"><div className="choice-list">{names.map(tag => <button key={tag} className={selected === tag ? 'selected' : ''} onClick={() => { setSelected(tag); setName(tag); setConfirm(false); }}>{tag}<small>{counts.get(tag)} 篇笔记</small></button>)}{!names.length && <p>在笔记“信息”中添加标签后，可在这里统一管理。</p>}</div>{selected && counts.has(selected) ? <section><form onSubmit={event => { event.preventDefault(); run(() => { onRename(selected, name); setSelected(name.trim()); setConfirm(false); }); }}><label className="setting-field">标签名称<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label><div className="button-row"><button className="primary" type="submit" disabled={!name.trim()}>重命名标签</button><button className="danger" type="button" onClick={() => setConfirm(true)}>删除标签</button></div></form>{confirm && <div className="folder-removal"><p>将从 {counts.get(selected)} 篇笔记移除“{selected}”标签。笔记内容和历史保留。</p><button className="danger" onClick={() => run(() => { onRemove(selected); setSelected(undefined); setName(''); setConfirm(false); })}>确认删除标签</button></div>}</section> : <p>选择一个标签进行管理。</p>}</div></Dialog>;
}

export function FolderDialog({ vault, id, defaultParent, onClose, onSave, run }: { vault: Vault; id: string | undefined; defaultParent: string | null; onClose(): void; onSave(vault: Vault): void; run(action: () => void): void }) {
	const existing = vault.folders.find(folder => folder.id === id);
	const [name, setName] = useState(existing?.name ?? '');
	const [removing, setRemoving] = useState(false);
	const [confirmation, setConfirmation] = useState('');
	const [parentId, setParentId] = useState<string | null>(existing ? existing.parentId : defaultParent);
	const blocked = id ? descendants(vault, id) : new Set<string>();
	const empty = existing && !vault.notes.some(note => note.folderId === id) && !vault.folders.some(folder => folder.parentId === id);
	return <Dialog title={existing ? '管理文件夹' : '新建文件夹'} onClose={onClose}><form onSubmit={event => { event.preventDefault(); run(() => {
		if (!name.trim()) throw new Error('请输入文件夹名称');
		if (vault.folders.some(folder => folder.id !== id && folder.parentId === parentId && folder.name === name.trim())) throw new Error('同级目录已经存在此名称');
		if (existing) { const moved = moveFolder(vault, existing.id, parentId); onSave({ ...moved, folders: moved.folders.map(folder => folder.id === id ? { ...folder, name: name.trim() } : folder) }); }
		else onSave({ ...vault, folders: [...vault.folders, { id: newId(), parentId, name: name.trim(), createdAt: Date.now() }] });
	}); }}><label className="setting-field">文件夹名称<input required autoFocus maxLength={200} value={name} onChange={event => setName(event.target.value)} /></label><label className="setting-field">上级文件夹<select value={parentId ?? ''} onChange={event => setParentId(event.target.value || null)}><option value="">根目录</option>{vault.folders.filter(folder => !blocked.has(folder.id)).map(folder => <option key={folder.id} value={folder.id}>{folderPath(vault, folder.id).join(' / ')}</option>)}</select></label><div className="button-row"><button type="submit" className="primary">保存文件夹</button>{existing && <button type="button" className="danger" onClick={() => setRemoving(true)}>{empty ? '删除空文件夹' : '移除文件夹'}</button>}</div>{existing && removing && <section className="folder-removal"><p>仅移除“{existing.name}”这一层。笔记（包括回收站笔记）和直接子文件夹将移至{existing.parentId ? '上级文件夹' : '根目录'}，正文、附件与历史会保留。此操作不会删除笔记。</p><label className="setting-field">输入文件夹名称确认<input value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><button type="button" className="danger" disabled={confirmation !== existing.name} onClick={() => run(() => onSave(dissolveFolder(vault, existing.id)))}>确认移除文件夹</button></section>}</form></Dialog>;
}

export function MetadataDialog({ note, vault, onClose, onSave }: { note: Note; vault: Vault; onClose(): void; onSave(fields: Partial<Note>): void }) {
	const [tags, setTags] = useState(note.tags.join(', '));
	const [latitude, setLatitude] = useState(note.location ? String(note.location.latitude) : '');
	const [longitude, setLongitude] = useState(note.location ? String(note.location.longitude) : '');
	const [error, setError] = useState('');
	return <Dialog title="笔记信息" onClose={onClose}><form onSubmit={event => { event.preventDefault();
		const location = latitude.trim() || longitude.trim() ? { latitude: Number(latitude), longitude: Number(longitude) } : null;
		if (location && (!latitude.trim() || !longitude.trim() || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude) || Math.abs(location.latitude) > 90 || Math.abs(location.longitude) > 180)) { setError('请输入有效的经纬度，或同时清空两项'); return; }
		onSave({ tags: [...new Set(tags.split(/[,，]/).map(tag => tag.trim().slice(0, 100)).filter(Boolean))].slice(0, 100), location });
	}}><p>创建：{formatDate(note.createdAt, vault.preferences)}</p><p>修改：{formatDate(note.updatedAt, vault.preferences)}</p><label className="setting-field">标签（逗号分隔）<input value={tags} maxLength={2000} onChange={event => setTags(event.target.value)} /></label><h4>手动地理位置</h4><label className="setting-field">纬度<input type="number" step="any" min="-90" max="90" value={latitude} onChange={event => setLatitude(event.target.value)} /></label><label className="setting-field">经度<input type="number" step="any" min="-180" max="180" value={longitude} onChange={event => setLongitude(event.target.value)} /></label><button type="button" onClick={() => { setLatitude(''); setLongitude(''); }}>清除位置</button>{error && <p role="alert">{error}</p>}<button type="submit" className="primary">保存信息</button></form></Dialog>;
}

export function FolderTree({ vault, selected, onSelect, onManage, onDrop }: { vault: Vault; selected: string | null; onSelect(id: string): void; onManage(id: string): void; onDrop(event: React.DragEvent, id: string): void }) {
	const [collapsed, setCollapsed] = useState(new Set<string>());
	const render = (parentId: string | null, level = 0): React.ReactNode => vault.folders.filter(folder => folder.parentId === parentId).sort((a, b) => vault.preferences.folderSort === 'name' ? a.name.localeCompare(b.name, vault.preferences.language) : a.createdAt - b.createdAt).map(folder => {
		const child = vault.folders.some(item => item.parentId === folder.id);
		return <div key={folder.id} role="treeitem" aria-expanded={child ? !collapsed.has(folder.id) : undefined}>
			<div className={`folder-row ${selected === folder.id ? 'selected' : ''}`} style={{ paddingLeft: 8 + Math.min(level, 8) * 14 }} draggable onDragStart={event => event.dataTransfer.setData('application/x-joplinu-folder', folder.id)} onDragOver={event => event.preventDefault()} onDrop={event => onDrop(event, folder.id)}>
				<button className="folder-toggle" aria-label={`${collapsed.has(folder.id) ? '展开' : '折叠'} ${folder.name}`} disabled={!child} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); return next; })}>{child ? collapsed.has(folder.id) ? '▸' : '▾' : '·'}</button>
				<button className="folder-name" onClick={() => onSelect(folder.id)}>▱ <span>{folder.name}</span><small>{vault.notes.filter(note => note.folderId === folder.id && !note.deletedAt).length}</small></button>
				<button aria-label={`管理文件夹 ${folder.name}`} onClick={() => onManage(folder.id)}>⋯</button>
			</div>{!collapsed.has(folder.id) && child && <div role="group">{render(folder.id, level + 1)}</div>}
		</div>;
	});
	return <div className="folder-tree" role="tree" aria-label="文件夹树">{render(null)}</div>;
}
