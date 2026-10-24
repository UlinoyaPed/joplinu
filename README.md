# JoplinU

跨平台、离线优先的 Markdown 笔记应用。已实现四模式编辑、多级文件夹、本地笔记库、设置、历史恢复和备份，并提供独立的 Electron RPM / Capacitor Android APK 构建工程。

实际开发入口位于 [`experiments/joplinu`](experiments/joplinu)。仓库保留的旧 Joplin 代码仅供参考，不参与新应用构建。

```sh
cd experiments/joplinu
npm ci --ignore-scripts
npm run dev
```

- [架构设计](experiments/joplinu/docs/architecture.md)
- [RPM、APK 与 GitHub Secrets 签名配置](experiments/joplinu/docs/builds.md)
- [OSS / S3 传输接口和真实服务测试](experiments/joplinu/docs/storage.md)
- [测试和当前限制](experiments/joplinu/docs/validation.md)
- [本地笔记库与功能范围](experiments/joplinu/docs/local-library.md)
- [分阶段实施](experiments/joplinu/docs/implementation-plan.md)

GitHub Actions 的 **JoplinU RPM and APK** workflow 生成 RPM、debug APK、release APK、校验值和构建信息；未配置密钥时生成明确标记的 unsigned 产物。签名密钥可后续添加到仓库 Actions Secrets。

桌面与 Android 使用 SQLite，浏览器预览使用 IndexedDB。仅在事务提交后显示“已保存到本地”。支持 Markdown 文件夹 / ZIP 和完整备份，也可用密码加密备份。当前仍是开发版本，建议保留独立备份。OSS/S3 云同步、同步 E2EE、后台任务和 Android 中文输入法真机验收尚未完成。

代码遵循仓库许可证；发行包包含依赖许可证与第三方 notices。
