# DeepSeek Harness 多租户改造方案

把单用户 Harness 改造成「单进程 + 多租户」，供公司内部使用：每个人的对话历史、
工作区、模型凭据互相隔离，不需要为每人起一个进程。

- 接口契约见 [auth-api.md](./auth-api.md)
- 改造原则：**在原代码上改造，不做新插件包**（租户服务本身除外，它是新增的基础设施包）

---

## 1. 为什么单进程可以做隔离

Harness 是一个 Cordis 插件框架应用。隔离只需要解决两件事：

1. **身份**：这条请求是谁发来的？
2. **数据根**：这个人的数据放在哪个目录下？

现状是两者都被焊死成单用户：

| 位置                                                       | 现状                                                  | 问题                |
| -------------------------------------------------------- | --------------------------------------------------- | ----------------- |
| `packages/client/connection/src/browser-auth.ts`         | `?token=` 换 `HttpOnly` cookie，之后所有请求等价于同一个 operator | 只能有一个用户           |
| `packages/client/connection/src/rpc-host.ts:81`          | `this.operator = new OperatorPeer(ctx)` 单例          | 所有请求都是「同一个人」      |
| `packages/bundle/base/cordis.patch.yml:133`              | `root: dshHomePath('sessions')`                     | 会话历史全局一份          |
| `packages/bundle/base/cordis.patch.yml:171`              | `root: dshHomePath('storages')`                     | workspace 注册表全局一份 |
| `packages/credentials/credentials-local/src/index.ts:90` | `$DSH_HOME/.credentials.yaml`                       | 模型 key 全局一份       |
| `packages/api/session-controller/src/commands.ts:119`    | `defaultCwd` 全局                                     | 工作区全局一个           |

好消息是：**模型 key 的解析链路天然可复用**。`llm-deepseek-api-key` 调的是
`ctx.credentials.resolve(apiKeyEnv)`，只要凭据服务能按租户返回不同的文件，
key 隔离就自动成立，**LLM 适配器一行都不用改**。

---

## 2. 目标架构

分两层：

```
┌─────────────────────── 控制平面（进程内全局共享一份） ───────────────────────┐
│  host/webserver      HTTP 服务、静态资源、路由                              │
│  client/connection   鉴权栅栏、/api 通道、AL S 上下文建立                    │
│  api/gateway         Remote RPC 与 WS 流分发                                │
│  llm/*               模型适配器（provider 无关）                             │
└───────────────────────────────────────────────────────────────────────────┘
                                    │  按请求解析出租户
                                    ▼
┌─────────────────────── 数据平面（按租户切根） ──────────────────────────────┐
│  session-persistence-jsonl   →  <tenants>/<user>/sessions                    │
│  storage-json                →  <tenants>/<user>/storages                    │
│  credentials-local           →  <tenants>/<user>/.credentials.yaml           │
│  spill-local                 →  <tenants>/<user>/spill                       │
│  workspace registry          →  工作区唯一且固定为 <tenants>/<user>/workspace │
└───────────────────────────────────────────────────────────────────────────┘
```

### 2.1 租户上下文：复用现有 ALS 范式

不需要发明新机制。`packages/core/agent/src/index.ts:248` 已经用
`AsyncLocalStorage` 维护「当前 Agent」，并且 `withInitiator()` 明确包裹
**agent 的完整前台生命周期**。

租户上下文用同样的做法，并挂在同一条链上：

```
HTTP 请求进入
  └─ connection.admit(req)           解析 X-DSH-Token → Tenant
      └─ tenantContext.run(tenant, …)  ← 租户 ALS 从这里开始
          └─ bridge → gateway → session.prompt
              └─ agents.withInitiator(agent, …)   ← 已存在的边界
                  └─ agent 整个 turn（含 LLM 调用）
                      └─ credentials.resolve(ref)   ← 此时 ALS 里仍有租户 ✓
```

因此 `credentials.resolve` 这类「签名里没有会话信息」的调用也能拿到租户。

需要**显式重入**的边界（这些会脱离请求栈）：

- WebSocket 长连接：建连时绑定租户，每条消息处理前 `run()`
- 后台任务（schedule / jobs）：创建时记录租户，恢复执行时 `run()`
- 子 agent 委派：从父 agent 继承

### 2.2 目录布局

```
$DSH_HOME/
├── profiles/                      # 全局：profile 模板与 patch
├── cache/                         # 全局：缓存
└── tenants/
    ├── zhangsan/
    │   ├── sessions/              # 会话历史（JSONL，zstd）
    │   │   └── --<cwd-slug>--/<sessionId>/v4.jsonl.zstd
    │   ├── storages/
    │   │   ├── workspace.json     # 该用户的工作区注册表
    │   │   └── session_projcache.json
    │   ├── .credentials.yaml      # 该用户的模型 key
    │   ├── spill/                 # 大文本溢出
    │   └── workspace/             # 工作区根（= 会话 cwd）
    └── lisi/
        └── …
```

工作区与租户数据同根（已确认），运维只需备份 `DSH_HOME` 一个目录。

---

## 3. 改造清单

### 3.1 新增包 `packages/tenant/tenant/`

`@deepseek-ai/dsh-tenant`，提供三个服务：

| 服务                  | 职责                                                   |
| ------------------- | ---------------------------------------------------- |
| `ctx.tenants`       | 租户注册表：token → 租户解析（带 TTL 缓存）、目录创建、会话 → 租户索引          |
| `ctx.tenantContext` | AsyncLocalStorage 封装：`run(tenant, op)` / `current()` |
| `ctx.tenantPaths`   | `root(segment)` —— 按当前租户解析数据根，无租户时回落全局配置             |

关键接口（草案）：

```ts
interface Tenant {
  readonly id: string          // internal id（= username 的规范化形式）
  readonly username: string    // 工作区文件夹名
  readonly userId: string
  readonly displayName: string
  readonly home: string        // <DSH_HOME>/tenants/<username>
  readonly workspace: string   // <home>/workspace
}

interface TenantRegistry {
  /** 用 token 换租户；命中缓存直接返回，未命中回源 AUTH_ENDPOINT。 */
  resolve(token: string): Promise<Tenant | undefined>
  /** 建立目录、复用/创建唯一工作区、写入模型凭据。 */
  ensure(user: AuthUser): Promise<{ tenant: Tenant; workspaceCreated: boolean }>
  /** 会话 → 租户，供脱离请求栈的后台任务使用。 */
  tenantOfSession(sessionId: SessionId): Tenant | undefined
  /** 当前请求/执行链所属租户。 */
  current(): Tenant | undefined
}
```

### 3.2 认证链路

| 文件                                                 | 改动                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/client/connection/src/browser-auth.ts`   | 删除 cookie 铸造与校验；`isAuthenticated` → `identify(request)`，从 `X-DSH-Token` 头 / WS query 取 token |
| `packages/client/connection/src/rpc-host.ts`       | `admit()` 返回携带租户的 Peer；新增公开路径判定；`OperatorPeer` → `TenantPeer`（一个租户一个 Peer 实例，缓存复用）           |
| `packages/client/connection/src/index.ts`          | `/api` handler：公开路径直接放行 → 否则 admit → `tenantContext.run()` 包裹桥接                              |
| `packages/client/connection/src/client/rpc.ts`     | 统一 fetch 注入 `X-DSH-Token`                                                                    |
| `packages/api/gateway/src/client/stream-client.ts` | WS URL 追加 `?token=`                                                                          |
| `packages/host/frontend-static/src/index.ts`       | index 不再要求鉴权（前端自己做认证门）                                                                       |

### 3.3 数据根隔离

四个插件的 root 从「构造时解析一次」改成「按租户解析」：

| 包                                            | 改动                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `packages/session/session-persistence-jsonl` | `private root` → `get root()`，内部走 `ctx.tenantPaths.root('sessions')` |
| `packages/storage/storage-json`              | 同上，`'storages'`                                                      |
| `packages/credentials/credentials-local`     | `resolveSpec()` 的 path 按租户解析；写入与热重载同步跟随                              |
| `packages/spill/spill-local`                 | `'spill'`（可后置）                                                       |

> 注意 `session-persistence-jsonl` 内部有 `this.root` 的 20+ 处引用，
> 改成 getter 后需检查是否有「跨租户复用 handle」的缓存（`locate()` / `acquireLease()`）。
> 会话句柄缓存的 key 必须包含租户，否则 A 用户的会话会被 B 用户复用。

### 3.4 工作区锁定

| 文件                                                           | 改动                                              |
| ------------------------------------------------------------ | ----------------------------------------------- |
| `packages/api/workspace-controller/src/default-workspace.ts` | 首次登录 `ensure()` 时创建/复用唯一工作区                     |
| `packages/api/workspace-controller/src/commands.ts`          | 禁用 `create` / `delete` / `insertBefore` / 目录选择器 |
| `packages/api/session-controller/src/commands.ts:119`        | `defaultCwd` 改为「当前租户的工作区」                       |
| `packages/client/ui-workspace`                               | 隐藏工作区切换入口，只渲染锁定标题                               |

### 3.5 UI 精简

| 包                                                                                  | 改动                                                                   |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/client/ui-sidebar-terminal`                                              | **整包从 profile 移除**：终端 tab 类型、Guide 卡片（「新建终端」）、终端快捷键。AI 的 shell 工具保留。 |
| `packages/client/ui-sidebar-files`                                                 | 只保留「工作区文件」；每个文件行加下载按钮 → `GET /api/tenant/files/download?path=`       |
| `packages/client/ui-settings-general`                                              | 设置面板只保留「权限模式」一节                                                      |
| `packages/client/ui-settings-account` / `-models` / `-plugins` / `ui-agent-preset` | 从 profile 移除对应 section 注册                                            |
| `packages/client/ui-permission-presets`                                            | 默认钉死 `danger-full-access` + `never`；隐藏选择器与风险确认弹窗                     |

### 3.6 配置

| 文件                                              | 改动                                    |
| ----------------------------------------------- | ------------------------------------- |
| `packages/bundle/base/cordis.patch.yml:229,245` | 权限默认改为 `danger-full-access` / `never` |
| `packages/bundle/base/cordis.patch.yml`         | 新增 `dsh-tenant` 行，挂到 base 上           |
| `packages/bundle/web-app/cordis.patch.yml`      | 多租户开关、公开路径、`trustedHosts`             |
| 新增 `docs/multi-tenant/*`                        | 本文档与接口契约                              |

### 3.7 前端认证门

| 文件                                               | 改动                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `apps/web/src/main.ts`                           | `AppWebEntry.run()` 之前插入认证阶段：读 token → `POST /api/tenant/session` → 存 localStorage → 再启动 UI |
| 新增 `packages/client/tenant-gate`（或并入 `apps/web`） | 「未授权」页、加载态、401 统一处理                                                                         |

---

## 4. 实施阶段

| 阶段    | 内容                       | 可验证结果                                            |
| ----- | ------------------------ | ------------------------------------------------ |
| **一** | 租户服务包 + 认证链路改造 + 前端认证门   | 两个不同 token 能拿到两份不同的用户信息；未带 token 的 `/api` 返回 401 |
| **二** | 四个数据根按租户切换 + 工作区创建与锁定    | A、B 两个用户的会话列表、工作区文件、模型 key 互不可见                  |
| **三** | UI 精简（终端 / 文件 / 设置 / 权限） | 界面上没有终端入口与设置冗余项；权限固定为完全权限                        |
| **四** | 收尾：单测、文档、门禁对齐            | `pnpm run typecheck` 通过；关键路径有测试                  |

每阶段独立可用，阶段一结束后即使阶段二没做，功能也是「能登录但数据还没隔离」，不会中断。

---

## 5. 风险与取舍

需要提前明确的几件事：

1. **`0.0.0.0` 仍被禁用**。`packages/bundle/web-app/src/startup.ts:85` 明确拒绝
   对外监听。多人使用时至少要让同事能访问，需要放开这个限制——**这是一处安全性取舍**，
   建议只在公司内网使用，并保留 `trustedHosts` 白名单。
2. **上游门禁会被打破**。这个仓库有 per-file 100% 覆盖率、`doc-sync`、
   `verify-persistence-changes` 等严格门禁。核心包改造必然波及这些检查。
   建议放弃「对齐上游门禁」，把它当作**私有 fork**维护，只保证
   `typecheck` 通过 + 关键路径有测试。否则改造成本会翻几倍。
3. **持久化格式不动**。租户隔离只改「根目录」，「文件内部格式」保持
   `SESSION_FORMAT_VERSION = 4` 不变。这样不存在迁移问题，也不违反
   `AGENTS.md` 里「已发布的 session 世代不可移动/覆盖/删除」的约束。
4. **agent 后台任务需要显式重入租户上下文**（schedule / jobs / 子 agent）。
   这是最容易漏的地方：表现是「后台跑的任务把文件写到了错误的租户目录」。
   阶段二需要专门覆盖这条路径的测试。
5. **token 明文不进日志**。启动 URL 与请求头都含 token，
   日志/报错里必须脱敏（现有代码已有「启动 URL 视为敏感输出」的约定，
   需要延续到新的 token 链路）。

---

## 6. 与上游的关系

这是**私有 fork**。上游 `@deepseek-ai/dsh-*` 后续更新会与本次改造冲突，
冲突集中在：

- `packages/client/connection/src/browser-auth.ts`（整文件重写）
- `packages/client/connection/src/rpc-host.ts`（admit 语义变化）
- 四个数据根插件的 root 解析
- UI 侧被移除的几个包

每处改动都用注释写明了它为什么在那里、替换掉了什么上游行为。

---

## 7. 实施进度

### 已完成：阶段一（认证链路）

**新增包**

| 包                                | 内容                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `packages/tenant/tenant`         | `ctx.tenantPaths`（环境租户 + 数据根解析）、`ctx.tenants`（token→租户、建目录、写模型 key、TTL 缓存）       |
| `packages/api/tenant-controller` | `POST /api/tenant/session`、`GET /api/tenant/me`、`GET /api/tenant/files/download` |

**改造的文件**

| 文件                                                      | 改动                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/client/connection/src/browser-auth.ts`        | cookie 铸造与校验全部移除；**保留类与签名**（10+ 个测试和包引用它），语义变成「token 能出现在哪」+「index 公开」 |
| `packages/client/connection/src/tenant-token.ts`        | 新增：token 提取。header 是常用形式，query 仅在显式传入 URL 时被接受（WS 升级专用）                |
| `packages/client/connection/src/tenant-peer.ts`         | 新增：每个租户一个 Peer 与一个 scope —— 事件分发、审批、流订阅因此天然隔离                          |
| `packages/client/connection/src/rpc-host.ts`            | `admit` 按 token 解析租户；公开路径按**精确路径**放行；`runWithPeer` 安装环境租户              |
| `packages/client/connection/src/index.ts`               | `/api` handler 区分公开路径；桥接被 `runWithPeer` 包裹                             |
| `packages/client/connection/src/client/tenant-token.ts` | 新增：localStorage 存取，内存副本优先（storage 被禁也能工作）                              |
| `packages/client/connection/src/client/rpc.ts`          | 每个 RPC 请求注入 `x-dsh-token`                                              |
| `packages/api/gateway/src/index.ts`                     | WS 升级按 query 取 token；RPC 分发与 stream 逐项按 Peer 重装租户                      |
| `packages/api/gateway/src/client/stream-client.ts`      | WS URL 带 token                                                         |
| `apps/web/src/tenant-gate.ts`                           | 新增：启动前认证门（URL token → localStorage → 换身份 → 才启动 UI）                     |
| `apps/web/src/main.ts`                                  | 认证先行；未通过不启动 shell，门自己渲染提示页                                             |

> `frontend-static` **不需要改**：它走 `authorizeIndex`，而那个方法现在恒真，index 自然公开。

**配置**

- 路径映射与 references：`tsconfig.base.json`、`tsconfig.host.json`、connection 的两个 tsconfig
- base bundle 挂 `tenant` 行（`DSH_TENANT_VERIFY` / `DSH_AUTH_ENDPOINT` / `DSH_AUTH_CACHE_SECONDS`）


- web-app bundle 挂 `tenant-controller` 行，`trustedHosts` 支持 `DSH_TRUSTED_HOSTS`

### 已完成：阶段二（数据隔离）

| 文件 | 改动 |
|---|---|
| `packages/session/session-persistence-jsonl/src/index.ts` | `root` 字段 → getter，按环境租户解析 `sessions/` |
| `packages/storage/storage-json/src/index.ts` | root 改为 `() => string`；**unit 句柄缓存的 key 从「unit 名字」改成「解析后的 root + 名字」**——否则 B 租户会拿到 A 打开的工作区句柄 |
| `packages/credentials/credentials-local/src/index.ts` | `text`/`values`/`records`/`operations` 四个单文档状态提取成 `DocumentState`，按文档路径分表；`filename` 按租户解析；新增 `shadowingInherited`——租户上下文里**继承的环境变量不再压过文档** |
| `packages/spill/spill-local/src/index.ts` | root 改为 getter |
| `packages/api/session-controller/src/commands.ts` | 新增 `resolveCwd`：租户上下文中新会话的 cwd **恒为**租户工作区 |
| `packages/api/workspace-controller/src/index.ts` | `initializeDefault` 在租户上下文中直接返回租户工作区 |
| `packages/storage/storage-domain/src/index.ts` | 实例 key 从「domain 名」改成「租户 + domain 名」；新增 `warmKnown()` |
| `packages/workspace/workspace/src/index.ts` | 改成 per-tenant scope（`table`/`global`/`state`/`entities`/`headers`/`sessionPaths` 全按租户），通过 getter 暴露，原有逻辑一行未改 |
| `packages/session/session-projection-cache/src/index.ts` | 同模式（table 按租户 + `warm()`） |
| `packages/schedule/schedule/src/index.ts` | 同模式；`ScheduleRuntime` 也按租户 |
| `packages/api/tenant-controller/src/index.ts` | 新增 `warmTenantDataPlane()`，登录时预热 |

**storage domain 那一层是端到端验证时才发现的漏网**，原因比「忘了改 root」深一层：

```
packages/storage/storage-domain/src/index.ts:70
  private readonly domains = new Map<string, DomainImpl>()   ← 按 domain 名缓存，不含租户
```

`WorkspaceRegistry`、`session-projection-cache`、`schedule` 三个消费者都在
**`[Service.init]`（启动时，还没有租户）** open 一次并长期持有。而且这层是**同步句柄**：

```ts
this.table  = domain.table('workspaces')   // KvTable.get() 是同步的
this.global = domain.global                // DomainGlobal.get() 是同步的
```

同步意味着数据必须已在内存，`DomainImpl` 持有的是**解析后的内存快照**而不是路径 ——
所以「每次调用按当前租户解析根」在这一层根本不成立，只能让**每个租户各持一份实例**。

**为什么必须「预热」**：上面那些句柄是**同步**读取的（`WorkspaceRegistry.list()`、
archived/pinned getter、`KvTable.get`），同步读不可能 await 一次首次 open。
一个租户的 domain 必须在它第一个请求被服务之前就绪，而登录是唯一知道
「某个租户刚刚成立」的时刻。

**失败姿态是 fail-loud**：租户上下文里取不到自己的 scope 时**抛错**，不回落到无租户那份。
静默回落会把甲的会话/工作区喂给乙，正是这套机制要防的事。

**验证结果**（两个 token 从干净状态登录）：

```
tenants/
├── lisi/{storages/workspace.json, workspace/}
└── zhoudi/{storages/workspace.json, workspace/}
```

两份 `workspace.json` 的 `workspaceIds`、`path`、`title` 完全不同、互不重叠。

### 未完成

| 阶段 | 内容 |
|---|---|
| 三 | 移除终端面板、文件浏览器加下载按钮、设置精简、权限钉死完全权限 |
| 三 | 前端隐藏工作区创建/切换入口（后端已锁死 cwd） |
| — | `~/.dsh/storages/` 与 `~/.dsh/sessions/` 下那份**改造前的单用户数据**仍在：启动时「无租户」scope 会从旧 `sessions/` bootstrap 出一个遗留视图。租户不读写它，但可以手工清理 |
| — | schedule / goal 从定时器启动的后台续跑不继承请求栈（日常主流程不受影响） |
| — | spill 的启动清理只扫 fallback root，各租户的 spill 目录不会被自动回收 |

### 两个已知边界

1. **desktop（Electron）形态本次不支持**。`authenticatedUrl()` 现在原样返回 URL（进程启动 token 已取消），
   desktop-host 拿不到可用凭据。不影响 web 形态。
2. **`baseURL` / `model` 仍是全局配置**。只有 `apiKey` 按租户隔离（走租户凭据文档）。
   如果不同用户需要不同端点，需要另做一层——模型选择本身已支持按会话切换。
