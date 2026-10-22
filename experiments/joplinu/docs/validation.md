# 实际验证记录

日期：2026-10-22。平台：本任务 Linux 云环境，Node 24.19.0 / npm 11.9.0，系统 Chromium，通过 Playwright 启动。早期原型与后续本地笔记库记录分列；没有验证旧 Joplin 完整工程。最新范围与结果见下方“本地笔记库增量”。

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

## 本地笔记库增量（2026-10-22）

本轮以截图功能与文件夹管理为范围，新增有界 SQLite / IndexedDB 持久化、目录 / 搜索 / 标签 / 回收站、设置、历史、附件、完整备份、密码加密备份、实际 Shiki / Mermaid、富文本公式弹窗 / 任务开关 / 表格工具和实时预览块 widgets。上方早期原型中“内存会话”“未接入数据库 / 附件 / Shiki / Mermaid”的描述属于先前提交状态，已由本节和 [local-library.md](local-library.md) 更新。

- 严格 TypeScript + Vite production build 通过；代码与图表依赖按需分块，仍有较大 chunk 提示。
- Vitest 54 / 54：包括存储失败、保存中继续编辑、过期窗口、Yjs 重开与恢复、目录 / 引用导入、完整备份 / ZIP、认证加密错误与篡改拒绝，以及表格结构转换的新增回归。
- Node packaging tests 7 / 7：其中 3 项直接操作真实 SQLite，覆盖重开、SIGKILL 后恢复、过期 / 无效 / 超限写入；不是用内存 mock 证明 SQLite。其余是既有路径与签名边界。
- Chromium 交互：开发 23 / 23、production 23 / 23。新增目录 / 搜索 / 移动 / 回收站、持久设置与历史、实际 Mermaid / Shiki、附件、恢复备份、过期窗口与恢复导出、移动设置分类、富文本表格 / 任务 / 公式、内链与 Live Preview 块。
- Electron 在隔离临时 profile 中实际启动，检查 sandbox / contextIsolation / Node 隔离，编辑后退出再启动读取 SQLite，并确认损坏 SQLite 文件启动后保持原样且显示恢复界面；CI 还会对打包后的程序运行同一测试。
- npm audit 报告 0 项已知漏洞；不等同于完整安全审计。
- workflow 通过 actionlint。新增 Android 35 模拟器 instrumentation 验证真实 WebView / Kotlin / SQLite；成功与否以本提交 CI 为准，不以源码存在代替运行。

修复了两项实际结构转换问题：新建表格的首行需要映射为 table_header；表格 serializer 末尾换行与保留原文换行叠加会投影出额外空段，现以单独回归验证。发生不等价转换时仍保留原文并提供草稿，没有删除安全检查。

当前限制：聚合快照容量 40 MiB、当前全文搜索是本地内存缓存，不是 SQLite FTS；窗口争写会拒绝并要求备份后重开，不是自动协同；云同步 / 同步 E2EE / 后台任务未实现；真实中文 IME、完整双语、Windows/macOS 与 1 MiB 性能门槛仍开放。独立备份密码丢失无法恢复。

云端首次增量发现 Chromium 156 下行内公式 wrapper 的命中区域可能只有 1 像素，双击被父段落拦截。改为有最小尺寸的 inline-block，未使用 force-click 绕过；随后用相同 Chrome for Testing 156 在本地完整执行开发 / 生产各 22 项通过。增加了可控制文件读取完成顺序的组合输入回归，避免异步导入根据旧笔记状态切走正在组合输入的新笔记。

Android 35 模拟器已经实际执行应用 instrumentation：1 / 1，通过中文 / emoji 大载荷 SQLite 分片、过期与非法写入拒绝、完整性检查、WebView 重载和 Activity 重建。首次运行的通用 connectedDebugAndroidTest 随后也选择了生成的 Cordova SDK 子模块测试，触发其依赖重复类检查；应用测试本身 0 失败。改为明确 :app:connectedDebugAndroidTest，组装与 lint 也限定应用模块，避免把依赖工程测试误算成应用验收。

新增目录导出回归：同标题、相同短 ID 前缀的两篇笔记不能覆盖同一个 Markdown 文件。导出路径改用完整 ID，并限制名称 UTF-8 字节长度、处理 Windows 保留名称；完整备份清单始终保留原始标题。

导入现在以严格 UTF-8 解码，保留 BOM / CRLF，错误编码明确拒绝而不是替换成乱码；新增回归通过。表格结构命令保留列对齐属性，修改行列后重新映射 GFM 表头与对齐，周围代码围栏保持原文。窄桌面 / 平板使用抽屉导航以保留编辑宽度。最终本地完整检查：54 核心、7 包装边界、Chromium 156 开发与生产各 23 项通过。
