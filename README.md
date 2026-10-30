# JoplinU

跨平台、离线优先的 Markdown 笔记应用。0.2.0 开发版提供类似原版的三栏布局、四模式编辑、多级文件夹、标签 / 待办 / 置顶、条件搜索、历史、附件与备份；原生客户端支持加密增量同步、恢复快照、主密钥轮换和完整密文仓库迁移。

实际开发入口位于 [`experiments/joplinu`](experiments/joplinu)。仓库保留的旧 Joplin 代码仅供参考，不参与新应用构建。

```sh
cd experiments/joplinu
npm ci --ignore-scripts
npm run dev
```

- [架构设计](experiments/joplinu/docs/architecture.md)
- [RPM、Windows 安装包、APK 与签名 Secrets](experiments/joplinu/docs/builds.md)
- [加密同步、快照、密钥轮换和存储迁移](experiments/joplinu/docs/sync-protocol.md)
- [OSS / S3 传输接口和真实服务测试](experiments/joplinu/docs/storage.md)
- [测试和当前限制](experiments/joplinu/docs/validation.md)
- [本地笔记库与功能范围](experiments/joplinu/docs/local-library.md)
- [分阶段实施](experiments/joplinu/docs/implementation-plan.md)

GitHub Actions 的 **JoplinU desktop and Android builds** workflow 生成 Linux RPM、Windows NSIS 安装包、debug / release APK、校验值和构建信息。未配置密钥时明确标记 unsigned；debug APK 可直接安装，release APK 需要签名。正式密钥后续添加至仓库 Actions Secrets，不进入源码。

桌面与 Android 使用 SQLite，浏览器预览使用 IndexedDB；仅在事务提交后显示“已保存到本地”。设置中配置 OSS / S3，再创建加密库或用恢复码加入。Android WorkManager 只传输已加密队列，前台负责认证、合并和确认。支持 Markdown 目录 / ZIP、明文和密码加密的独立备份。

当前仍需真实 OSS、多厂商端点、Android 物理输入法 / 节电行为和大容量验收，不能将模拟器或单个 S3 服务的结果替代它们。请保留独立备份。早期 v1 本地存储不自动迁入 v2，应在旧版本导出完整备份后恢复，原文件不删除；参见 [存储升级边界](experiments/joplinu/docs/yjs-journal.md)。

代码遵循仓库许可证；发行包包含依赖许可证与第三方 notices。

- [完整产品目标、已实现能力与缺口](experiments/joplinu/docs/product-scope.md)
