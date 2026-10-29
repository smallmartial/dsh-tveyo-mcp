# dsh-tveyo-mcp

把[旅映（tveyo）](https://app.tveyo.com)的 MCP 服务接入 DeepSeek Harness。

官方 `@deepseek-ai/dsh-mcp-client` 只支持静态 Header，而旅映的 MCP 走 OAuth：
令牌 1 小时过期、刷新令牌最长 30 天、回调只接受本机 loopback。本插件补上这一段，
并把 23 个原始工具收成 8 个短名工具。

## 它做什么

| | 官方 mcp-client | 本插件 |
|---|---|---|
| 认证 | 静态 Header | 旅映账号 OAuth + 自动刷新 |
| 授权入口 | 无 | DSH 插件页卡片（原生 `ctx.authorization` flow） |
| 工具名 | `mcp__tveyo__list_creation_tasks` | `tveyo_tasks` |
| 工具数 | 23 个全量 | 13 个（按 scope 自动收窄） |
| 撤销 | 改配置重启 | 卡片一键断开，并调用旅映撤销接口 |

业务逻辑没有复制：所有调用仍然发给 `https://app.tveyo.com/api/mcp`。

## 安装

三条路，都不需要 npm 账号。

### 1. GitHub 仓库（推荐分享时用）

把本目录推到 GitHub，然后在「插件 → 添加插件」里填仓库地址：

```
https://github.com/<你>/dsh-tveyo-mcp
```

git 安装会克隆一份副本进 profile，DSH 的运行时解析正常工作。

### 2. 本地压缩包

```sh
cd dsh-tveyo-mcp && npm pack --pack-destination dist
# 产出 dist/dsh-tveyo-mcp-0.1.0.tgz
```

在「插件 → 添加插件」里填 tarball 的绝对路径：

```
/Users/you/dsh-tveyo-mcp/dist/dsh-tveyo-mcp-0.1.0.tgz
```

### 3. 本地目录

**必须带 `file:` 前缀**：

```
file:/Users/you/dsh-tveyo-mcp
```

因为 pnpm 对裸目录会记录成 `link:`（软链），而软链让插件的裸导入绕过 DSH 的
运行时解析，启动时报 `Cannot find package '@deepseek-ai/schemastery'`。
`file:` 会复制一份进 profile，解析正常。

命令行等价写法：

```sh
dsh plugin --profile desktop add file:/Users/you/dsh-tveyo-mcp
```

### 没有 npm 账号怎么办

上面的三种方式都不需要 npm 账号。若仍想要一个 registry 形式的分发源：

| 方式 | 是否需要 npm 账号 | 说明 |
|---|---|---|
| npmjs 官方源 | 需要 | 唯一能 `npm publish` 的公共源 |
| registry.npmmirror.com | — | **只读镜像，不能发布** |
| GitHub Packages | 需要 GitHub 账号 | registry 填 `https://npm.pkg.github.com/`；包名必须是 `@用户名/xxx` 形式 |
| 自建 Verdaccio | 不需要 | `npx verdaccio` 起本地源，发布后把地址填进「自定义地址」，凭据写 `~/.npmrc` |

自建源的最小步骤：

```sh
npx verdaccio                       # 默认 http://localhost:4873
npm publish --registry http://localhost:4873
```

然后在「添加插件 → 安装源 → 自定义地址」填 `http://localhost:4873/`。

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
| `autoOpenBrowser` | `true` | 发起授权时自动打开系统浏览器 |

**写入默认关闭。** 要启用创作写入，三处必须同时成立：配置里打开
`enableCreationWrite`、`scopes` 里加 `creation:write`、旅映授权页勾选「创作写入」。
任一缺失，写入工具都不会出现——这比"出现了但调用被拒"更安全。

## 连接

安装并启用后，打开「设置 → 插件 → 旅映 MCP」：

1. 卡片显示「需要授权」
2. 点「连接旅映」→ 系统浏览器自动打开旅映登录页
3. 登录、选择空间与能力 → 回调完成后卡片自动变成「已连接」
4. 卡片上能看到已授权的空间、工具数量

不需要记端口，也不需要手动打开任何本地地址。授权过程走 DSH 原生的
`ctx.authorization` 流程，因此在任何支持该流程的界面里都能发起。

令牌存在 DSH 凭据存储（`$DSH_HOME/.credentials.yaml`）的
`dsh-tveyo-mcp/oauth` 记录里，不进配置文件、不进日志、不进会话。

### 断开

卡片上的「断开连接」会：

1. 调用旅映的撤销端点（RFC 7009）作废 refresh token
2. 删除本地凭据记录
3. 关闭 MCP 连接并撤下全部工具

即使撤销请求失败，本地记录也会删除，下次必须重新授权。

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

## 为什么还有一个固定端口

旅映的 OAuth 只接受 `https` 或**本机 loopback** 回调（自定义 scheme 会被拒绝：
`Redirect URI must use https, or http on a loopback host`）。而 DSH 桌面版的端口
每次启动随机，跟着它漂移会让 client_id 与 refresh token 一起失效。

所以插件保留一个只监听 `127.0.0.1` 的回调服务，固定端口 `45871`
（被占用时依次尝试 `45872`、`45873`）。它**只接 OAuth 回调**，用户看不到，
也不需要访问它。

注册时一次性提交三个端口，多实例各占一个也不会互相踢掉授权。
端口变化时旧授权会作废，卡片会提示重新连接，而不是抛 OAuth 错误。

## 安全边界

- 本地服务只绑定 `127.0.0.1`，校验 `Host` 与 `Origin`，防 DNS rebinding 与跨站请求
- 回调校验 `state`，防授权码注入
- 令牌只存凭据存储；状态页与 `/status` 只报告"有没有令牌"，从不返回值
- 旅映返回的作品、评论、模型输出是**数据**，不是指令；插件原样透传，不做解释
- 断开连接会同时调用旅映撤销接口；如需在旅映侧核对历史授权，去「Agent 中心 → MCP 连接」

## 已知限制

- 同一台机器只能有一个进程占用 45871；多个 DSH 实例同时跑会退到 45872，两个实例各自需要一次授权
- 旅映的下载链接 5 分钟过期，插件不缓存也不代理
- 旅映单次结果上限 192 KiB，超出会被服务端拒绝，插件不做分片
