/**
 * dsh-tveyo-mcp —— 把旅映（tveyo）MCP 接入 DeepSeek Harness。
 *
 * 与官方 dsh-mcp-client 的差别只有两点：
 *   1. 认证：旅映用 OAuth（PKCE + 动态注册 + 刷新令牌），不是静态 Header；
 *   2. 呈现：把 23 个 mcp__tveyo__* 收成 8 个短名策展工具，省上下文。
 *
 * 传输仍是标准 MCP Streamable HTTP，业务逻辑一行没有复制。
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createOAuthProvider, createVolatileAuthState } from './oauth.js'
import { selectTools } from './catalog.js'
import { connectWithRetry, classifyConnectionError, STATE } from './connection.js'
import { startLoopbackServer } from './server.js'

/** Cordis 插件名。 */
export const name = 'dsh-tveyo-mcp'

/** 依赖的服务；缺任何一个就不激活，而不是带着半残状态运行。 */
export const inject = ['tools', 'credentials']

/** 旅映 MCP 的固定端点。 */
const DEFAULT_URL = 'https://app.tveyo.com/api/mcp'
/** 默认申请的能力：只读素材 + 研究 + 下载 + 保持连接。 */
const DEFAULT_SCOPES = ['videos:read', 'research:read', 'assets:download', 'offline_access']

export const Config = z.object({
  url: z.string().default(DEFAULT_URL).description('旅映 MCP 端点'),
  scopes: z
    .array(z.string())
    .default(DEFAULT_SCOPES)
    .description('向旅映申请的能力；creation:read / creation:write 需要显式加入'),
  enableCreationRead: z.boolean().default(false).description('是否注册选题/任务/技能读取工具'),
  enableCreationWrite: z.boolean().default(false).description('是否注册领取/交付/上传等写入工具'),
  requestTimeoutMs: z.number().default(60_000).description('单次 MCP 调用超时'),
})

/**
 * 把一次 MCP tools/call 的结果摊平成工具返回值。
 *
 * MCP 的 CallToolResult 有两种载荷：
 *   - content: [{type:'text', text}]，旅映把业务 JSON 塞在这里
 *   - structuredContent: { data }，旅映同时返回结构化副本
 * 优先用 structuredContent.data（已是对象），否则尝试把 text 解析成 JSON，
 * 都失败就原样返回文本。isError 直接抛出，让 DSH 记录为失败调用。
 */
function unwrapResult(result, toolName) {
  if (result?.isError === true) {
    const text = (result.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n')
    throw new Error(`旅映工具 ${toolName} 返回错误：${text || '未知错误'}`)
  }
  const structured = result?.structuredContent
  if (structured !== undefined && structured !== null && typeof structured === 'object' && 'data' in structured) {
    return structured.data
  }
  const text = (result?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function apply(ctx, config) {
  // Cordis 已按 Config schema 解析默认值；这里再兜一层，便于脱离 Loader 直接挂载。
  const resolved = {
    url: DEFAULT_URL,
    scopes: DEFAULT_SCOPES,
    enableCreationRead: false,
    enableCreationWrite: false,
    requestTimeoutMs: 60_000,
    ...(config ?? {}),
  }
  const log = (message, error) => {
    if (error === undefined) ctx.logger.info(`[tveyo] ${message}`)
    else ctx.logger.warn(`[tveyo] ${message}`, error)
  }

  const volatileState = createVolatileAuthState()

  /** 本地授权服务；启动后才有 origin。 */
  let loopback = null

  /** 运行期状态：连接、工具集、错误。 */
  const runtime = {
    state: STATE.IDLE,
    label: '未连接',
    client: undefined,
    transport: undefined,
    tools: [],
    scopes: [],
    spaces: [],
    account: undefined,
    expiresAt: undefined,
    lastError: undefined,
  }

  /** 一次性取消所有已注册工具。 */
  let disposeTools = () => {}

  /** 回调地址；必须与动态注册时提交的一致。 */
  function callbackUrl() {
    if (loopback === null) throw new Error('本地授权服务尚未就绪')
    return `${loopback.origin}/oauth/callback`
  }

  /** 组装 OAuth 提供者；每次连接重建，保证 redirectUrl 用的是当前端口。 */
  function buildOAuth() {
    return createOAuthProvider({
      credentials: ctx.credentials,
      redirectUrl: callbackUrl(),
      scope: resolved.scopes.join(' '),
      volatileState,
      log,
    })
  }

  /** 关闭现有连接，忽略关闭期错误。 */
  async function closeConnection() {
    const transport = runtime.transport
    runtime.transport = undefined
    runtime.client = undefined
    if (transport !== undefined) {
      try {
        await transport.close()
      } catch {
        /* 已经断开 */
      }
    }
  }

  /** 清空并重注册工具。 */
  function registerTools(grantedScopes) {
    disposeTools()
    disposeTools = () => {}

    const selected = selectTools({
      grantedScopes,
      enableCreationRead: resolved.enableCreationRead,
      enableCreationWrite: resolved.enableCreationWrite,
    })
    runtime.tools = selected.map((tool) => tool.name)
    if (selected.length === 0) return

    const disposers = selected.map((tool) =>
      ctx.tools.register(
        defineTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [
              { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
            ],
          },
          async execute(args, exec) {
            if (runtime.client === undefined) {
              throw new Error('旅映尚未连接。请打开插件状态页完成授权后再试。')
            }
            const { tool: remoteName, args: remoteArgs } = tool.route(args)
            const result = await runtime.client.callTool(
              { name: remoteName, arguments: remoteArgs },
              { timeout: resolved.requestTimeoutMs, signal: exec.signal },
            )
            return unwrapResult(result, remoteName)
          },
        }),
      ),
    )
    disposeTools = () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已释放 */
        }
      }
    }
  }

  /** 从旅映读取空间列表，失败不致命（可能只授权了部分能力）。 */
  async function refreshSpaces() {
    if (runtime.client === undefined) return
    try {
      const result = await runtime.client.callTool({ name: 'list_spaces', arguments: {} })
      const data = unwrapResult(result, 'list_spaces')
      runtime.spaces = Array.isArray(data?.spaces) ? data.spaces : []
    } catch (error) {
      log('读取空间列表失败', error)
    }
  }

  /** 建立连接并同步状态。 */
  async function connect() {
    await closeConnection()
    const oauth = buildOAuth()
    const client = new Client({ name: 'dsh-tveyo-mcp', version: '0.1.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(resolved.url), {
      authProvider: oauth.provider,
    })
    runtime.client = client
    runtime.transport = transport

    const outcome = await connectWithRetry({
      connect: () => client.connect(transport),
      onState: (state, label) => {
        runtime.state = state
        runtime.label = label
      },
      log,
    })
    if (!outcome.ok) {
      runtime.lastError = outcome.error
      await closeConnection()
      if (outcome.needsAuth) {
        runtime.state = STATE.NEEDS_AUTH
        runtime.label = '需要授权'
      }
      return outcome
    }

    runtime.state = STATE.READY
    runtime.label = '已连接'
    runtime.lastError = undefined

    const record = await oauth.readRecord()
    const token = record?.tokens
    runtime.expiresAt = token?.expires_in ? Date.now() + token.expires_in * 1000 : undefined
    runtime.scopes = resolved.scopes

    registerTools(resolved.scopes)
    await refreshSpaces()
    return outcome
  }

  /**
   * 发起授权。
   *
   * 触发点故意用一次真实的 tools/list：只有服务端回 401，MCP SDK 才会走
   * 发现 → 动态注册 → 拼授权 URL 的完整流程。已经授权过的情况下这里会
   * 直接连上，不需要再弹浏览器。
   */
  async function beginAuth() {
    await closeConnection()
    const oauth = buildOAuth()
    const client = new Client({ name: 'dsh-tveyo-mcp', version: '0.1.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(resolved.url), {
      authProvider: oauth.provider,
    })
    try {
      await client.connect(transport)
      runtime.client = client
      runtime.transport = transport
      runtime.state = STATE.READY
      runtime.label = '已连接'
      registerTools(resolved.scopes)
      await refreshSpaces()
      return { url: `${loopback.origin}/` }
    } catch (error) {
      const verdict = classifyConnectionError(error)
      if (verdict.state === STATE.NEEDS_AUTH) {
        const pending = volatileState.peekPending()
        if (pending === undefined) throw new Error('未能生成授权地址，请查看 Host 日志')
        runtime.state = STATE.NEEDS_AUTH
        runtime.label = '等待授权'
        return { url: pending.url }
      }
      throw error
    }
  }

  /** 处理旅映回调：校验 state → finishAuth → 重连。 */
  async function finishAuth(searchParams) {
    const error = searchParams.get('error')
    if (error !== null) {
      return { ok: false, message: searchParams.get('error_description') ?? error }
    }
    const code = searchParams.get('code')
    if (code === null) return { ok: false, message: '回调缺少授权码' }

    const expectedState = volatileState.state
    const returnedState = searchParams.get('state')
    if (expectedState !== undefined && returnedState !== expectedState) {
      return { ok: false, message: 'state 不匹配，授权可能被伪造，请重新连接' }
    }

    const oauth = buildOAuth()
    const transport = new StreamableHTTPClientTransport(new URL(resolved.url), {
      authProvider: oauth.provider,
    })
    await transport.finishAuth(searchParams)
    await transport.close()
    volatileState.clear()

    const outcome = await connect()
    if (!outcome.ok) return { ok: false, message: '授权已保存但连接失败，请稍后重试' }
    return { ok: true }
  }

  /** 断开：删本地凭据 + 关连接 + 撤工具。 */
  async function disconnect() {
    await closeConnection()
    const oauth = buildOAuth()
    await oauth.clear()
    disposeTools()
    disposeTools = () => {}
    runtime.tools = []
    runtime.scopes = []
    runtime.spaces = []
    runtime.account = undefined
    runtime.expiresAt = undefined
    runtime.state = STATE.IDLE
    runtime.label = '未连接'
  }

  /** 状态快照，供状态页与 /status 使用（绝不含令牌）。 */
  async function getState() {
    let record
    try {
      record = loopback === null ? undefined : await buildOAuth().readRecord()
    } catch {
      record = undefined
    }
    const connected = runtime.state === STATE.READY
    return {
      connected,
      state: runtime.state,
      label: runtime.label,
      account: runtime.account,
      spaces: runtime.spaces,
      scopes: runtime.scopes,
      tools: runtime.tools,
      expiresAt: runtime.expiresAt,
      hasCredential: record?.tokens !== undefined,
      lastError:
        runtime.lastError === undefined
          ? undefined
          : String(runtime.lastError?.message ?? runtime.lastError).slice(0, 300),
    }
  }

  /* ---- 激活 ---- */

  ctx.effect(
    () => () => {
      void closeConnection()
      disposeTools()
      if (loopback !== null) void loopback.close()
    },
    'dsh-tveyo-mcp: 释放连接、工具与本地服务',
  )

  /* 本地授权服务必须先起来，redirect_uri 才能确定。 */
  void (async () => {
    try {
      loopback = await startLoopbackServer({
        handlers: { getState, beginAuth, finishAuth, disconnect },
        log,
      })
      const state = await connect()
      if (!state.ok && state.needsAuth !== true) {
        log('启动时未能连接旅映，可在授权页重试')
      }
    } catch (error) {
      runtime.state = STATE.ERROR
      runtime.label = '本地授权服务启动失败'
      runtime.lastError = error
      log('本地授权服务启动失败', error)
    }
  })()
}
