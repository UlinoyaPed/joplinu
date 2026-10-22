import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { NoteDocument } from '../../../packages/document/src/index';
import { MarkdownRenderer } from '../../../packages/markdown/src/index';
import { createSourceEditor } from '../../../packages/editor/src/codemirror';
import { createRichEditor, type MathEdit } from '../../../packages/editor/src/prosemirror';
import type { Preferences, Mode } from '../../../packages/library/src/model';
import { enhancePreview } from '../../../packages/markdown/src/enhance';
import { Dialog } from './Dialog';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import 'prosemirror-view/style/prosemirror.css';
import './style.css';

const renderer = new MarkdownRenderer();
const modes: { id: Mode; label: string; hint: string }[] = [
	{ id: 'live', label: '实时预览', hint: 'CodeMirror · 光标处显示 Markdown 标记' },
	{ id: 'rich', label: '富文本', hint: 'ProseMirror · 未识别语法保留为源码块，双击可编辑' },
	{ id: 'source', label: '源码', hint: 'CodeMirror · 原始 Markdown' },
	{ id: 'split', label: '双列', hint: '源码与安全预览 · 点击预览定位原文' },
];

function useSource(note: NoteDocument) {
	return useSyncExternalStore(listener => note.onChange(listener), () => note.source);
}

function Peer({ connected, replica }: { connected: boolean; replica: NoteDocument }) {
	const host = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!host.current) return;
		const editor = createSourceEditor(host.current, replica, false);
		return () => editor.destroy();
	}, []);
	return <aside className="peer"><h2>设备 B · 独立 Y.Doc</h2><p>{connected ? '已连接：双向传递 Yjs 更新' : '已断开：可分别编辑，重新连接后合并'}</p><div ref={host} className="peer-editor" /></aside>;
}

interface EditorProps { primary: NoteDocument; preferences: Preferences; assets: Map<string, { url: string; mime: string }>; onOpenNote(id: string): void; onOpenAttachment(id: string): void; onRecovery(source: string): void; status: string }
export function Editor({ primary, preferences, assets, onOpenNote, onOpenAttachment, onRecovery, status }: EditorProps) {
	const replica = useMemo(() => { const value = new NoteDocument(); value.applyRemote(Y.encodeStateAsUpdate(primary.doc)); return value; }, [primary]);
	useEffect(() => () => replica.destroy(), [replica]);
	const source = useSource(primary);
	const [mode, setMode] = useState<Mode>(preferences.defaultMode);
	const [peer, setPeer] = useState(false);
	const [connected, setConnected] = useState(true);
	const [html, setHtml] = useState('');
	const [ratio, setRatio] = useState(50);
	const [problem, setProblem] = useState<{ message: string; draft: string }>();
	const [renderError, setRenderError] = useState('');
	const [mathEdit, setMathEdit] = useState<MathEdit>();
	const [context, setContext] = useState<{ x: number; y: number }>();
	const sourceHost = useRef<HTMLDivElement>(null);
	const richHost = useRef<HTMLDivElement>(null);
	const preview = useRef<HTMLDivElement>(null);
	const sourceEditor = useRef<ReturnType<typeof createSourceEditor> | null>(null);
	const richEditor = useRef<ReturnType<typeof createRichEditor> | null>(null);
	const scrollLock = useRef(0);
	const pendingFocus = useRef<number | undefined>(undefined);
	const [, setHistoryVersion] = useState(0);

	useEffect(() => {
		const update = () => setHistoryVersion(value => value + 1);
		primary.undo.on('stack-item-added', update);
		primary.undo.on('stack-item-popped', update);
		return () => { primary.undo.off('stack-item-added', update); primary.undo.off('stack-item-popped', update); };
	}, []);

	useEffect(() => {
		if (!connected) return;
		const forward = (target: NoteDocument) => (update: Uint8Array, origin: unknown) => { if (origin !== 'remote') target.applyRemote(update); };
		const toReplica = forward(replica);
		const toPrimary = forward(primary);
		primary.doc.on('update', toReplica);
		replica.doc.on('update', toPrimary);
		const primaryUpdate = Y.encodeStateAsUpdate(primary.doc, Y.encodeStateVector(replica.doc));
		const replicaUpdate = Y.encodeStateAsUpdate(replica.doc, Y.encodeStateVector(primary.doc));
		replica.applyRemote(primaryUpdate);
		primary.applyRemote(replicaUpdate);
		return () => { primary.doc.off('update', toReplica); replica.doc.off('update', toPrimary); };
	}, [connected, primary, replica]);

	useEffect(() => {
		if (mode !== 'split') return;
		let current = true;
		const timer = setTimeout(() => {
			renderer.render(source, { math: preferences.math }).then(result => { if (current) { setHtml(result); setRenderError(''); } }).catch(() => { if (current) { setHtml(''); setRenderError('预览生成失败；原文已保留，请切换源码视图。'); } });
		}, 90);
		return () => { current = false; clearTimeout(timer); };
	}, [source, mode, preferences.math]);

	useEffect(() => {
		primary.undo.stopCapturing();
		if (mode === 'rich' && richHost.current) {
			const editor = createRichEditor(richHost.current, primary,
				(message, draft) => setProblem({ message, draft }),
				offset => { primary.rememberSelection({ anchor: offset, head: offset }); setMode('source'); },
				{ math: preferences.math, attachment: id => assets.get(id), openNote: onOpenNote, openAttachment: onOpenAttachment, editMath: setMathEdit });
			richEditor.current = editor;
			return () => { editor.destroy(); richEditor.current = null; };
		}
		if (!sourceHost.current) return;
		const editor = createSourceEditor(sourceHost.current, primary, mode === 'live', offset => {
			if (mode !== 'split' || performance.now() < scrollLock.current || !preview.current) return;
			const elements = [...preview.current.querySelectorAll<HTMLElement>('[data-source]')];
			const target = elements.find(element => Number(element.dataset.source) >= offset) ?? elements.at(-1);
			if (target) { scrollLock.current = performance.now() + 120; preview.current.scrollTop += target.getBoundingClientRect().top - preview.current.getBoundingClientRect().top; }
		}, { features: preferences, assets, openNote: onOpenNote, openAttachment: onOpenAttachment });
		sourceEditor.current = editor;
		if (pendingFocus.current !== undefined) { editor.focusSource(pendingFocus.current); pendingFocus.current = undefined; }
		return () => { editor.destroy(); sourceEditor.current = null; };
	}, [mode, primary]);
	useEffect(() => { richEditor.current?.setResources({ math: preferences.math, attachment: id => assets.get(id), openNote: onOpenNote, openAttachment: onOpenAttachment, editMath: setMathEdit }); }, [assets, preferences.math, mode]);
	useEffect(() => {
		if (!context) return;
		const close = (event: Event) => { if (!(event.target as HTMLElement).closest('.editor-context-menu')) setContext(undefined); };
		const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setContext(undefined); };
		window.addEventListener('pointerdown', close); window.addEventListener('keydown', escape);
		return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
	}, [context]);
	useEffect(() => {
		const focus = (event: Event) => {
			if (primary.isComposing) return;
			const offset = (event as CustomEvent<number>).detail;
			if (!Number.isFinite(offset)) return;
			if (sourceEditor.current) sourceEditor.current.focusSource(offset);
			else { primary.rememberSelection({ anchor: offset, head: offset }); pendingFocus.current = offset; setMode('source'); }
		};
		window.addEventListener('joplinu-focus-source', focus); return () => window.removeEventListener('joplinu-focus-source', focus);
	}, [primary]);

	useEffect(() => {
		sourceEditor.current?.setSpellcheck(preferences.spellcheck);
		richEditor.current?.view.setProps({ attributes: { 'aria-label': '富文本编辑器', role: 'textbox', 'aria-multiline': 'true', spellcheck: String(preferences.spellcheck) } });
	}, [preferences.spellcheck, mode]);
	useEffect(() => { sourceEditor.current?.setResources({ features: preferences, assets, openNote: onOpenNote, openAttachment: onOpenAttachment }); }, [assets, preferences, mode]);
	useEffect(() => {
		if (preview.current && mode === 'split') {
			const content = preview.current.querySelector<HTMLElement>('.rendered-markdown');
			if (content) { content.innerHTML = html; return enhancePreview(content, preferences, assets); }
		}
	}, [html, preferences, assets, mode]);

	const switchMode = (next: Mode) => {
		if (primary.isComposing) return;
		setMode(next);
	};
	const commands = [['bold', '加粗'], ['italic', '斜体'], ['strike', '删除线'], ['heading', '标题'], ['paragraph', '正文'], ['list', '列表'], ['quote', '引用'], ['code', '代码块'], ['task', '插入任务'], ['table', '插入表格'], ['addRow', '增加行'], ['addColumn', '增加列'], ['deleteRow', '删除行'], ['deleteColumn', '删除列']] as const;
	const runRich = (name: typeof commands[number][0]) => {
		const editor = richEditor.current;
		if (editor) editor.command(editor[name]);
	};
	const insertMath = () => { if (primary.isComposing) return; const selection = primary.restoreSelection(); setMathEdit({ from: Math.min(selection.anchor, selection.head), to: Math.max(selection.anchor, selection.head), value: 'x^2', display: false, baseline: primary.source }); };
	return <div className="note-editor" style={{ '--editor-font-size': `${preferences.fontSize}px`, '--editor-line-height': preferences.lineHeight, '--editor-font': preferences.font === 'mono' ? "'SFMono-Regular', Consolas, monospace" : "system-ui, sans-serif" } as React.CSSProperties} onContextMenu={event => { if (mode === 'rich' && !primary.isComposing) { event.preventDefault(); setContext({ x: Math.min(event.clientX, window.innerWidth - 210), y: Math.min(event.clientY, window.innerHeight - 280) }); } }}>
			<div className="modebar"><div role="tablist" aria-label="编辑模式">{modes.map(item => <button key={item.id} role="tab" aria-selected={mode === item.id} className={mode === item.id ? 'active' : ''} onClick={() => switchMode(item.id)}>{item.label}</button>)}</div><button className={peer ? 'experiment active' : 'experiment'} onClick={() => setPeer(value => !value)}>◫ 双实例实验</button></div>
			<div className="editor-toolbar"><span>{modes.find(item => item.id === mode)?.hint}</span><div><button aria-label="撤销" disabled={!primary.undo.undoStack.length} onClick={() => primary.undo.undo()}>↶</button><button aria-label="重做" disabled={!primary.undo.redoStack.length} onClick={() => primary.undo.redo()}>↷</button></div></div>
			{mode === 'rich' && <div className="formatbar" aria-label="格式工具栏">{commands.map(([name, label]) => <button key={name} onMouseDown={event => event.preventDefault()} onClick={() => runRich(name)}>{label}</button>)}<button onMouseDown={event => event.preventDefault()} onClick={insertMath}>插入公式</button></div>}
			{problem && <div role="alert" className="problem">{problem.message} {problem.draft && <button onClick={() => onRecovery(problem.draft)}>导出恢复草稿</button>}<button onClick={() => setProblem(undefined)}>关闭</button></div>}
			<div className={peer ? 'editor-area with-peer' : 'editor-area'}>
				<div className={mode === 'split' ? 'panes split' : 'panes'} style={{ '--source-ratio': `${ratio}%` } as React.CSSProperties}>
					{mode === 'rich' ? <div key="rich" ref={richHost} className="rich-host" /> : <div key="source" ref={sourceHost} className="source-host" />}
					{mode === 'split' && <><input className="split-ratio" type="range" min="25" max="75" value={ratio} aria-label="分栏比例" onChange={event => setRatio(Number(event.target.value))} /><div ref={preview} className="preview markdown" aria-label="Markdown 预览"
						onClick={event => {
							const target = event.target as HTMLElement;
							const noteLink = target.closest<HTMLElement>('[data-note]');
							const attachment = target.closest<HTMLElement>('[data-attachment]');
							if (noteLink) { event.preventDefault(); onOpenNote(noteLink.dataset.note!); return; }
							if (attachment && attachment.tagName === 'A') { event.preventDefault(); onOpenAttachment(attachment.dataset.attachment!); return; }
							if (target.closest('audio,video')) return;
							const element = target.closest<HTMLElement>('[data-source]');
							if ((event.target as HTMLElement).closest('a')) event.preventDefault();
							if (element) sourceEditor.current?.focusSource(Number(element.dataset.source));
						}}
						onScroll={() => {
							if (performance.now() < scrollLock.current || !preview.current) return;
							const top = preview.current.getBoundingClientRect().top;
							const target = [...preview.current.querySelectorAll<HTMLElement>('[data-source]')].find(element => element.getBoundingClientRect().top >= top);
							if (target) { scrollLock.current = performance.now() + 120; sourceEditor.current?.scrollToSource(Number(target.dataset.source)); }
						}}>{renderError || <div className="rendered-markdown" dangerouslySetInnerHTML={{ __html: html }} />}</div></>}
				</div>
				{peer && <div className="peer-panel"><div className="peer-controls"><button onClick={() => setConnected(value => !value)}>{connected ? '断开连接' : '重新连接并合并'}</button><span>{connected ? '本机模拟 · 已连接' : '离线编辑中'}</span></div><Peer connected={connected} replica={replica} /></div>}
			</div>
			<footer><span><i className="status-dot" />{status}</span><span>{source.length.toLocaleString()} 字符 <b>UTF-16</b> · Markdown</span></footer>
			{context && <div role="menu" aria-label="编辑上下文菜单" className="editor-context-menu" style={{ left: Math.max(0, context.x), top: Math.max(0, context.y) }}>{commands.slice(0, 10).map(([name, label]) => <button role="menuitem" key={name} onMouseDown={event => event.preventDefault()} onClick={() => { runRich(name); setContext(undefined); }}>{label}</button>)}</div>}
			{mathEdit && <MathDialog edit={mathEdit} primary={primary} onClose={() => setMathEdit(undefined)} />}
	</div>;
}

function MathDialog({ edit, primary, onClose }: { edit: MathEdit; primary: NoteDocument; onClose(): void }) {
	const [value, setValue] = useState(edit.value);
	const [display, setDisplay] = useState(edit.display);
	const [error, setError] = useState('');
	const preview = useMemo(() => { try { return katex.renderToString(value, { displayMode: display, trust: false, throwOnError: true, maxExpand: 100, maxSize: 20 }); } catch { return ''; } }, [value, display]);
	return <Dialog title="编辑数学公式" onClose={onClose}><form onSubmit={event => { event.preventDefault();
		if (primary.isComposing) { setError('请先结束中文输入'); return; }
		if (primary.source !== edit.baseline) { setError('文档已改变，请复制公式后重新打开，原文未修改'); return; }
		const before = edit.baseline.slice(0, edit.from); const after = edit.baseline.slice(edit.to);
		const insert = display ? `${before && !before.endsWith('\n\n') ? '\n\n' : ''}$$\n${value}\n$$${after && !after.startsWith('\n\n') ? '\n\n' : ''}` : `$${value}$`;
		primary.undo.stopCapturing(); primary.edit([{ from: edit.from, to: edit.to, insert }], edit.baseline); onClose();
	}}><label className="setting-field">LaTeX 公式<textarea autoFocus rows={5} value={value} maxLength={50000} onChange={event => setValue(event.target.value)} /></label><label className="setting-toggle"><span>独立显示公式</span><input type="checkbox" checked={display} onChange={event => setDisplay(event.target.checked)} /></label>{preview ? <div className="math-dialog-preview" dangerouslySetInnerHTML={{ __html: preview }} /> : <p>公式暂时无法渲染，仍可保留源码。</p>}{error && <p role="alert">{error}</p>}<button className="primary" type="submit">保存公式</button></form></Dialog>;
}
