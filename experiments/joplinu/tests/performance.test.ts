import { expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { projectMarkdown, planRichEdits } from '../packages/editor/src/rich-model';

it.each([100 * 1024, 1024 * 1024])('records projection and local-patch cost for %i bytes', bytes => {
	const paragraph = '中文与 Markdown **加粗**，一份保持原文的笔记。'.repeat(4);
	const section = `## 性能样本\n\n${paragraph}\n\n`;
	const source = section.repeat(Math.ceil(bytes / Buffer.byteLength(section)));
	const start = performance.now();
	const projection = projectMarkdown(source);
	const projectionMs = performance.now() - start;
	const state = EditorState.create({ doc: projection.doc });
	const next = state.apply(state.tr.insertText('新', 2));
	const patchStart = performance.now();
	const edits = planRichEdits(projection, next.doc);
	const patchMs = performance.now() - patchStart;
	expect(edits).toEqual([{ from: 4, to: 4, insert: '新' }]);
	console.info(JSON.stringify({ bytes: Buffer.byteLength(source), blocks: projection.blocks.length, projectionMs: Math.round(projectionMs), patchMs: Math.round(patchMs) }));
}, 30_000);
