import { useState } from 'react';
import type { LibraryController } from '../../../packages/library/src/controller';
import { formatDate, validatePreferences, type Preferences } from '../../../packages/library/src/model';
import { checkVault } from '../../../packages/library/src/transfer';
import { Dialog } from './Dialog';

const sections = [
	['general', '☷', '常规', 'General', '语言与日期格式设置'],
	['appearance', '◐', '外观', 'Appearance', '主题、笔记与文件夹排序'],
	['sync', '⟳', '同步', 'Synchronization', '本地状态、云同步与加密状态'],
	['editor', '✎', '编辑器', 'Editor', '字体、拼写检查与编辑布局'],
	['markdown', 'M↓', 'Markdown', 'Markdown', '媒体播放器、数学公式、流程图、目录'],
	['notes', '▣', '笔记', 'Notes', '地理位置与图片缩放'],
	['history', '◴', '笔记历史', 'Note history', '保留版本与恢复规则'],
	['tools', '⚒', '工具', 'Tools', '日志、配置档案、完整性检查'],
	['transfer', '⇄', '导入和导出', 'Import and export', 'Markdown 文件夹、完整备份与恢复'],
] as const;
type Section = typeof sections[number][0];
export type ExportKind = 'backup' | 'encrypted' | 'directory' | 'settings' | 'logs';
export type ImportKind = 'markdown' | 'directory' | 'archive' | 'backup' | 'settings';

interface Props {
	controller: LibraryController;
	onClose(): void;
	onExport(kind: ExportKind, password?: string): Promise<void>;
	onImport(kind: ImportKind, password?: string, applyPreferences?: boolean): void;
	onManageAttachments(): void;
	run(action: () => void | Promise<void>): void;
}
export function Settings({ controller, onClose, onExport, onImport, onManageAttachments, run }: Props) {
	const [section, setSection] = useState<Section>();
	const [search, setSearch] = useState('');
	const [password, setPassword] = useState('');
	const [applyPreferences, setApplyPreferences] = useState(false);
	const [result, setResult] = useState('');
	const [busy, setBusy] = useState(false);
	const p = controller.vault.preferences;
	const english = p.language === 'en-US';
	const update = (change: Partial<Preferences>) => run(() => {
		controller.change({ ...controller.vault, preferences: validatePreferences({ ...controller.vault.preferences, ...change }) });
	});
	const toggle = (key: 'spellcheck' | 'math' | 'diagrams' | 'highlight' | 'toc' | 'media' | 'history', label: string, hint?: string) => <label className="setting-toggle"><span>{label}{hint && <small>{hint}</small>}</span><input type="checkbox" checked={p[key]} onChange={event => update({ [key]: event.target.checked })} /></label>;
	const exporting = (kind: ExportKind) => run(async () => { setBusy(true); try { await onExport(kind, password); if (kind === 'encrypted') setPassword(''); } finally { setBusy(false); } });
	const current = sections.find(item => item[0] === section);
	return <Dialog title={english ? 'Settings' : '设置'} onClose={onClose} wide>
		<div className="settings-layout">
			<nav className={section ? 'settings-nav has-selection' : 'settings-nav'} aria-label="设置分类">
				<input type="search" aria-label="搜索设置" placeholder={english ? 'Search settings' : '搜索设置'} value={search} onChange={event => setSearch(event.target.value)} />
				{sections.filter(item => item.join(' ').toLowerCase().includes(search.toLowerCase())).map(item => <button className={section === item[0] ? 'selected' : ''} key={item[0]} onClick={() => setSection(item[0])}><b aria-hidden="true">{item[1]}</b><span>{english ? item[3] : item[2]}<small>{item[4]}</small></span><span aria-hidden="true">›</span></button>)}
			</nav>
			{section ? <section className="settings-detail"><button className="settings-back" onClick={() => setSection(undefined)}>← {english ? 'All settings' : '全部设置'}</button><h3>{english ? current?.[3] : current?.[2]}</h3>
				{section === 'general' && <>
					<label className="setting-field">界面与日期语言 / Language<select value={p.language} onChange={event => update({ language: event.target.value as Preferences['language'] })}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></label>
					<p className="hint">主导航与设置分类支持双语；开发阶段的详细说明仍使用中文。</p>
					<label className="setting-field">日期格式<select value={p.dateFormat} onChange={event => update({ dateFormat: event.target.value as Preferences['dateFormat'] })}><option value="locale">本地格式</option><option value="iso">ISO · UTC</option></select></label><p className="hint">示例：{formatDate(Date.now(), p)}</p>
				</>}
				{section === 'appearance' && <>
					<label className="setting-field">主题<select value={p.theme} onChange={event => update({ theme: event.target.value as Preferences['theme'] })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
					<label className="setting-field">笔记排序<select value={p.sort} onChange={event => update({ sort: event.target.value as Preferences['sort'] })}><option value="updated">最近修改优先</option><option value="title">按标题</option></select></label>
					<label className="setting-field">文件夹排序<select value={p.folderSort} onChange={event => update({ folderSort: event.target.value as Preferences['folderSort'] })}><option value="name">按名称</option><option value="created">按创建时间</option></select></label>
				</>}
				{section === 'sync' && <>
					<div className="status-card"><strong>本地存储 · {controller.storage.kind}</strong><p>{controller.status === 'saved' ? '当前修改已保存到本机' : controller.status === 'error' ? '本地保存失败，请导出备份' : '正在保存本地修改'}</p><p>云端：未连接，没有上传任何笔记。</p></div>
					<p>OSS / S3 增量同步、同步密钥轮换与代理接入尚未启用。统一文档模型的 Android 中文输入与并发验收仍在进行。</p>
					<p>现在可以使用密码加密的完整备份传输笔记，恢复时会保留本机已有资料。</p><button className="primary" onClick={() => setSection('transfer')}>打开加密备份与恢复</button>
				</>}
				{section === 'editor' && <>
					<label className="setting-field">默认编辑模式<select value={p.defaultMode} onChange={event => update({ defaultMode: event.target.value as Preferences['defaultMode'] })}><option value="live">实时预览</option><option value="rich">富文本</option><option value="source">源码</option><option value="split">双列</option></select></label><p className="hint">在下次打开笔记时应用。</p>
					<label className="setting-field">编辑字号 · {p.fontSize}px<input type="range" min="12" max="32" value={p.fontSize} onChange={event => update({ fontSize: Number(event.target.value) })} /></label>
					<label className="setting-field">行高 · {p.lineHeight}<input type="range" min="1.2" max="3" step="0.1" value={p.lineHeight} onChange={event => update({ lineHeight: Number(event.target.value) })} /></label>
					<label className="setting-field">编辑字体<select value={p.font} onChange={event => update({ font: event.target.value as Preferences['font'] })}><option value="mono">等宽字体</option><option value="sans">系统无衬线字体</option></select></label>
					{toggle('spellcheck', '拼写检查', '由当前系统 / WebView 提供词典；不会上传笔记。')}
				</>}
				{section === 'markdown' && <>
					<p className="hint">渲染设置应用于双列预览；原始 Markdown 始终保留。</p>
					{toggle('math', '数学公式 · KaTeX')}{toggle('diagrams', '流程图 · Mermaid')}{toggle('highlight', '代码高亮 · Shiki')}{toggle('toc', '标题目录')}{toggle('media', '本地音频 / 视频播放器')}
					<p className="hint">外部图片和远程媒体默认不加载。导入附件后可在预览中离线显示，不需要云端地址。</p>
				</>}
				{section === 'notes' && <>
					<label className="setting-field">导入图片最大宽度<select value={p.imageMaxWidth} onChange={event => update({ imageMaxWidth: Number(event.target.value) })}>{[0, 1024, 1600, 2048, 4096].map(size => <option key={size} value={size}>{size ? `${size}px` : '保留原图'}</option>)}</select></label>
					<p className="hint">只缩小新导入的 JPEG / PNG / WebP；不重写已有附件，GIF 保留动画。</p>
					<h4>地理位置</h4><p>在笔记的“信息”中填写或清除经纬度。不会自动获取或记录位置。</p>
					<button className="primary" onClick={onManageAttachments}>管理本地附件（{controller.vault.attachments.length}）</button>
				</>}
				{section === 'history' && <>
					{toggle('history', '自动保留笔记历史', '每分钟记录编辑前版本；恢复前始终建立安全快照。')}
					<label className="setting-field">历史保留时间<select value={p.historyDays} onChange={event => update({ historyDays: Number(event.target.value) })}>{[7, 30, 90, 180, 365, 3650].map(days => <option key={days} value={days}>{days} 天</option>)}</select></label>
					<p>每篇最多保留 1000 个版本。下一次创建版本时清理超期历史；关闭自动历史不会删除已有版本。完整备份包括历史和回收站。</p>
				</>}
				{section === 'tools' && <>
					<div className="button-row"><button className="primary" disabled={busy} onClick={() => run(async () => { setBusy(true); try { const database = await controller.storage.check(); if (database !== 'ok' && controller.storage.kind === 'SQLite') throw new Error('SQLite 完整性检查失败'); setResult(await checkVault(controller.vault)); controller.log('本地完整性检查通过'); } finally { setBusy(false); } })}>完整性检查</button><button onClick={() => run(async () => { await controller.flush(); setResult(controller.status === 'saved' ? '本地保存完成' : controller.error); })}>重试本地保存</button></div>
					{result && <p role="status">{result}</p>}
					<div className="button-row"><button onClick={() => exporting('settings')}>导出配置档案</button><button onClick={() => onImport('settings')}>导入配置档案</button><button onClick={() => exporting('logs')}>导出操作日志</button></div>
					<h4>操作日志</h4><p className="hint">只记录操作类型和结果，不记录正文、文件内容或密码。</p>
					<div className="log-list">{controller.vault.logs.length ? controller.vault.logs.map((log, index) => <p key={`${log.at}-${index}`}><time>{formatDate(log.at, p)}</time> {log.message}</p>) : <p>暂无操作日志</p>}</div>
				</>}
				{section === 'transfer' && <>
					<h4>Markdown 与文件夹</h4><div className="button-row"><button onClick={() => onImport('markdown')}>导入 Markdown 文件</button><button onClick={() => onImport('directory')}>导入文件夹</button><button onClick={() => onImport('archive')}>导入 ZIP 目录</button><button disabled={busy} onClick={() => exporting('directory')}>导出文件夹 ZIP</button></div>
					<p className="hint">系统不支持文件夹选择时，请使用 ZIP。JoplinU ZIP 包含原文、附件及完整资料清单（含历史和回收站），按明文备份保管。</p>
					<h4>完整备份与恢复</h4><p>包括目录、标签、附件、回收站、历史、CRDT 状态和设置。恢复到新增目录，不覆盖已有笔记。</p>
					<label className="setting-field">备份密码（仅本次使用）<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="加密导出至少 12 个字符；加密恢复请输入原密码" /></label>
					<div className="button-row"><button className="primary" disabled={busy || password.length < 12} onClick={() => exporting('encrypted')}>导出加密备份</button><button disabled={busy} onClick={() => exporting('backup')}>导出明文备份</button><button disabled={busy} onClick={() => { onImport('backup', password, applyPreferences); setPassword(''); }}>恢复备份</button></div>
					<label className="setting-toggle"><span>恢复时同时应用备份内的设置</span><input type="checkbox" checked={applyPreferences} onChange={event => setApplyPreferences(event.target.checked)} /></label>
					<p className="hint">加密备份使用 AES-256-GCM 与 PBKDF2-SHA256。忘记密码无法恢复。它是独立备份，不代表云同步已启用。</p>
				</>}
			</section> : <section className="settings-placeholder"><span className="brand-icon">U</span><h3>{english ? 'Make room for your notes' : '让笔记适合你的习惯'}</h3><p>设置自动保存在本机，切换设备可通过备份恢复。</p></section>}
		</div>
	</Dialog>;
}
