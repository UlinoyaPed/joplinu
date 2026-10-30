# 桌面 / APK 构建与签名

构建入口是 `.github/workflows/joplinu-build.yml`，完成独立检查 workflow 与真实 S3 服务测试后并行构建 Electron Linux x64 RPM、Windows x64 NSIS 安装包和 Capacitor Android APK。不依赖旧 Joplin 构建工程。当前开发版包含本地笔记库及前台加密同步 / 恢复快照；真实 OSS、真机 IME、物理设备节电 / 进程终止和大容量仍需分别验收。

## 自动构建

- dev 推送及 PR 修改 JoplinU 目录或 workflow 时自动检查和构建，避免同一开发分支的 push / PR 重复构建。
- `v*` 标签触发构建；`workflow_dispatch` 支持手动运行。
- PR 和普通开发分支产物不使用正式签名密钥。
- `dev` 分支与 `v*` 标签的 push，在完整 Secrets 已配置时自动签名。手动运行勾选 `sign` 也会尝试使用已配置密钥。
- 缺少全部密钥时继续生成未签名 RPM、可安装的 debug APK，以及明确标记 `unsigned` 的 release APK。只配置部分必需密钥时失败，不静默降级。

Actions 页面中下载 `joplinu-linux-x64-rpm` 和 `joplinu-android-apk` 两个 artifact。文件名与 `build-info.json` 标明签名状态、版本和提交；`SHA256SUMS` 提供每个安装包的校验值。未签名 release APK 需要正式签名后才能安装，当前可直接体验 debug APK。

Windows artifact 为 `joplinu-windows-x64-installer`，包含 NSIS EXE、校验值和签名状态。CI 在实际 Windows runner 构建，启动打包后的程序验证隔离、SQLite 重开和损坏资料保护。安装器默认按用户安装，可选择目录；卸载不自动删除用户数据。没有证书时明确生成 unsigned；配置证书后必须通过系统 Authenticode 校验。

构建不自动发布 GitHub Release，也不自动上传到应用商店。

## 后续配置 GitHub Secrets

在仓库 Settings → Secrets and variables → Actions 添加以下 Secrets。密钥文件先在本地转为 base64，直接保存到 Secret；不要放进源码、Issue、日志或聊天。

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Android release keystore 文件的 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 签名 key 的 alias |
| `ANDROID_KEY_PASSWORD` | 该 key 的密码 |
| `RPM_GPG_PRIVATE_KEY_BASE64` | 导出的完整 GPG 私钥文件的 base64 |
| `RPM_GPG_KEY_ID` | 对应完整 fingerprint，40 或 64 位十六进制 |
| `RPM_GPG_PASSPHRASE` | GPG 私钥口令；无口令的测试或个人密钥可留空 |
| `WINDOWS_CERTIFICATE_BASE64` | 可选 Windows Authenticode PFX 证书的 base64 |
| `WINDOWS_CERTIFICATE_PASSWORD` | 对应 PFX 密码；证书没有密码时可留空 |

正式 APK 后续升级必须沿用同一 keystore。debug 包 ID 是 `org.joplinu.app.debug`，正式包 ID 是 `org.joplinu.app`，可以并存。原始密钥需要独立备份，GitHub Secrets 不作为唯一恢复来源。

CI 未配置固定密钥时，debug APK 使用该 runner 生成的开发证书。不同构建可能无法覆盖安装；请先导出完整备份，不要通过卸载或清除应用数据来强行升级。需要持续使用和升级的版本应配置正式 keystore 并使用 release 包。

签名脚本仅在系统临时目录解码私钥，密码通过权限为 0600 的临时文件交给官方工具，完成或失败后清理。APK 使用 Android SDK 的 zipalign / apksigner，检查 16 KiB 页对齐与签名；RPM 使用 GPG / rpmsign，并通过临时 rpm key database 验证。RPM 签名后附带公钥，私钥不会成为 artifact。

每个平台的 CI 还会生成独立、一次性的测试密钥，对安装包副本执行真实签名和验证，随后删除测试密钥和测试副本；发布 artifact 的正式签名状态由仓库 Secrets 决定。测试密钥不充当正式密钥。

## 本地构建

要求 Node 24、npm。Android 另需 JDK 21、Android SDK Platform 36 / Build Tools 36.0.0，配置 `ANDROID_HOME`。Gradle wrapper 固定 8.14.3，并校验官方分发包 SHA-256。

在仓库根目录：

```sh
cd experiments/joplinu
npm ci --ignore-scripts
npm run check
```

Linux RPM 另需 rpm / rpmbuild / rpmsign、GPG 和 Electron 运行库：

```sh
node node_modules/electron/install.js
npm run build:rpm
```

桌面预览可在构建后运行 `npx electron apps/desktop`。CI 使用 Xvfb 启动打包后的真实程序，检查资源加载、四模式入口、renderer 隔离和实际 SQLite 重启恢复。测试进程使用的 `--no-sandbox` 不写入应用启动器，正式程序默认保留 sandbox / contextIsolation。

Windows 本机构建：安装 Node 24 后在工程目录运行 `npm ci --ignore-scripts`、`node node_modules/electron/install.js`、`npm run build:windows`。不在 Linux 上模拟宣称 Windows 验收。

Android：

```sh
npm run build:apk
```

APK 构建会同步当前 web assets、运行 :app:assembleDebug / :app:assembleRelease / :app:lintDebug，然后收集产物。CI 还会在 Android 35 模拟器运行 :app:connectedDebugAndroidTest，验证真实 WebView → Kotlin → SQLite 的中文大载荷分片、CAS 冲突、错误回滚与 Activity 重建恢复；模拟器结果不替代真机中文输入验收。Windows 本机可在 `apps/android/native` 使用 `gradlew.bat` 执行相同任务。`JOPLINU_VERSION_CODE` 可指定正整数 versionCode，CI 使用 workflow run number。

Android 主 Activity 使用 Kotlin；文件导出写入应用 cache 的 exports 目录，再通过系统分享界面交给用户。没有申请外部存储全盘权限。WorkManager 只传输已加密持久队列，不在后台运行 WebView 文档引擎或确认队列；具体边界见 sync-protocol.md。APK 构建成功不能替代中文输入法、系统电源限制和真实设备验收。

## 许可证与依赖

构建时根据锁文件生成运行时第三方许可证清单，随 web assets 打包为 `THIRD_PARTY_NOTICES.txt`，并附完整 AGPL 文本。Capacitor 模板 MIT notice 和 Gradle wrapper Apache-2.0 文本保留在 Android 工程。

本次打包依赖审计发现旧 `@electron/get` 引入的 sprintf-js 问题，以及 xcode 使用的旧 uuid 问题。锁定 `@electron/get` 5.1.0 和 uuid 11.1.1，验证下载器 API、Capacitor sync、打包与启动流程；后续升级需继续运行这些检查。
