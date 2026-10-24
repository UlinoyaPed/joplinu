# JoplinU 本地笔记库

独立的 TypeScript / React 笔记应用，Electron 桌面与 Capacitor/Kotlin Android 共用四模式编辑器和笔记管理界面。旧 Joplin 工程只作设计参考，不参与构建。

```sh
cd experiments/joplinu
npm ci --ignore-scripts
npm run dev
```

打开 `http://localhost:5173`。桌面采用类似原版的文件夹 / 标签、笔记列表、编辑器三栏，支持调宽和隐藏；手机使用抽屉与独立列表。可新建多级文件夹与笔记，编辑、搜索、按标签筛选、复制、批量移动和回收恢复、查看或恢复历史。在设置中调整主题 / 字体 / Markdown 渲染，并导入导出目录、明文或密码加密的完整备份。插件按截图要求暂不实现。

桌面与 Android 通过受限原生接口使用 SQLite，浏览器预览使用 IndexedDB。只有数据库确认提交后才显示“已保存到本地”。读取损坏资料不会重置为空库；保存失败保留内存内容并提供导出。多窗口争写时拒绝过期版本，要求备份后重新打开，尚未实现窗口间自动协同。

云同步尚未启用；加密备份不等于同步 E2EE。当前是开发版本，请保留独立备份。完整同步必须等待文档模型与真机输入验收通过。

```sh
npm run check
# 默认使用 /usr/bin/chromium；其他安装位置可覆盖：
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium npm run test:browser
# 原生打包：
npm run build:rpm
npm run build:apk
```

模块：`packages/document` 为权威 Y.Text，`editor` 为 CodeMirror / ProseMirror 适配，`markdown` 为安全渲染与位置映射，`library` 为目录 / 历史 / 备份控制器，`database` 为持久化端口，`crypto` 为独立备份加密，`platform` 为文件导出。业务逻辑不依赖旧 Joplin 服务。

- [独立 OSS / S3 适配器与真实 API 验证](docs/storage.md)
- [本地笔记库的实际功能与限制](docs/local-library.md)
- [RPM / APK 构建和签名 Secrets](docs/builds.md)
- [架构设计与依赖边界](docs/architecture.md)
- [分阶段计划和门槛](docs/implementation-plan.md)
- [验证记录](docs/validation.md)
