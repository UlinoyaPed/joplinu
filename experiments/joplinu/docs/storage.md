# 对象存储接口与实际验证

这是一组独立的传输适配器，尚未接入应用笔记同步。当前 UI 仍显示云端未连接，没有自动上传笔记、凭据或本地数据库。完整同步继续等待文档模型 / 真机中文输入门槛通过。后续提交按用户要求直接推送 dev，不使用 PR。

## 模块与 SDK

- `packages/storage`：ObjectStorageProvider、结构化错误、有限重试、超时、取消、命名空间检查、下载长度与容量校验、分页迭代和独立连接诊断；不依赖任何厂商 SDK。
- `packages/storage-s3`：AWS SDK for JavaScript v3，SigV4、自定义 endpoint / region / path-style、固定或动态短期凭据。动态源在每次请求 / 重试前通过 SDK 公共 forceRefresh 入口刷新，避免无 expiration 的身份被永久缓存。关闭可选 AWS S3 Express / 加速 / 自动跨 Region 及非必要 checksum 依赖，不将 ETag 当文件哈希。
- `packages/storage-oss`：官方 ali-oss 6.23 SDK、OSS V4 签名、独立的 Region 与 CNAME 选项、STS、ListObjectsV2 及 OSS continuation token。不会把 OSS 当成 S3。

当前两个实现都是 Node host adapter，供桌面主进程 / worker 或测试工具调用。它们没有被打包进 WebView，也未提供 Android 原生存储请求桥、凭据 keyring 或应用内配置 / 连接 UI。共享同步核心只依赖接口；Android 以后需要相应原生适配器，不能假装 Node SDK 已直接兼容 WebView。

Endpoint 默认 HTTPS，可不写 scheme（补为 HTTPS）；拒绝内嵌用户名 / 密码、查询参数及路径。只有显式 `allowInsecureLocalhost` 才允许向 localhost / loopback 发送 HTTP，用于本地服务测试，不允许把私有网段明文 HTTP 当生产默认。没有关闭证书验证的选项。OSS 区域 endpoint 可推导 region；自定义域名 / 加速 endpoint 应显式配置正确 region。

## 统一语义

`putObject` 默认按同一 key 覆盖，重试使用方法入口时复制的同一份字节。它不是“不存在才写”，不代表服务端只执行了一次。同步层以后必须产生不可变唯一对象名，持久化相同密文后再重试。

`getObject` 返回二进制；默认最多 64 MiB，可显式调整。下载超限中止，声明长度与实际长度不一致拒绝。传输层无法凭 ETag 证明内容真实性，未来同步必须另外认证 / 解密封包。

`headObject` 对对象不存在返回 null，get 对不存在抛 not-found。S3 HEAD 的无详情 404 本身无法区分缺失 bucket 与 key；连接诊断先执行 list / put 以暴露 bucket 配置错误。明确 NoSuchBucket 归为 invalid-config，其他权限 / 认证失败不会被当成“不存在”。delete 对已不存在对象幂等。

`listObjects` 一次返回一页，cursor 不透明地交回原 SDK；返回 key 去掉配置前缀并校验仍在请求命名空间内。`listAll` 不会因为空页而忽略后续 cursor，检测循环 token 与异常页数，不假设一次 list 就包含所有对象，也不保证云端列表是一个事务快照。

错误区分认证、权限、不存在、配置、请求不支持、冲突、节流、网络、TLS、超时、取消、完整性、大小限制和凭据不可用。仅临时网络 / 超时 / 节流等故障指数退避并加入 jitter；默认最多 3 次、每次 15 秒，调用方可取消。SDK 内层重试关闭，避免叠加成重试风暴。返回错误不保留原始 SDK message / cause，不暴露 signed URL 或凭据。

取消不等于服务端回滚：请求响应丢失或取消后对象仍可能已经上传。S3 使用 AbortSignal，OSS 上传的取消以停止等待及 SDK 自身超时为界，不能声称所有已发出的请求都会立即停止。下载流会主动终止。调用者仍须保留已分配对象 ID，避免以新 key 重传造成无界重复。

Capabilities 对 conditionalWrite、versioning、objectLock 均声明 false；没有用 AWS 或 OSS 的额外能力建立正确性假设。

## 连接诊断

`probeStorage` 只在新随机 `__joplinu_connection_test/<uuid>/` 下上传 128 个随机字节，逐项检查 list / put / head / get / SHA-256 / delete，并尽力清理自己生成的确切 key。即使上传响应丢失也会清理；取消后可能已上传的对象同样需要清理。若清理失败，结果保留潜在 leftover key，不扫描或删除已有用户数据。

写入失败时 read / head 标为 not-tested，不能因为没能创建测试对象就声称读取权限不存在。诊断对象是随机测试数据，不是笔记导出；它没有绕过同步 E2EE 门槛。

## 真实 S3 服务测试

本轮原本选择 MinIO；其官方二进制下载返回 HTTP 410，quay.io / Docker Hub 的 MinIO 镜像匿名 token 不含 pull 权限，实际请求返回 401。没有获取用户账号或使用不明镜像替代。改为 **SeaweedFS 4.49** 的真实 S3 网关、元数据存储和磁盘卷服务，验证的是这个具体版本与配置，不能据此宣布 MinIO / R2 / AWS / Ceph / Wasabi 全部兼容。

测试工具从 SeaweedFS 官方 GitHub release 下载 Linux x64 文件，校验发布资产 SHA-256：`3d10545b2317adc1587be02594f97e63420fe1aa7a5ba2af9c9760804574e397`，通过后才提取运行。二进制放在临时目录，不提交或随客户端发布。测试服务仅绑定 loopback，关闭遥测 / WebDAV / 管理 UI，使用临时文件夹与临时身份，结束后销毁；不会使用个人云存储。

```sh
cd experiments/joplinu
npm ci --ignore-scripts
npm run storage:setup
npm run test:storage:s3
```

其他平台可提供自己的 `SEAWEED_BINARY`，自动下载脚本只支持 Linux x64。CI 的 Real S3 compatibility job 同样执行实际服务测试，通过后才进行 RPM / APK 打包。

| 检查 | 证据 |
| --- | --- |
| SigV4 | 正确凭据请求通过，错误 secret 的真实签名被服务拒绝 |
| 凭据刷新 | 动态凭据源从错误密钥切换为有效密钥后，无需重建 Provider 即可完成真实请求 |
| API | 二进制 / 空对象、中文及特殊字符 key、head 元数据、get 缺失、幂等 delete |
| 分页 | pageSize=2，实际读取 7 个对象及所有 continuation token |
| 权限与范围 | 只读身份拒绝写入，配置 prefix 之外对象保持不变，路径越界在请求前拒绝 |
| 响应丢失 | 代理在真实服务完成上传后断开响应，重试仍使用原字节；调用者修改原数组不改变上传内容 |
| 故障 | 真实 HTTP 请求外层注入超时 / 503，验证有限重试；不是用 Mock SDK 证明接入 |
| 取消 / 限制 | 已取消请求、下载上限、随机连接诊断及清理 |
| 持久化 | 正常重启真实服务后仍可读取已确认对象；没有宣称验证所有服务的 SIGKILL / 回滚行为 |

上述 9 项集成测试已在本地执行通过。另有核心策略测试与官方 OSS SDK 的本地 HTTP 协议 fixture；后者只验证签名模式、请求 / 响应适配和分页，不代表真实 OSS 验收。

## 真实 OSS 测试入口（尚未执行）

通过环境 / Secret 绑定配置以下名称，不能把值写进仓库、日志或聊天：

- `JOPLINU_OSS_ENDPOINT`、`JOPLINU_OSS_BUCKET`、`JOPLINU_OSS_TEST_PREFIX`
- `JOPLINU_OSS_ACCESS_KEY_ID`、`JOPLINU_OSS_SECRET_ACCESS_KEY`
- 自定义 endpoint 需要 `JOPLINU_OSS_REGION`；STS 可用 `JOPLINU_OSS_SESSION_TOKEN`

```sh
npm run test:storage:oss
```

测试只创建新随机命名空间的诊断对象，不新建 / 删除 bucket、不覆盖已有对象；需要该测试前缀下的读 / 写 / list / delete 权限。未配置时明确失败，不切换到 fixture 或把跳过当通过。本环境没有这些凭据，因此**不能声称真实 OSS 接入、其他 S3 厂商兼容矩阵或端到端笔记同步已经验收**。

## 桌面应用内配置（2026-10-29）

设置 → 同步新增 OSS / S3、Endpoint / Region / Bucket / Prefix、Path-style / CNAME、临时令牌、连接权限诊断和配置清除。SDK 只运行在主进程，经白名单 IPC 调用。凭据提交后清空表单，不返回给前端状态，不进入笔记、配置导出或普通日志；更换端点需要重新填写。

Electron safeStorage 加密凭据文件，拒绝 basic_text。系统密钥环不可用时仅允许会话使用，不降级为明文落盘。清除配置不删除远端数据。Node SDK 与其 urllib 代理适配一起构建为主进程模块，不进入 WebView。

已实际执行 Electron 界面 → 隔离 IPC → 原生 SDK → SeaweedFS 真实 S3 的连接流程，验证上传 / 读取 / 列举 / head / 删除、诊断清理、字段清空、状态与笔记库无凭据，以及重启后会话生命周期。尚无真实 OSS 凭据，不宣称 OSS 云端验收。此处连接诊断不上传笔记，增量同步与 E2EE 正在后续接入。

## Android 原生云配置

Android 使用独立 Capacitor 插件和 `HttpURLConnection` 执行前台对象请求，S3 使用 AWS SigV4，OSS 使用 OSS V4；二者共享对象接口与错误分类，不依赖 WebView CORS。凭据经过 AndroidKeyStore 不可导出 AES-GCM 密钥加密后写入 AtomicFile；JS 只能读取公开配置和操作结果。生产版本只接受 HTTPS，正常校验证书；调试版本仅为模拟器/本机环回开放 HTTP，以便 CI 使用真实的临时 S3 服务。插件提供标准读写、分页、校验、超时和有限重试。

CI 增加一个原生连接场景：在模拟器通过原生桥接访问真实 SeaweedFS S3，检查读写/列举/删除、二进制内容、磁盘凭据加密和重新加载。该自动化验证与真实 OSS 服务、Android 真机输入法验收分别记录。此步骤仍然只建立云传输和安全凭据保管，不代表已实现笔记同步或 E2EE。
