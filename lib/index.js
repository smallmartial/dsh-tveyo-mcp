/**
 * dsh-tveyo-mcp —— 把旅映（tveyo）MCP 接入 DeepSeek Harness。
 *
 * 与官方 dsh-mcp-client 的差别：
 *   1. 认证：旅映用 OAuth（PKCE + 动态注册 + 刷新令牌），不是静态 Header；
 *   2. 授权：走 DSH 原生的 ctx.authorization flow，而不是插件自建的网页；
 *   3. 呈现：把 23 个 mcp__tveyo__* 收成 13 个短名策展工具，省上下文。
 *
 * 传输仍是标准 MCP Streamable HTTP，业务逻辑一行没有复制。
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createOAuthProvider, createVolatileAuthState, revokeAtServer, CREDENTIAL_SCOPE, OAUTH_RECORD } from './oauth.js'
import { selectTools } from './catalog.js'
import { connectWithRetry, classifyConnectionError, STATE } from './connection.js'
import { startLoopbackServer, CALLBACK_PATH, requireLoopback, sendJson } from './server.js'
import { openBrowser } from './open.js'

/** Cordis 插件名。 */
export const name = 'dsh-tveyo-mcp'

/** 依赖的服务；缺任何一个就不激活，而不是带着半残状态运行。 */
export const inject = ['tools', 'credentials', 'authorization']

/** 旅映 MCP 的固定端点。 */
const DEFAULT_URL = 'https://app.tveyo.com/api/mcp'
/** 默认申请的能力：只读素材 + 研究 + 下载 + 保持连接。 */
const DEFAULT_SCOPES = ['videos:read', 'research:read', 'assets:download', 'offline_access']
/** 旅映的令牌端点，撤销也走这里。 */
const TOKEN_ENDPOINT = 'https://app.tveyo.com/oauth/token'
/** 授权等待上限：超时后放弃这次尝试，避免界面一直转圈。 */
const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000

export const Config = z.object({
  url: z.string().default(DEFAULT_URL).description('旅映 MCP 端点'),
  scopes: z
    .array(z.string())
    .default(DEFAULT_SCOPES)
    .description('向旅映申请的能力；creation:read / creation:write 需要显式加入'),
  enableCreationRead: z.boolean().default(false).description('是否注册选题/任务/技能读取工具'),
  enableCreationWrite: z.boolean().default(false).description('是否注册领取/交付/上传等写入工具'),
  requestTimeoutMs: z.number().default(60_000).description('单次 MCP 调用超时'),
  autoOpenBrowser: z.boolean().default(true).description('发起授权时自动打开系统浏览器'),
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

/** 一个可被外部 resolve 的等待点，用于把浏览器回调接回授权流程。 */
function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function apply(ctx, config) {
  // Cordis 已按 Config schema 解析默认值；这里再兜一层，便于脱离 Loader 直接挂载。
  const resolved = {
    url: DEFAULT_URL,
    scopes: DEFAULT_SCOPES,
    enableCreationRead: false,
    enableCreationWrite: false,
    requestTimeoutMs: 60_000,
    autoOpenBrowser: true,
    ...(config ?? {}),
  }
  const log = (message, error) => {
    if (error === undefined) ctx.logger.info(`[tveyo] ${message}`)
    else ctx.logger.warn(`[tveyo] ${message}`, error)
  }

  const volatileState = createVolatileAuthState()
  const credentialRecordKey = credentialKey(CREDENTIAL_SCOPE, OAUTH_RECORD)

  /** 本地回调服务；启动后才有 origin。 */
  let loopback = null
  /** 当前等待浏览器回调的 deferred；同一时刻最多一个。 */
  let pendingCallback = null
  /** 当前授权尝试的取消控制器。 */
  let attemptAbort = null

  /** 运行期状态：连接、工具集、错误。 */
  const runtime = {
    state: STATE.IDLE,
    label: '未连接',
    client: undefined,
    transport: undefined,
    tools: [],
    scopes: [],
    spaces: [],
    expiresAt: undefined,
    lastError: undefined,
    notice: undefined,
    /** 是否有一次浏览器授权正在进行（与"需要授权"是两回事）。 */
    attempting: false,
    /** 本次授权是否由卡片自己开窗发起；为 true 时 Host 不再重复打开浏览器。 */
    cardInitiated: false,
  }

  /** 一次性取消所有已注册工具。 */
  let disposeTools = () => {}

  /** 回调地址；必须与动态注册时提交的一致。 */
  function callbackUrl() {
    if (loopback === null) throw new Error('本地回调服务尚未就绪')
    return `${loopback.origin}${CALLBACK_PATH}`
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
              throw new Error('旅映尚未连接。请在插件卡片里完成授权后再试。')
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

  /** 用已有令牌建立连接；没有令牌时会走 OAuth 发现但不会打开浏览器。 */
  async function connect() {
    await closeConnection()
    const oauth = buildOAuth()
    const client = new Client({ name: 'dsh-tveyo-mcp', version: '0.2.0' }, { capabilities: {} })
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
      await closeConnection()
      if (outcome.needsAuth) {
        /* 没有令牌是正常状态，不是错误；不要在卡片上显示 Unauthorized。 */
        runtime.state = STATE.NEEDS_AUTH
        runtime.label = '需要授权'
        runtime.lastError = undefined
      } else {
        runtime.lastError = outcome.error
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
   * 走一次完整的浏览器授权。
   *
   * 由 ctx.authorization flow 调用，也可以被卡片的「重新连接」直接调用。
   * 顺序：connect 触发 401 → SDK 做发现/注册/拼授权 URL → 打开浏览器 →
   * 等本地回调 → finishAuth 换令牌 → 再 connect 一次拿到工具列表。
   */
  async function authorizeWithBrowser(session) {
    if (loopback === null) throw new Error('本地回调服务尚未就绪，请稍后重试')

    await closeConnection()
    runtime.state = STATE.NEEDS_AUTH
    runtime.label = '等待浏览器授权'
    runtime.lastError = undefined
    volatileState.clear()

    const oauth = buildOAuth()
    const client = new Client({ name: 'dsh-tveyo-mcp', version: '0.2.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(resolved.url), {
      authProvider: oauth.provider,
    })

    /* 第一次 connect 必然失败，但失败前 SDK 已经完成发现、注册并拿到授权 URL。 */
    try {
      await client.connect(transport)
      /* 已有有效令牌：无需浏览器，直接进入已连接状态。 */
      runtime.client = client
      runtime.transport = transport
      runtime.state = STATE.READY
      runtime.label = '已连接'
      registerTools(resolved.scopes)
      await refreshSpaces()
      return { alreadyAuthorized: true }
    } catch (error) {
      const verdict = classifyConnectionError(error)
      if (verdict.state !== STATE.NEEDS_AUTH) throw error
    }

    const authorizationUrl = volatileState.pendingUrl
    if (authorizationUrl === undefined) throw new Error('未能生成授权地址，请查看 Host 日志')

    const notice = { message: '请在浏览器完成旅映登录，然后回到这里', url: authorizationUrl }
    runtime.notice = notice
    session?.notify?.(notice)
    /* 卡片已经自己开了一个标签页（surface=card），Host 不再重复打开。 */
    if (resolved.autoOpenBrowser && runtime.cardInitiated !== true) {
      openBrowser(authorizationUrl, log)
    }
    runtime.cardInitiated = false

    const deferred = createDeferred()
    pendingCallback = deferred
    const timeout = setTimeout(() => {
      deferred.reject(new Error('授权超时，请重新发起'))
    }, AUTHORIZATION_TIMEOUT_MS)

    let params
    try {
      params = await Promise.race([deferred.promise, abortPromise(session?.signal)])
    } finally {
      clearTimeout(timeout)
      if (pendingCallback === deferred) pendingCallback = null
    }

    await transport.finishAuth(params)
    await transport.close()
    volatileState.clear()
    runtime.notice = undefined

    const outcome = await connect()
    if (!outcome.ok) throw new Error('授权已保存但连接失败，请稍后重试')
    runtime.notice = undefined
    return { alreadyAuthorized: false }
  }

  /** 把 AbortSignal 变成一个会 reject 的 Promise，用于取消等待。 */
  function abortPromise(signal) {
    if (signal === undefined) return new Promise(() => {})
    if (signal.aborted) return Promise.reject(new Error('已取消'))
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true })
    })
  }

  /** 旅映回调入口：校验 state 后把参数交回等待中的授权流程。 */
  async function onCallback(searchParams) {
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
    if (pendingCallback === null) {
      return { ok: false, message: '没有正在等待的授权请求，请回到 DeepSeek Harness 重新发起' }
    }
    pendingCallback.resolve(searchParams)
    return { ok: true }
  }

  /** 断开：调旅映撤销 + 删本地凭据 + 关连接 + 撤工具。 */
  async function disconnect() {
    attemptAbort?.abort()
    attemptAbort = null
    await closeConnection()

    try {
      const oauth = buildOAuth()
      const record = await oauth.readRecord()
      const refreshToken = record?.tokens?.refresh_token
      const clientId = record?.clientInformation?.client_id
      if (refreshToken !== undefined) {
        await revokeAtServer({
          token: refreshToken,
          clientId,
          tokenEndpoint: TOKEN_ENDPOINT,
          log,
        })
      }
      await oauth.clear()
    } catch (error) {
      log('清理本地授权失败', error)
    }

    disposeTools()
    disposeTools = () => {}
    runtime.tools = []
    runtime.scopes = []
    runtime.spaces = []
    runtime.expiresAt = undefined
    runtime.state = STATE.IDLE
    runtime.label = '未连接'
    runtime.notice = undefined
    runtime.attempting = false
    runtime.lastError = undefined
  }

  /** 状态快照，供插件卡片读取（绝不含令牌）。 */
  async function getState() {
    let hasCredential = false
    let expiresAt = runtime.expiresAt
    try {
      const record = loopback === null ? undefined : await buildOAuth().readRecord()
      hasCredential = record?.tokens !== undefined
      if (record?.tokens?.expires_in !== undefined && expiresAt === undefined) {
        expiresAt = Date.now() + record.tokens.expires_in * 1000
      }
    } catch {
      hasCredential = false
    }
    return {
      connected: runtime.state === STATE.READY,
      state: runtime.state,
      label: runtime.label,
      spaces: runtime.spaces,
      scopes: runtime.scopes,
      tools: runtime.tools,
      expiresAt,
      hasCredential,
      attempting: runtime.attempting,
      notice: runtime.notice,
      callbackOrigin: loopback?.origin,
      lastError:
        runtime.lastError === undefined
          ? undefined
          : String(runtime.lastError?.message ?? runtime.lastError).slice(0, 300),
    }
  }

  /* ---- 原生授权 flow ---- */

  ctx.effect(
    () =>
      ctx.authorization.registerFlow({
        key: credentialRecordKey,
        label: '旅映 (tveyo)',
        methods: [{ id: 'oauth', label: '用旅映账号登录' }],
        async run(session) {
          await authorizeWithBrowser(session)
        },
      }),
    'dsh-tveyo-mcp: 旅映授权流程',
  )

  /* ---- 生命周期 ---- */

  ctx.effect(
    () => () => {
      attemptAbort?.abort()
      void closeConnection()
      disposeTools()
      if (loopback !== null) void loopback.close()
    },
    'dsh-tveyo-mcp: 释放连接、工具与回调服务',
  )

  /* ---- 插件卡片使用的 HTTP 路由 ---- */

  ctx.inject(['webServer'], (webCtx) => {
    const disposers = []
    const base = '/plugins/dsh-tveyo-mcp'

    disposers.push(
      webCtx.webServer.register({
        kind: 'exact',
        path: `${base}/state`,
        handler: async (req, res) => {
          if (!requireLoopback(req, res)) return
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
          sendJson(res, 200, await getState())
        },
      }),
    )

    disposers.push(
      webCtx.webServer.register({
        kind: 'exact',
        path: `${base}/connect`,
        handler: async (req, res) => {
          if (!requireLoopback(req, res)) return
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
          if (ctx.authorization.describe(credentialRecordKey)?.inFlight === true) {
            return sendJson(res, 409, { error: 'already-in-flight' })
          }
          const controller = new AbortController()
          attemptAbort = controller
          runtime.attempting = true
          try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            runtime.cardInitiated = url.searchParams.get('surface') === 'card'
          } catch {
            runtime.cardInitiated = false
          }
          /* 不等待：授权要等用户在浏览器里操作，卡片靠轮询 /state 跟进。 */
          void ctx.authorization
            .begin({
              key: credentialRecordKey,
              signal: controller.signal,
              interaction: {
                notify: (notice) => {
                  runtime.notice = notice
                },
                prompt: () => Promise.reject(new Error('旅映授权不需要额外输入')),
              },
            })
            .catch((error) => {
              /* 用户主动取消不算错误，只有真正的失败才记录。 */
              const cancelled = String(error?.message ?? error).includes('取消')
              runtime.lastError = cancelled ? undefined : error
              if (runtime.state !== STATE.READY) {
                runtime.state = STATE.NEEDS_AUTH
                runtime.label = '需要授权'
                runtime.notice = undefined
              }
              log('授权流程失败', error)
            })
            .finally(() => {
              if (attemptAbort === controller) attemptAbort = null
              runtime.attempting = false
            })
          sendJson(res, 202, { started: true })
        },
      }),
    )

    disposers.push(
      webCtx.webServer.register({
        kind: 'exact',
        path: `${base}/cancel`,
        handler: async (req, res) => {
          if (!requireLoopback(req, res)) return
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
          attemptAbort?.abort()
          attemptAbort = null
          runtime.attempting = false
          if (runtime.state !== STATE.READY) {
            runtime.state = STATE.NEEDS_AUTH
            runtime.label = '需要授权'
            runtime.notice = undefined
          }
          sendJson(res, 200, { cancelled: true })
        },
      }),
    )

    disposers.push(
      webCtx.webServer.register({
        kind: 'exact',
        path: `${base}/disconnect`,
        handler: async (req, res) => {
          if (!requireLoopback(req, res)) return
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
          await disconnect()
          sendJson(res, 200, { ok: true })
        },
      }),
    )

    webCtx.effect(
      () => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 已释放 */
          }
        }
      },
      'dsh-tveyo-mcp: 插件卡片路由',
    )
  })

  /* ---- 启动 ---- */

  void (async () => {
    try {
      loopback = await startLoopbackServer({ handlers: { onCallback }, log })
      const outcome = await connect()
      if (!outcome.ok && outcome.needsAuth !== true) {
        log('启动时未能连接旅映，可在插件卡片重试')
      }
    } catch (error) {
      runtime.state = STATE.ERROR
      runtime.label = '初始化失败'
      runtime.lastError = error
      log('初始化失败', error)
    }
  })()
}
