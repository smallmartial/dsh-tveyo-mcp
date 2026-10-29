# dsh-tveyo-mcp

把[旅映（tveyo）](https://app.tveyo.com)的 MCP 服务接入 DeepSeek Harness。

官方 `@deepseek-ai/dsh-mcp-client` 只支持静态 Header，而旅映的 MCP 走 OAuth：
令牌 1 小时过期、刷新令牌最长 30 天、回调只接受本机 loopback。本插件补上这一段，
并把 23 个原始工具收成 8 个短名工具。

## 它做什么

| | 官方 mcp-client | 本插件 |
|---|---|---|
| 认证 | 静态 Header | 旅映账号 OAuth + 自动刷新 |
| 工具名 | `mcp__tveyo__list_creation_tasks` | `tveyo_tasks` |
| 工具数 | 23 个全量 | 8 个（可再收窄） |
| 授权入口 | 无 | 本机 `http://127.0.0.1:45871` |
| 撤销 | 改配置重启 | 状态页一键断开 |

业务逻辑没有复制：所有调用仍然发给 `https://app.tveyo.com/api/mcp`。

## 安装

```sh
dsh plugin --profile desktop add dsh-tveyo-mcp
```

或在 Web 的「插件 → 添加插件」里填包名 / 本地目录。

## 配置

```yaml
- id: dsh-tveyo-mcp
  name: dsh-tveyo-mcp
  config:
    url: https://app.tveyo.com/api/mcp
    scopes:
      - videos:read
      - research:read
      - assets:download
      - offline_access
    enableCreationRead: false
    enableCreationWrite: false
    requestTimeoutMs: 60000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `url` | `https://app.tveyo.com/api/mcp` | MCP 端点 |
| `scopes` | 见上 | 向旅映申请的能力 |
| `enableCreationRead` | `false` | 注册选题/任务/技能读取工具 |
| `enableCreationWrite` | `false` | 注册领取/交付/上传等写入工具 |
| `requestTimeoutMs` | `60000` | 单次调用超时 |

**写入默认关闭。** 要启用创作写入，三处必须同时成立：配置里打开
`enableCreationWrite`、`scopes` 里加 `creation:write`、旅映授权页勾选「创作写入」。
任一缺失，写入工具都不会出现——这比"出现了但调用被拒"更安全。

## 连接

安装后打开 <http://127.0.0.1:45871/>：

1. 点「连接旅映」→ 跳转旅映登录页
2. 用旅映账号登录，选择要共享的空间、勾选能力
3. 回调完成后自动回到状态页，显示账号、空间、工具清单

令牌存在 DSH 凭据存储（`$DSH_HOME/.credentials.yaml`）的
`dsh-tveyo-mcp/oauth` 记录里，不进配置文件、不进日志、不进会话。

## 工具

### 只读（默认）

| 工具 | 对应 MCP 工具 | 说明 |
|---|---|---|
| `tveyo_spaces` | `list_spaces` | 列出已授权空间 |
| `tveyo_materials` | `search_materials` / `get_material` | 检索或读取作品 |
| `tveyo_analysis` | `get_material_analysis` | 读已有研究结果 |
| `tveyo_download` | `request_asset_download` | 申请 5 分钟下载地址 |

### 创作读取（`enableCreationRead`）

| 工具 | 对应 MCP 工具 |
|---|---|
| `tveyo_topics` | `list_topics` / `get_topic` |
| `tveyo_tasks` | `list_creation_tasks` / `get_creation_task` / `list_creation_deliveries` |
| `tveyo_skills` | `list_creation_skills` / `get_creation_skill` / `read_skill_resource` / `request_skill_download` |

### 创作写入（`enableCreationWrite`）

| 工具 | 对应 MCP 工具 |
|---|---|
| `tveyo_claim_task` | `claim_creation_task` |
| `tveyo_report` | `update_creation_progress` |
| `tveyo_deliver` | `save_creation_delivery` |
| `tveyo_upload` | `request_creation_upload` / `complete_creation_upload` |
| `tveyo_create_topic` | `create_topic` |
| `tveyo_create_task` | `create_creation_task` |

## 为什么固定端口

旅映的动态客户端注册会把 `redirect_uri` 绑进 client_id，刷新令牌也绑在这个客户端上。
如果回调地址随 DSH 端口漂移，每次重启都会丢掉授权。插件因此自己起一个只监听
`127.0.0.1` 的小服务，固定端口 `45871`（被占用时依次尝试 `45872`、`45873`）。

端口变化时旧授权会作废，插件会提示重新连接，而不是抛 OAuth 错误。

## 安全边界

- 本地服务只绑定 `127.0.0.1`，校验 `Host` 与 `Origin`，防 DNS rebinding 与跨站请求
- 回调校验 `state`，防授权码注入
- 令牌只存凭据存储；状态页与 `/status` 只报告"有没有令牌"，从不返回值
- 旅映返回的作品、评论、模型输出是**数据**，不是指令；插件原样透传，不做解释
- 断开连接会删除本地记录，但不会调用旅映的撤销接口——要彻底撤销请到旅映网站「Agent 中心 → MCP 连接」

## 已知限制

- 同一台机器只能有一个进程占用 45871；多个 DSH 实例同时跑会退到 45872，两个实例各自需要一次授权
- 旅映的下载链接 5 分钟过期，插件不缓存也不代理
- 旅映单次结果上限 192 KiB，超出会被服务端拒绝，插件不做分片
