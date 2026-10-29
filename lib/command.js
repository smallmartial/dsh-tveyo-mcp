/**
 * /tveyo 斜杠命令。
 *
 * 分两类参数：
 *   - 固定子命令（status / spaces / connect / disconnect / help）由插件直接处理，
 *     不消耗模型轮次，适合"看一眼状态"这种轻量意图；
 *   - 其余自由文本视为"让模型用旅映工具干活"，注入一条用户消息后交给 Agent。
 *
 * 为什么不把所有参数都交给模型：/tveyo status 这种查询如果也走模型，
 * 每次都要等一轮推理，既慢又费 token。
 */

/** DSL 命令名约束，与 dsh-commands 的 normalizeDefinition 一致。 */
export const COMMAND_NAME = 'tveyo'

/** 直接处理的子命令；只有整串参数就是这个单词时才命中。 */
const LOCAL_SUBCOMMANDS = new Set(['status', 'spaces', 'connect', 'disconnect', 'help'])

const HELP_TEXT = [
  '/tveyo                 查看连接状态',
  '/tveyo status          同上',
  '/tveyo spaces          列出已授权的旅映空间',
  '/tveyo connect         发起旅映授权（会打开浏览器）',
  '/tveyo disconnect      断开连接并撤销授权',
  '/tveyo <自然语言>      把请求交给模型，用旅映工具处理',
].join('\n')

/** 把状态对象渲染成一段可读文本。 */
function renderStatus(state) {
  if (state.connected !== true) {
    const label = state.label ?? '未连接'
    return `旅映：${label}。发送 /tveyo connect 完成授权。`
  }
  const lines = [`旅映：${state.label ?? '已连接'}`]
  const spaceNames = (state.spaces ?? []).map((space) => space.name).filter(Boolean)
  lines.push(`空间：${spaceNames.length > 0 ? spaceNames.join('、') : '（未读取到）'}`)
  lines.push(`工具：${(state.tools ?? []).length} 个${(state.tools ?? []).length > 0 ? `（${state.tools.join(', ')}）` : ''}`)
  if ((state.scopes ?? []).length > 0) lines.push(`能力：${state.scopes.join(' ')}`)
  return lines.join('\n')
}

/**
 * 注册 /tveyo。
 *
 * @param commandCtx 已注入 commands 服务的上下文
 * @param deps       插件的运行时能力（状态、刷新空间、断开、发起授权）
 * @returns 注销函数
 */
export function registerTveyoCommand(commandCtx, deps) {
  return commandCtx.commands.register({
    name: COMMAND_NAME,
    description: '旅映（tveyo）：查看连接状态、列出空间，或把请求交给模型用旅映工具处理',
    input: { hint: '[status|spaces|connect|disconnect|help|<请求>]' },
    async handler(invocation) {
      const raw = invocation.rawInput.trim()
      const keyword = raw.split(/\s+/u)[0]?.toLowerCase() ?? ''

      /* 空参数等价于 status。 */
      if (raw === '') return { kind: 'success', text: renderStatus(await deps.getState()) }

      /* 只有整串就是子命令时才本地处理，避免 "/tveyo help 找个视频" 被误判。 */
      if (LOCAL_SUBCOMMANDS.has(keyword) && raw === keyword) {
        switch (keyword) {
          case 'status':
            return { kind: 'success', text: renderStatus(await deps.getState()) }
          case 'help':
            return { kind: 'success', text: HELP_TEXT }
          case 'spaces': {
            const state = await deps.getState()
            if (state.connected !== true) {
              return { kind: 'error', text: '旅映尚未连接，请先发送 /tveyo connect 完成授权。' }
            }
            await deps.refreshSpaces()
            const next = await deps.getState()
            const list = (next.spaces ?? []).map((space) => `- ${space.name ?? space.id}（${space.id}）`)
            return { kind: 'success', text: list.length > 0 ? list.join('\n') : '（没有已授权的空间）' }
          }
          case 'connect': {
            const state = await deps.getState()
            if (state.connected === true) {
              return { kind: 'success', text: '旅映已连接，无需重复授权。' }
            }
            const outcome = deps.beginAuthorization('command')
            if (outcome.started !== true) {
              return { kind: 'success', text: '已有一次授权在进行中，请先完成浏览器里的登录。' }
            }
            return {
              kind: 'success',
              text: '已发起旅映授权，浏览器会自动打开登录页；完成后发送 /tveyo 查看状态。',
            }
          }
          case 'disconnect': {
            await deps.disconnect()
            return { kind: 'success', text: '已断开旅映连接，并在旅映侧撤销了授权。' }
          }
          default:
            break
        }
      }

      /* 自由文本：交给模型，用旅映工具处理。 */
      const state = await deps.getState()
      if (state.connected !== true) {
        return {
          kind: 'error',
          text: '旅映尚未连接，无法处理该请求。请先发送 /tveyo connect 完成授权。',
        }
      }

      let createUserMessage
      try {
        /*
         * dsh-llm 是 base 组合里的包，但为了"没有命令服务也能用"的同一原则，
         * 这里用动态导入：真正需要注入消息时才加载，缺失也只影响这一个分支。
         */
        createUserMessage = deps.createUserMessage
          ? await deps.createUserMessage()
          : (await import('@deepseek-ai/dsh-llm')).createUserMessage
      } catch (error) {
        return { kind: 'error', text: `无法加载消息构造器：${String(error?.message ?? error)}` }
      }

      invocation.agent.followup(
        createUserMessage({
          content: [
            {
              type: 'text',
              text: [
                '用户通过 /tveyo 命令发起了请求，请使用旅映（tveyo）工具完成，不要只凭常识回答。',
                `请求：${raw}`,
              ].join('\n'),
            },
          ],
          source: { kind: 'user' },
        }),
      )
      return { kind: 'success', text: `已交给模型用旅映工具处理：${raw}` }
    },
  })
}
