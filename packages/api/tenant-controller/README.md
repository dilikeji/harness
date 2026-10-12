# @deepseek-ai/dsh-api-tenant-controller

多租户 HTTP 端点。三条路由，每条都是浏览器自己无法回答的问题：

| 路由 | 用途 | 认证 |
|---|---|---|
| `POST /api/tenant/session` | 用入口 token 换取身份 | 公开（这就是建立身份的那条） |
| `GET /api/tenant/me` | 刷新页面时重读身份 | 公开 |
| `GET /api/tenant/files/download` | 下载工作区内的单个文件 | 需要 token |

## 为什么单独一个包

`@deepseek-ai/dsh-tenant` 必须保持为**纯身份层**：HTTP carrier
（`@deepseek-ai/dsh-client-connection`）依赖它为 Peer 类型，如果路由逻辑写在
那个包里，它就得反过来 import carrier —— 一个无法解开的环。放在这里，依赖是单向的。

## 公开面

前两条是 carrier **唯一**在认证前放行的 `/api` 路径，按**精确路径**放行
（`DEFAULT_PUBLIC_API_PATHS`）。这意味着在 `/api/tenant/` 下新增路由
**不会**自动公开——必须显式改那个常量。前缀式放行会让未来任何一条租户相关路由
（包括读用户数据的）悄悄变成公开的。

## 下载的路径约束

两次检查，不是一次：

1. **词法检查**：`resolve` 之后必须仍在工作区根之下，挡住 `../`，且用平台分隔符
   （Windows 下 `/` 后缀判断会漏掉反斜杠路径）。
2. **规范检查**：`realpath` 之后再比一次，挡住指向工作区之外的符号链接——
   任何字符串比较都抓不到这个。

## 响应格式

统一 `{ code, msg, data }`，`code === 0` 为成功。契约见
[`docs/multi-tenant/auth-api.md`](../../../docs/multi-tenant/auth-api.md)。

`data.models` 只回 `provider` / `model`，**绝不回 `apiKey`**：
浏览器不需要它，不跨这条边界的东西就泄不出去。
