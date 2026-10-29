/**
 * /tveyo 命令的离线测试。
 *
 * 不启动 DSH，只按 dsh-commands 的校验规则检查定义，并驱动 handler：
 *   - 本地子命令不发消息给模型；
 *   - 自由文本注入一条用户消息；
 *   - 未连接时明确拒绝而不是让模型瞎猜。
 */
import { registerTveyoCommand, COMMAND_NAME } from '../lib/command.js'

const COMMAND_NAME_RE = /^[a-z][a-z0-9_-]*$/u

function makeContext() {
  const commands = []
  return {
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    effect: (factory) => factory(),
    commandsList: commands,
  }
}

function makeInvocation(rawInput, agent) {
  return { commandId: 'c1', agent, rawInput, attachments: [], signal: new AbortController().signal }
}

const connectedState = {
  connected: true,
  state: 'ready',
  label: '已连接',
  spaces: [{ id: 's1', name: '个人空间' }, { id: 's2', name: '旅映工作团队' }],
  tools: ['tveyo_spaces', 'tveyo_materials'],
  scopes: ['videos:read', 'offline_access'],
}

const idleState = { connected: false, state: 'needs-auth', label: '需要授权', spaces: [], tools: [], scopes: [] }

function makeDeps(overrides = {}) {
  const calls = { refreshSpaces: 0, disconnect: 0, beginAuthorization: 0, followups: [] }
  const agent = {
    followup(message) {
      calls.followups.push(message)
    },
  }
  const deps = {
    async getState() {
      return overrides.state ?? connectedState
    },
    async refreshSpaces() {
      calls.refreshSpaces += 1
    },
    async disconnect() {
      calls.disconnect += 1
    },
    beginAuthorization(surface) {
      calls.beginAuthorization += 1
      calls.surface = surface
      return { started: true }
    },
    async createUserMessage() {
      return (input) => ({ ...input, role: 'user' })
    },
    ...overrides.deps,
  }
  return { deps, calls, agent }
}

async function run(rawInput, overrides) {
  const ctx = makeContext()
  const { deps, calls, agent } = makeDeps(overrides)
  registerTveyoCommand(ctx, deps)
  const definition = ctx.commandsList[0]
  const result = await definition.handler(makeInvocation(rawInput, agent))
  return { definition, result, calls }
}

/* 定义合规：dsh-commands 的 normalizeDefinition 会按这几条校验。 */
{
  const { definition } = await run('')
  if (definition.name !== COMMAND_NAME) throw new Error('命令名不匹配')
  if (!COMMAND_NAME_RE.test(definition.name)) throw new Error('命令名不符合 /^[a-z][a-z0-9_-]*$/')
  if (typeof definition.description !== 'string' || definition.description.trim() === '') {
    throw new Error('description 不能为空')
  }
  if (typeof definition.input?.hint !== 'string' || definition.input.hint.trim() === '') {
    throw new Error('input.hint 不能为空')
  }
}

/* 空参数 = 状态。 */
{
  const { result } = await run('')
  if (result.kind !== 'success') throw new Error('空参数应返回 success')
  if (!result.text.includes('已连接')) throw new Error('状态文本缺少连接状态')
  if (!result.text.includes('个人空间')) throw new Error('状态文本缺少空间名')
}

/* status / help 都本地回答，不问模型。 */
{
  const status = await run('status')
  if (status.calls.followups.length !== 0) throw new Error('status 不应注入消息')
  const help = await run('help')
  if (help.calls.followups.length !== 0) throw new Error('help 不应注入消息')
  if (!help.result.text.includes('/tveyo spaces')) throw new Error('help 文本缺少用法')
}

/* spaces 会刷新一次并列出空间。 */
{
  const { result, calls } = await run('spaces')
  if (calls.refreshSpaces !== 1) throw new Error('spaces 应刷新空间列表')
  if (!result.text.includes('旅映工作团队')) throw new Error('spaces 缺少空间名')
}

/* connect 调用授权，且不注入消息。 */
{
  const { result, calls } = await run('connect', { state: idleState })
  if (calls.beginAuthorization !== 1) throw new Error('connect 应发起授权')
  if (calls.surface !== 'command') throw new Error('connect 的 surface 应为 command')
  if (calls.followups.length !== 0) throw new Error('connect 不应注入消息')
  if (!result.text.includes('浏览器')) throw new Error('connect 提示应说明会打开浏览器')
}

/* 已连接时 connect 直接返回，不重复授权。 */
{
  const { result, calls } = await run('connect')
  if (calls.beginAuthorization !== 0) throw new Error('已连接时不应重复授权')
  if (!result.text.includes('无需重复授权')) throw new Error('已连接提示不对')
}

/* disconnect 调用断开。 */
{
  const { calls } = await run('disconnect')
  if (calls.disconnect !== 1) throw new Error('disconnect 应调用断开')
}

/* 自由文本：注入用户消息，交给模型。 */
{
  const { result, calls } = await run('帮我找上周拍的城市夜景')
  if (calls.followups.length !== 1) throw new Error('自由文本应注入一条消息')
  const text = calls.followups[0].content[0].text
  if (!text.includes('帮我找上周拍的城市夜景')) throw new Error('注入消息缺少原始请求')
  if (!text.includes('旅映')) throw new Error('注入消息应点名旅映工具')
  if (result.kind !== 'success') throw new Error('自由文本应返回 success')
}

/* 未连接时自由文本直接报错，避免模型凭空编造。 */
{
  const { result, calls } = await run('帮我找一条视频', { state: idleState })
  if (result.kind !== 'error') throw new Error('未连接时自由文本应报错')
  if (calls.followups.length !== 0) throw new Error('未连接时不应注入消息')
  if (!result.text.includes('/tveyo connect')) throw new Error('错误提示应引导去授权')
}

/* "/tveyo help 找个视频" 不应被当成 help。 */
{
  const { calls } = await run('help 找个视频')
  if (calls.followups.length !== 1) throw new Error('带参数的 help 应交给模型')
}

console.log('command ok: 8 scenarios')
