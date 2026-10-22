import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';
import { NoteDocument, minimalEdit } from '../../../packages/document/src/index';
import { MarkdownRenderer } from '../../../packages/markdown/src/index';
import { createSourceEditor } from '../../../packages/editor/src/codemirror';
import { createRichEditor } from '../../../packages/editor/src/prosemirror';
import { sample } from './sample';
import { exportMarkdown } from '../../../packages/platform/src/export';
import 'katex/dist/katex.min.css';
import 'prosemirror-view/style/prosemirror.css';
import './style.css';

const primary = new NoteDocument(sample);
const replica = new NoteDocument();
replica.applyRemote(Y.encodeStateAsUpdate(primary.doc));
const renderer = new MarkdownRenderer();
type Mode = 'live' | 'rich' | 'source' | 'split';
const modes: { id: Mode; label: string; hint: string }[] = [
	{ id: 'live', label: '实时预览', hint: 'CodeMirror · 光标处显示 Markdown 标记' },
	{ id: 'rich', label: '富文本', hint: 'ProseMirror · 未识别语法保留为源码块，双击可编辑' },
	{ id: 'source', label: '源码', hint: 'CodeMirror · 原始 Markdown' },
	{ id: 'split', label: '双列', hint: '源码与安全预览 · 点击预览定位原文' },
];

function useSource(note: NoteDocument) {
	return useSyncExternalStore(listener => note.onChange(listener), () => note.source);
}

function Peer({ connected }: { connected: boolean }) {
	const host = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!host.current) return;
		const editor = createSourceEditor(host.current, replica, false);
		return () => editor.destroy();
	}, []);
	return <aside className="peer"><h2>设备 B · 独立 Y.Doc</h2><p>{connected ? '已连接：双向传递 Yjs 更新' : '已断开：可分别编辑，重新连接后合并'}</p><div ref={host} className="peer-editor" /></aside>;
}

function App() {
	const source = useSource(primary);
	const [mode, setMode] = useState<Mode>('live');
	const [peer, setPeer] = useState(false);
	const [connected, setConnected] = useState(true);
	const [html, setHtml] = useState('');
	const [ratio, setRatio] = useState(50);
	const [problem, setProblem] = useState<{ message: string; draft: string }>();
	const [renderError, setRenderError] = useState('');
	const sourceHost = useRef<HTMLDivElement>(null);
	const richHost = useRef<HTMLDivElement>(null);
	const preview = useRef<HTMLDivElement>(null);
	const sourceEditor = useRef<ReturnType<typeof createSourceEditor> | null>(null);
	const richEditor = useRef<ReturnType<typeof createRichEditor> | null>(null);
	const importInput = useRef<HTMLInputElement>(null);
	const scrollLock = useRef(0);
	const importGeneration = useRef(0);
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
	}, [connected]);

	useEffect(() => {
		if (mode !== 'split') return;
		let current = true;
		const timer = setTimeout(() => {
			renderer.render(source).then(result => { if (current) { setHtml(result); setRenderError(''); } }).catch(() => { if (current) { setHtml(''); setRenderError('预览生成失败；原文已保留，请切换源码视图。'); } });
		}, 90);
		return () => { current = false; clearTimeout(timer); };
	}, [source, mode]);

	useEffect(() => {
		primary.undo.stopCapturing();
		if (mode === 'rich' && richHost.current) {
			const editor = createRichEditor(richHost.current, primary,
				(message, draft) => setProblem({ message, draft }),
				offset => { primary.rememberSelection({ anchor: offset, head: offset }); setMode('source'); });
			richEditor.current = editor;
			return () => { editor.destroy(); richEditor.current = null; };
		}
		if (!sourceHost.current) return;
		const editor = createSourceEditor(sourceHost.current, primary, mode === 'live', offset => {
			if (mode !== 'split' || performance.now() < scrollLock.current || !preview.current) return;
			const elements = [...preview.current.querySelectorAll<HTMLElement>('[data-source]')];
			const target = elements.find(element => Number(element.dataset.source) >= offset) ?? elements.at(-1);
			if (target) { scrollLock.current = performance.now() + 120; preview.current.scrollTop += target.getBoundingClientRect().top - preview.current.getBoundingClientRect().top; }
		});
		sourceEditor.current = editor;
		return () => { editor.destroy(); sourceEditor.current = null; };
	}, [mode]);

	const download = (text: string, filename: string) => {
		void exportMarkdown(text, filename).catch(() => setProblem({ message: '导出失败；当前原文仍在，请重试。', draft: text }));
	};

	const switchMode = (next: Mode) => {
		if (primary.isComposing) return;
		setMode(next);
	};
	const runRich = (name: 'bold' | 'italic' | 'heading' | 'paragraph' | 'list' | 'quote') => {
		const editor = richEditor.current;
		if (editor) editor.command(editor[name]);
	};
	const importMarkdown = async (file: File | undefined) => {
		if (!file) return;
		if (file.size > 2 * 1024 * 1024) { setProblem({ message: '原型导入上限为 2 MiB。当前文档未修改。', draft: '' }); return; }
		const generation = ++importGeneration.current;
		const baseline = primary.source;
		try {
			const value = await file.text();
			if (generation !== importGeneration.current) return;
			if (primary.source !== baseline) { setProblem({ message: '读取文件期间文档已改变，请重新导入。当前文档未修改。', draft: value }); return; }
			if (primary.isComposing) { setProblem({ message: '请结束输入法组合输入后重新导入。当前文档未修改。', draft: value }); return; }
			const edit = minimalEdit(primary.source, value);
			primary.undo.stopCapturing();
			if (edit) primary.edit([edit], baseline);
			primary.rememberSelection({ anchor: 0, head: 0 });
		} catch { setProblem({ message: '文件读取失败；当前文档未修改。', draft: '' }); }
		if (importInput.current) importInput.current.value = '';
	};

	return <div className="app-shell">
		<aside className="sidebar">
			<a className="brand" href="#"><span className="brand-icon">U</span>Joplin<span>U</span></a>
			<div className="workspace-label">个人空间 <span>本地实验</span></div>
			<div className="nav-label">笔记本</div>
			<div className="notebook selected">▤ <span>编辑器验证</span><small>1</small></div>
			<div className="note-card"><span className="note-tag">技术原型 / 阶段 1</span><strong>一份文档，四种视图</strong><p>验证原文保真、局部编辑与并发合并。</p><span>Markdown · Yjs</span></div>
			<div className="sidebar-bottom"><span className="status-dot" />完全本地运行<p>尚未接入数据库或云同步</p></div>
		</aside>
		<main>
			<header className="topbar"><div>编辑器验证 <span>/</span> 概念验证</div><div className="top-actions"><button onClick={() => importInput.current?.click()}>导入</button><button onClick={() => download(source, 'JoplinU.md')}>导出 Markdown ↗</button></div></header>
			<input ref={importInput} type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" aria-label="导入 Markdown" hidden onChange={event => void importMarkdown(event.target.files?.[0])} />
			<div className="document-heading"><div className="eyebrow">JOPLINU / EDITOR LAB</div><h1>让思考，自由发生。</h1><p>离线优先的 Markdown 编辑体验 · 文档模型技术验证</p></div>
			<div className="modebar"><div role="tablist" aria-label="编辑模式">{modes.map(item => <button key={item.id} role="tab" aria-selected={mode === item.id} className={mode === item.id ? 'active' : ''} onClick={() => switchMode(item.id)}>{item.label}</button>)}</div><button className={peer ? 'experiment active' : 'experiment'} onClick={() => setPeer(value => !value)}>◫ 双实例实验</button></div>
			<div className="editor-toolbar"><span>{modes.find(item => item.id === mode)?.hint}</span><div><button aria-label="撤销" disabled={!primary.undo.undoStack.length} onClick={() => primary.undo.undo()}>↶</button><button aria-label="重做" disabled={!primary.undo.redoStack.length} onClick={() => primary.undo.redo()}>↷</button></div></div>
			{mode === 'rich' && <div className="formatbar" aria-label="格式工具栏">{([['bold', '加粗'], ['italic', '斜体'], ['heading', '标题'], ['paragraph', '正文'], ['list', '列表'], ['quote', '引用']] as const).map(([name, label]) => <button key={name} onMouseDown={event => event.preventDefault()} onClick={() => runRich(name)}>{label}</button>)}<span>公式、扩展语法双击后使用源码编辑</span></div>}
			{problem && <div role="alert" className="problem">{problem.message} {problem.draft && <button onClick={() => download(problem.draft, 'JoplinU-recovery.md')}>导出恢复草稿</button>}<button onClick={() => setProblem(undefined)}>关闭</button></div>}
			<div className={peer ? 'editor-area with-peer' : 'editor-area'}>
				<div className={mode === 'split' ? 'panes split' : 'panes'} style={{ '--source-ratio': `${ratio}%` } as React.CSSProperties}>
					{mode === 'rich' ? <div key="rich" ref={richHost} className="rich-host" /> : <div key="source" ref={sourceHost} className="source-host" />}
					{mode === 'split' && <><input className="split-ratio" type="range" min="25" max="75" value={ratio} aria-label="分栏比例" onChange={event => setRatio(Number(event.target.value))} /><div ref={preview} className="preview markdown" aria-label="Markdown 预览"
						onClick={event => {
							const element = (event.target as HTMLElement).closest<HTMLElement>('[data-source]');
							if ((event.target as HTMLElement).closest('a')) event.preventDefault();
							if (element) sourceEditor.current?.focusSource(Number(element.dataset.source));
						}}
						onScroll={() => {
							if (performance.now() < scrollLock.current || !preview.current) return;
							const top = preview.current.getBoundingClientRect().top;
							const target = [...preview.current.querySelectorAll<HTMLElement>('[data-source]')].find(element => element.getBoundingClientRect().top >= top);
							if (target) { scrollLock.current = performance.now() + 120; sourceEditor.current?.scrollToSource(Number(target.dataset.source)); }
						}}>{renderError || <div dangerouslySetInnerHTML={{ __html: html }} />}</div></>}
				</div>
				{peer && <div className="peer-panel"><div className="peer-controls"><button onClick={() => setConnected(value => !value)}>{connected ? '断开连接' : '重新连接并合并'}</button><span>{connected ? '本机模拟 · 已连接' : '离线编辑中'}</span></div><Peer connected={connected} /></div>}
			</div>
			<footer><span><i className="status-dot" />会话内存 · 未持久化，请导出保存</span><span>{source.length.toLocaleString()} 字符 <b>UTF-16</b> · Markdown</span></footer>
		</main>
	</div>;
}

createRoot(document.getElementById('root')!).render(<App />);
