# 分阶段实施与验收门槛

每一阶段独立提交可运行的增量。当前完成阶段 0 / 1 原型，并按用户要求提前实现本地笔记库、设置和平台构建；完整同步门槛仍开放。

| 阶段 | 交付 | 必须验证 | 当前状态 |
| --- | --- | --- | --- |
| 0 | 仓库检查、许可证和依赖边界、架构 ADR | 保留旧代码；独立构建不会安装旧原生工程 | 已完成本次检查与设计 |
| 1 | 四模式原型、原文 / 富文本局部适配、双实例实验 | 模式切换原文不变；代表性格式 / 表格编辑；未知扩展回退；真实中文 IME、选区、撤销、长文档 | 浏览器原型，门槛仍开放 |
| 2 | SQLite 更新日志、原子保存、历史恢复和多窗口文档服务 | 进程终止 / 磁盘失败后恢复；本地状态准确 | 已建立有界 SQLite 原子资料快照、失败恢复、历史；逐更新日志和自动多窗口协同仍待实现 |
| 3 | Provider 接口、OSS 和 S3 实现、连接诊断 | 真实 OSS 与真实 S3 服务的分页 / 操作 / 权限 / 重试 / 响应丢失行为 | 独立接口、OSS / S3 Node 适配器及连接诊断已实现；SeaweedFS 4.49 九项真实 API 测试通过；真实 OSS、其他厂商及配置 UI 待验证，不开始完整同步 |
| 4 | E2EE、签名、不可变更新包、outbox/inbox、快照和恢复 | 离线多设备、乱序 / 损坏 / 回滚、密码与设备恢复；不删除历史 | 未开始 |
| 5 | Electron / Capacitor Kotlin、完整笔记管理和设置 | Linux / Windows 桌面；可安装 APK；Android 真机中文输入与后台密文传输 | 已建立平台壳、RPM / APK、目录 / 搜索 / 标签 / 历史 / 设置 / 备份；真实平台验收和后台同步待完成 |
| 6 | 性能、故障注入、备份 / 迁移 / GC、发布流水线 | 真实端点矩阵、独立备份恢复、签名构建与安全审查 | 未开始 |

## 阶段 1 后续小步改动

1. 针对段落拆分 / 合并、空文档、粘贴、表格操作、列表嵌套和复杂标记完善转换；用失败草稿与原文对照验证拒绝路径。
2. 公式 NodeView、任务开关、表格工具、附件 broker、Live Preview 块 widgets；注册每类扩展的原文保留策略。
3. 精确化转义文本、代码围栏、原子节点和双向选区映射；防止软键盘 / compositioncancel / blur 导致远端队列不能释放。
4. 用 Android WebView 和至少两种真实中文输入法测试组合输入，覆盖断线更新、撤销、选区、旋转与恢复。浏览器模拟测试不算通过。
5. 记录 100 KiB / 1 MiB 文档的输入延迟、投影时间、模式切换与内存，建立性能预算，再决定分块或 worker 解析。
6. 本地 SQLite 已提前接入以验证恢复与可用性；完整同步仍须等待门槛通过。若数据模型仍有丢失风险，先实验替代模型。

## 参考资料与依赖说明

- [CodeMirror Decorations](https://codemirror.net/examples/decoration/)：可见区域视图插件、状态字段及布局影响。
- [ProseMirror Guide](https://prosemirror.net/docs/guide/)：schema、事务和 DOM composition；源码中实际使用 dispatchTransaction / findDiffStart / findDiffEnd。
- [Milkdown architecture](https://milkdown.dev/docs/guide/architecture)：评估其 ProseMirror 插件层，暂不引入。
- [y-codemirror.next](https://github.com/yjs/y-codemirror.next)：阅读 README 及安装版本的 y-sync / y-undomanager，验证自定义 UndoManager 能跨模式复用。
- [Yjs Y.Text API](https://docs.yjs.dev/api/shared-types/y.text)：该站本次网络返回 403；改为检查实际安装的 yjs 类型 / 实现并运行并发测试，不将未读取网页当作证据。
- [rehype-sanitize](https://github.com/rehypejs/rehype-sanitize)：在 KaTeX 前清洗输入；KaTeX 设置 trust=false，资源层额外去除外链图片。
- Joplin 参考代码路径和许可证见 [architecture.md](architecture.md)。新实现不使用原版图标或样式资源。

原型直接依赖许可证以 MIT 为主；KaTeX MIT、其字体按上游分发条款随依赖处理；TypeScript Apache-2.0、Playwright Apache-2.0。根 AGPL 条款保留，打包分发前应导出完整传递依赖许可证与 notices，不能仅依据这里的概述替代审计。
