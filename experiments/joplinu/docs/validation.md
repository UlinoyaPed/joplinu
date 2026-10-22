# 实际验证记录

日期：2026-10-22。平台：本任务 Linux 云环境，Node 24.19.0 / npm 11.9.0，系统 Chromium，通过 Playwright 启动。结果仅描述这个原型，没有验证旧 Joplin 完整工程或发布安装包。

## 已执行

`npm run check` 顺序执行 `npm run build`（包含严格 `tsc --noEmit`）、`npm test`、`npm run test:browser` 和 `npm run test:production`。

| 检查 | 结果 / 范围 |
| --- | --- |
| TypeScript + Vite production build | 通过；JS 约 1.66 MB，gzip 约 545 KB，仍有大 chunk 提示 |
| Vitest | 38 / 38：权威文本、远端与本地撤销、相对选区、组合输入队列、非法 / 过期事务、UTF-16、源码保真、表格、代码、链接附件、未知扩展、空行、CRLF、乱序 / 重复更新、并发文字、安全渲染与性能样本 |
| Playwright + 真实 Chromium | 开发服务器 10 / 10，生产构建 10 / 10：四模式切换逐字保留；源码与富文本双向编辑；跨模式撤销 / 重做；格式工具栏；换段 / 空行 / 空文档；未知语法源码入口；转换拒绝时原文和恢复草稿；两实例断线编辑 / 重连；合成 composition；安全双列预览与点击定位；393px 小屏布局。首项同时检查 console error、运行错误与实际字体加载；复测使用与 CI 一致的 Chrome for Testing 156.0.8078.4 |
| 依赖审计 | 显式 npm audit 完成，当前锁文件报告 0 项漏洞；这不等同于代码安全审计 |
| `git diff --check` | 通过 |
| 根忽略文件生成器 | `yarn updateIgnored` 因旧根工程未安装依赖、缺 node_modules state 失败；在独立临时工具目录安装 fs-extra / execa / glob 后，通过 NODE_PATH 运行仓库原有 updateIgnoredTypeScriptBuildRun.js 成功，只增加新 TS 文件对应的 JS 忽略项 |

浏览器测试使用 DOM / 键盘操作、真实编辑器实例和文件导入 / 导出，不依赖调试用全局状态或模拟的 CodeMirror / ProseMirror。双实例实验是本机 Yjs 字节传递，不是对象存储同步。

## 实测发现与修正

- 修改标题原先会规范化尾部空格；引入原始文本叶子映射后，普通文字编辑保持尾部空格不变。
- 同一富文本事务的两个分离修改不再用一个大替换删除中间字符；测试验证中间的并发插入仍存在。
- Markdown 不保留结构化空段落；投影增加对应额外空行的虚拟段落，以支持 Enter、连续空段落和空文档输入，再次切换不吞掉已写入的段落。
- 代码正文与语言名相同时，位置映射需要跳过代码围栏首行，已有回归测试。
- 生产包检查发现 Vite 默认将小字体内联成 data URL，被 font-src self 拦截；关闭资源内联并添加生产包浏览器验证，没有扩大 CSP 资源权限。缺失的站点图标改为本工程独立 SVG。
- 远端浏览器测试发现原生文末导航与编辑器选区更新在不同环境下表现不一致；增加直接通过 ProseMirror transaction 定位文首 / 文末的 Mod-Home / Mod-End 快捷键。测试点击具体段落、断言焦点并使用此快捷键，采用 CI 浏览器版本复测。
- 快速按 Shift+方向键后立即使用工具栏可能先于 selectionchange 处理；格式命令现在读取实际 DOM 选区并映射为 ProseMirror selection，再执行格式事务，避免对过期选区操作。
- 原生 Shift+方向键紧接导航的自动化时序仍有环境差异，尚未完成稳定性验收。工具栏测试改用浏览器原生 Range 建立选区，独立验证格式事务；这项测试不证明所有快速按键选区序列已稳定，后续须单独追踪并在真实平台测试。
- 首次依赖审计报告旧 Vitest / tinypool 和 KaTeX 的已知问题；升级 Vitest 5.0.5、KaTeX 0.19.0，并统一传递 KaTeX 版本后审计归零，新增 CI 审计检查。
- 当表格单元格直接输入未转义管道符导致源码结构不等价，原型拒绝写入，保留原文并提供已转义的恢复草稿。这是已测试的安全回退，也说明当前富文本适配仍有体验缺口。

## 性能证据

Vitest 在当前机器构建含中文、标题、段落与加粗的 Markdown，计时 unified → ProseMirror 投影及一次局部文字补丁；不是 Android 延迟，也不是完整键盘到屏幕的延迟。

| UTF-8 大小 | 投影块数 | 全量投影 | 补丁计算 |
| --- | --- | --- | --- |
| 102,528 bytes | 769 | 196 ms | 5 ms |
| 1,048,776 bytes | 7,857 | 1,180 ms | 18 ms |

这些是一次实际完整检查中的记录，机器与运行负载会影响结果。性能测试只断言补丁局部正确，不把任意速度阈值当通过条件。局部补丁没有消除输入后整篇解析的成本；1 MiB 富文本目前不满足响应要求。需要增量 AST / 分块投影 / worker 和渲染缓存优化，再在真机验证。不能将这两项测试通过描述为大型文档性能验收通过。

## 未验证与阶段门槛

- Android APK、WebView、真实中文输入法、软键盘、旋转、触摸表格、系统长按与生命周期均未验证。合成 composition 测试不能替代真机。
- 新增 Electron 平台壳，本地开发程序与 linux-unpacked 目录程序均已启动并通过资源 / renderer 隔离检查。RPM / APK 构建以本轮专用 CI 的实际结果为准；Windows 与 macOS 包、多窗口尚未验证。
- SQLite 原子保存、崩溃恢复和历史版本尚未实现。会话刷新会丢失内容，必须先导出。
- OSS / S3 Provider、真实 OSS / MinIO、凭据安全存储、E2EE、快照 / 新设备恢复、迁移、回滚检测和附件 GC 尚未实现，未执行任何云存储读写。
- Shiki / Mermaid、Live Preview 块 widgets、直接富文本公式编辑、资源加载、完整上下文菜单尚未实现。
- 复杂嵌套与格式并发可能文本收敛却语法不合法；没有声称解决所有语义冲突。CRLF / 转义 / 原子节点的精确选区，以及组合输入取消与多窗口同时编辑仍需覆盖。
- 新增 RPM / APK workflow 并调用原型检查 workflow，实际流水线与签名自测结果在 Actions 中确认；本地通过不代表远端成功。

**结论：已交付可运行、经过测试的阶段 1 概念验证；统一文档模型的完整验收门槛仍开放。先补完保真、真实中文 IME 和性能证据，再开始完整同步开发。**

## 原生构建增量

新增 4 项 Node packaging-helper 测试，覆盖 Electron 资源路径越界、部分签名配置拒绝、PR 上下文禁用正式密钥和 unsigned APK 字节保留。Capacitor sync 已发现 filesystem / share 两个实际插件，Kotlin Activity 和 SDK / Gradle 版本纳入构建。新增运行时许可证清单，构建资源可离线加载。

Electron 开发与 linux-unpacked 程序均通过 Playwright 实际启动；测试进程在此云环境使用 headless / no-sandbox，生产启动器没有添加这些测试参数。RPM / APK 的 CI 同时运行临时密钥真实签名验签，测试副本不会作为正式产物发布。详见 [构建与签名](builds.md)。
