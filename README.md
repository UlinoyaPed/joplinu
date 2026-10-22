# JoplinU

跨平台、离线优先的 Markdown 笔记应用。当前交付为可运行的四模式编辑器原型，以及独立的 Electron RPM / Capacitor Android APK 构建工程。

实际开发入口位于 [`experiments/joplinu`](experiments/joplinu)。仓库保留的旧 Joplin 代码仅供参考，不参与新应用构建。

```sh
cd experiments/joplinu
npm ci --ignore-scripts
npm run dev
```

- [架构设计](experiments/joplinu/docs/architecture.md)
- [RPM、APK 与 GitHub Secrets 签名配置](experiments/joplinu/docs/builds.md)
- [测试和当前限制](experiments/joplinu/docs/validation.md)
- [分阶段实施](experiments/joplinu/docs/implementation-plan.md)

GitHub Actions 的 **JoplinU RPM and APK** workflow 生成 RPM、debug APK、release APK、校验值和构建信息；未配置密钥时生成明确标记的 unsigned 产物。签名密钥可后续添加到仓库 Actions Secrets。

当前应用仍是编辑器技术原型：会话内容未写入数据库，需导出保存。SQLite、OSS/S3 同步、E2EE、后台任务和 Android 中文输入法真机验收尚未完成。

代码遵循仓库许可证；发行包包含依赖许可证与第三方 notices。
