# JoplinU 编辑器概念验证

独立开发目录，保留目标仓库原有 Joplin 工程。当前实现是浏览器内存原型，用于验证 Markdown / Y.Text / ProseMirror 之间的适配，不是桌面或 Android 正式应用。

```sh
cd experiments/joplinu
npm ci
npm run dev
```

打开 `http://localhost:5173`。四个视图共享同一份 Markdown。使用「双实例实验」可断开连接、分别编辑并重新连接，观察两个独立 Y.Doc 合并。导入替换当前实验文档且可撤销；「导出 Markdown」可保存原文。

**刷新会丢失会话内容。尚无 SQLite、云同步、E2EE、附件加载、APK 或 Electron 安装包。不要将真实笔记只保存在此原型中。** 界面显示的是未持久化状态。

```sh
npm run build
npm test
# 默认使用 /usr/bin/chromium；其他安装位置可覆盖：
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm run test:browser
```

CI 安装 Playwright Chromium 并通过环境变量选择可执行文件。测试包含 Markdown 原文保留、双向编辑、共享撤销、源码回退、表格局部修改、并发 / 乱序 / 重复 Yjs 更新、安全渲染与小屏布局。合成 composition 事件不能代替 Android 中文输入法真机测试。

目录：`apps/playground` 为 React 实验 UI，`packages/document` 为 Yjs 权威状态，`packages/editor` 为 CodeMirror / ProseMirror 适配，`packages/markdown` 为解析、位置与安全渲染，`tests` 为自动化验证。

- [架构决策、边界和安全设计](docs/architecture.md)
- [分阶段计划和后续门槛](docs/implementation-plan.md)
- [测试记录与限制](docs/validation.md)

当前限制包括：Live Preview 尚无复杂块 widgets；富文本公式与未知语法使用源码回退，附件为占位；Shiki / Mermaid 未接入；结构化编辑存在保真拒绝路径；选区映射尚不覆盖所有语法；没有平台发布、真实 OSS / S3 或 Android 真机测试。完整同步必须等待文档模型门槛通过。
