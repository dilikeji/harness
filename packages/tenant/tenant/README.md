# @deepseek-ai/dsh-tenant

多租户身份层：把一个 token 解析成一个**租户**（某人的 home、工作区、凭据文档、会话历史），
并把它发布为当前异步链的*环境租户*。

## 提供的服务

| 服务 | 职责 | 依赖 |
|---|---|---|
| `ctx.tenantPaths` | 持有环境租户，按租户解析数据根（`root()` / `file()`） | 无 |
| `ctx.tenants` | 用部署的认证接口校验 token、建目录、写模型 key、缓存解析结果 | `tenantPaths`，运行时可选读 `credentials` |

两者必须一起工作，所以放在同一个包里；但**必须分成两个服务**，
否则 `tenantPaths → credentials → tenants` 会闭合成环：

- 持久化插件（要数据根）依赖 `tenantPaths`
- 凭据插件（要文件路径）依赖 `tenantPaths`
- `tenants` 需要在租户上下文里写模型 key，所以它用 `ctx.get('credentials')`
  而不是 `inject`——登录发生在所有服务就绪之后，这个间接读是安全的。

## 环境租户

环境租户是一个 `AsyncLocalStorage` 槽位，与 `AgentRegistry` 追踪 initiator 的方式同构。
边界建立在**身份已知**的地方（带 token 的 HTTP 请求、WebSocket 帧、恢复执行的后台任务），
之后所有嵌套调用自动继承。因此需要数据根的插件**不接收 tenant 参数**，而是主动询问。

## 配置

```yaml
- id: tenant
  name: '@deepseek-ai/dsh-tenant'
  config:
    root: !!js dshHomePath('tenants')      # 缺省即此值
    verify: true                            # 生产姿态
    authEndpoint: !!js process.env.DSH_AUTH_ENDPOINT ?? 'https://admin.longtongjiyun.com/v1/api/notify/harnessAuth'
    cacheSeconds: 300
    requestTimeoutMs: 10000
    apiKeyRef: DEEPSEEK_API_KEY
```

`verify: false` 让 token 本身充当用户名，仅用于本地开发：它仍然按文件夹隔离，
但任何能访问端口的人都能声称任意用户名。**共享部署上绝不能关闭。**

## 数据布局

```
<root>/<username>/
├── sessions/            # 会话历史
├── storages/            # workspace.json 等
├── .credentials.yaml    # 该用户的模型 key
└── workspace/           # 工作区根（会话 cwd）
```

`USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/` 是硬边界：它排除了路径分隔符、`..`、
盘符、空白，以及任何可能逃出租户根目录的字符，所以即使认证接口返回恶意用户名，
一个租户也无法写进另一个租户的目录。

## token 处理

token 只以 **sha256 摘要**作为缓存键；明文不驻留内存、不进日志、不落盘。
缓存 TTL 取 `cacheSeconds` 与接口返回的 `expiresAt` 的较小值。
