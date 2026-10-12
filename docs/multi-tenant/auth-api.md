# 多租户认证接口文档

本文档定义 DeepSeek Harness 多租户改造后的认证接口契约。

- **上游业务认证接口**：由公司后端提供，本文以 `https://admin.longtongjiyun.com/v1/api/notify/harnessAuth` 作为占位地址，
  实际地址通过启动参数 / 环境变量 `DSH_AUTH_ENDPOINT` 注入。
- **Harness 侧接口**：本次改造在本地 Harness 进程上新增的 HTTP 接口，供页面调用。

---

## 1. 总体流程

```
浏览器                              Harness 进程                       公司后端
  │                                    │                                 │
  │ 1. GET /?token=xxx                 │                                 │
  │───────────────────────────────────>│  (index 公开，不再下发 cookie)   │
  │ 2. 前端读出 token → localStorage    │                                 │
  │ 3. POST /api/tenant/session        │                                 │
  │    { token: "xxx" }                │                                 │
  │───────────────────────────────────>│                                 │
  │                                    │ 4. POST {AUTH_ENDPOINT}         │
  │                                    │    { token: "xxx" }             │
  │                                    │────────────────────────────────>│
  │                                    │ 5. { code:0, data:{用户+模型} }  │
  │                                    │<────────────────────────────────│
  │                                    │ 6. 建租户目录 / 复用工作区        │
  │                                    │    缓存 token → 租户             │
  │ 7. { code:0, data:{user,...} }     │                                 │
  │<───────────────────────────────────│                                 │
  │ 8. 启动 UI；此后每个 /api 请求带      │                                 │
  │    X-DSH-Token 头                  │                                 │
  │───────────────────────────────────>│ 9. 查缓存 → 定租户 → 处理请求     │
```

关键点：

- Token **只用于身份识别**，Harness 不在本地存储 token 明文（缓存的是
  `token 摘要 → 租户` 映射），也不写入 cookie。
- 每个 `/api` 请求都必须携带 token；Harness 用它确定「这条请求属于哪个租户」，
  进而决定用哪个 `sessions/`、`storages/`、`.credentials.yaml`。
- Token 校验结果带 TTL 缓存，避免每个请求都打后端。

---

## 2. 上游认证接口（公司后端提供）

### `POST {AUTH_ENDPOINT}`

由 Harness 服务端调用（**不是浏览器直连**），因此无跨域要求。

**请求**

```http
POST /auth HTTP/1.1
Host: abc.com
Content-Type: application/json

{
  "token": "1a2b3c4d5e6f"
}
```

**响应 200（校验通过）**

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "userId": "u_10086",
    "username": "zhangsan",
    "displayName": "张三",
    "email": "zhangsan@abc.com",
    "avatar": "https://abc.com/avatar/zs.png",
    "expiresAt": 1798761600000,
    "models": {
      "provider": "deepseek",
      "baseURL": "https://api.deepseek.com/anthropic",
      "apiKey": "sk-xxxxxxxxxxxxxxxx",
      "model": "deepseek-chat",
      "thinking": "enabled",
      "reasoningEffort": "high",
      "maxTokens": 8192
    }
  }
}
```

**响应 401（token 无效 / 过期）**

```json
{
  "code": 401,
  "msg": "token 无效或已过期",
  "data": null
}
```

### 字段说明

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `data.userId` | 是 | string \| number | 用户稳定唯一 ID。字符串或数字都接受（数字按十进制转成字符串）。仅用于日志与审计，**不参与路径拼接**。 |
| `data.username` | 是 | string | **工作区文件夹名**。只允许 `[A-Za-z0-9_-]`，长度 1–64。Harness 会做二次校验并拒绝非法值（防路径穿越）。 |
| `data.displayName` | 否 | string | 界面展示名。缺省时回落为 `username`。 |
| `data.email` | 否 | string | 仅展示。 |
| `data.avatar` | 否 | string | 仅展示。 |
| `data.expiresAt` | 否 | number | Token 绝对过期时间（Unix 毫秒）。给出后 Harness 在此时刻强制重新校验；缺省则只依赖本地 TTL 缓存。 |
| `data.models` | 否 | object | 该用户的模型配置。给出后 Harness 写入该租户的 `.credentials.yaml` 并即刻生效。 |
| `data.models.provider` | 否 | string | 默认 `deepseek`。 |
| `data.models.baseURL` | 否 | string | Provider 端点。缺省走 Harness 默认。 |
| `data.models.apiKey` | 否 | string | API Key。**必填**，否则该用户无法对话。 |
| `data.models.model` | 否 | string | 默认模型 id。 |
| `data.models.thinking` | 否 | `enabled` \| `disabled` | 思考模式。 |
| `data.models.reasoningEffort` | 否 | `off` \| `low` \| `high` \| `max` | 推理强度。 |
| `data.models.maxTokens` | 否 | number | 单次输出上限。 |

> **`username` 是隔离边界**。同一个 `username` 永远映射到同一个工作区与同一份历史记录；
> 改 `username` 等价于换了一个全新用户。后端必须保证它稳定且唯一。

---

## 3. Harness 侧接口

以下接口都挂在 `/api` 前缀下。`/api/tenant/*` 属于**公开路径**，不经过租户校验
（它本身就是用来建立身份的）；其余 `/api/*` 一律要求 `X-DSH-Token`。

响应统一为 `{ "code": number, "msg": string, "data": object | null }`：
`code === 0` 表示成功，非 0 时 `msg` 为可直接展示给用户的文案。

### 3.1 `POST /api/tenant/session`

建立身份。页面启动后调用一次；token 变化时重新调用。

**请求**

```http
POST /api/tenant/session HTTP/1.1
Content-Type: application/json

{ "token": "1a2b3c4d5e6f" }
```

**响应 200**

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "user": {
      "userId": "u_10086",
      "username": "zhangsan",
      "displayName": "张三",
      "email": "zhangsan@abc.com",
      "avatar": "https://abc.com/avatar/zs.png"
    },
    "workspace": {
      "id": "0f8a1c2e-...",
      "path": "<DSH_HOME>/tenants/zhangsan/workspace",
      "created": true
    },
    "models": {
      "provider": "deepseek",
      "model": "deepseek-chat"
    },
    "expiresAt": 1798761600000
  }
}
```

| 字段 | 说明 |
|---|---|
| `data.user` | 归一化后的用户信息，可直接用于界面展示。 |
| `data.workspace.id` | 该租户唯一工作区的 ID。首次登录创建，之后复用。 |
| `data.workspace.path` | 工作区绝对路径。前端只展示，不参与任何请求参数。 |
| `data.workspace.created` | 本次是否新创建（用于首次登录的欢迎态）。 |
| `data.models` | 实际生效的模型配置（**不含 apiKey**）。 |
| `data.expiresAt` | 会话过期时间（Unix 毫秒），前端据此提前重新登录。 |

**响应 401**

```json
{ "code": 401, "msg": "token 无效或已过期", "data": null }
```

前端收到 401 时应清除本地 token 并回到「未授权」页。

**响应 502**（上游不可达 / 上游返回异常）

```json
{ "code": 502, "msg": "认证服务暂时不可用，请稍后重试", "data": null }
```

### 3.2 `GET /api/tenant/me`

读取当前身份，用于刷新页面后的快速恢复（命中缓存时不回源上游）。

**请求头**

```http
X-DSH-Token: 1a2b3c4d5e6f
```

**响应 200 / 401** 同 3.1。

### 3.3 `GET /api/tenant/files/download`

下载工作区内的单个文件（右侧栏「工作区文件」条目的下载按钮使用）。

**请求**

```http
GET /api/tenant/files/download?path=docs/report.md HTTP/1.1
X-DSH-Token: 1a2b3c4d5e6f
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `path` | 是 | **相对工作区根**的路径，URL 编码。必须是文件，不能是目录。 |

**响应 200**

```
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="report.md"; filename*=UTF-8''report.md
Content-Length: 12345
```

**错误**

| 状态 | code | 说明 |
|---|---|---|
| 400 | 400 | `path` 缺失、为空、含 `..`、或解析后越出工作区根 |
| 404 | 404 | 文件不存在或不是普通文件 |
| 401 | 401 | 无有效 token |

> 路径校验必须基于「网络路径分隔符归一化后是否仍在工作区根之下」，
> 而不是字符串前缀比较，防 `..` 与符号链接逃逸。

### 3.4 通用鉴权头

所有非 `/api/tenant/*` 的 `/api` 请求（含 RPC 与文件下载）都必须带：

```http
X-DSH-Token: 1a2b3c4d5e6f
```

WebSocket（`/api/remote.mux`）无法自定义请求头，改用查询参数：

```
ws://<host>/api/remote.mux?token=1a2b3c4d5e6f
```

缺失或不匹配 → `401`；`Host` 不在信任列表 → `403`。

### 3.5 错误码汇总

| code | HTTP | 含义 |
|---|---|---|
| 0 | 200 | 成功 |
| 400 | 400 | 请求参数非法 |
| 401 | 401 | 未携带 token / token 无效或过期 |
| 403 | 403 | Host 不在信任列表（连接层栅栏） |
| 404 | 404 | 资源不存在 |
| 502 | 502 | 上游认证服务不可用 |
| 500 | 500 | Harness 内部错误 |

---

## 4. 前端 token 生命周期

1. **入口**：页面 URL 形如 `https://<host>/?token=1a2b3c4d5e6f`。
2. **读取**：`new URLSearchParams(location.search).get('token')`。
3. **落盘**：写入 `localStorage['dsh.token']`，随后用 `history.replaceState`
   把 token 从地址栏抹掉（避免泄露到截图、代理日志、Referer）。
4. **回退**：URL 无 token 时读 `localStorage['dsh.token']`。
5. **都没有** → 渲染「未授权」页，提示「请通过公司入口访问」，不启动 UI。
6. **换取身份**：调 `POST /api/tenant/session`；成功后把用户信息存内存
   （可选地缓存到 `sessionStorage` 用于首屏加速，但**不作为鉴权依据**）。
7. **携带**：此后所有 RPC 请求注入 `X-DSH-Token`；WebSocket 连接把 token
   放进 query。
8. **失效**：任一请求返回 `401` → 清 `localStorage` 与内存状态 → 回到步骤 5。

> Harness 从不信任前端自报的身份。`username` 一律来自服务端调用
> `{AUTH_ENDPOINT}` 的返回结果，前端无法通过篡改本地存储冒充他人。

---

## 5. 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_TENANT_VERIFY` | 未设置（= 开启校验） | 设为 `0` 时 token 直接当作用户名，**不**调上游。仅限本地开发：仍然按目录隔离，但任何能访问端口的人都能声称任意用户名。 |
| `DSH_TENANT_ROOT` / `root` 配置 | `$DSH_HOME/tenants` | 租户数据根目录。 |
| `DSH_AUTH_ENDPOINT` | `https://admin.longtongjiyun.com/v1/api/notify/harnessAuth` | 上游认证接口地址。 |
| `DSH_AUTH_CACHE_SECONDS` | `300` | token 校验结果缓存时长。 |
| `DSH_TRUSTED_HOSTS` | 空 | 逗号分隔的对外域名（如 `dsh.company.com`）。**反代部署必须配**：`/api` 的 Host 栅栏会拒绝所有未声明的 Host，返回 403。 |

对应目录布局：

```
$DSH_HOME/tenants/<username>/
├── sessions/          # 会话历史（JSONL）
├── storages/          # workspace.json 等持久化文档
├── .credentials.yaml  # 该用户的模型凭据
└── workspace/         # 该用户的工作区根（= 会话 cwd）
```

> `DSH_TRUSTED_HOSTS` 必须写反代对外暴露的那个 authority（`host` 或 `host:port`），
> 不是你键入的 IP。栅栏只做 confused-deputy 防御，不是认证层，但缺了它所有请求都会 403。
