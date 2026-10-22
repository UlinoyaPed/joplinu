export const sample = `# JoplinU 编辑器实验室

一份 Markdown，四种编辑方式。试试 **加粗**、*斜体* 与 ~~删除线~~，再切换视图。

## 离线，也能继续思考

这是一份运行在内存中的技术原型。请使用「导出 Markdown」保存实验内容，刷新页面会恢复示例。

> 先验证数据不丢失，再设计同步。

- [x] 共享 Y.Text 文档
- [ ] Android 中文输入法真机验证
- [ ] SQLite 崩溃恢复

| 视图 | 编辑方式 |
| --- | --- |
| 实时预览 | CodeMirror Decorations |
| 富文本 | ProseMirror 局部补丁 |

行内公式 $E = mc^2$，以及：

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

\`\`\`typescript
const principle = '先保护数据';
\`\`\`

![离线附件](attachment:example-image)

:::custom-extension
未知语法保持原样；富文本视图中双击此区域可进入源码。
:::
`;
