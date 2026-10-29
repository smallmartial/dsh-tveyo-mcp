/**
 * 旅映 MCP 插件卡片（浏览器半侧）。
 *
 * 只做三件事：显示状态、发起授权、断开。所有网络调用都打回 Host 的
 * /plugins/dsh-tveyo-mcp/* 路由，浏览器不直接接触旅映令牌。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tveyo-mcp',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement

    const BASE = '/plugins/dsh-tveyo-mcp'
    const STATE_LABEL = {
      idle: '未连接',
      connecting: '连接中',
      ready: '已连接',
      'needs-auth': '需要授权',
      error: '连接失败',
    }

    const styles = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '14px 16px',
        border: '1px solid var(--dsw-alias-border-l1, #8883)',
        borderRadius: 10,
        fontSize: 13,
        lineHeight: 1.6,
      },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      dot: (color) => ({ width: 8, height: 8, borderRadius: 4, background: color, flex: 'none' }),
      label: { color: 'var(--dsw-alias-label-secondary, #888)' },
      value: { color: 'var(--dsw-alias-label-primary, inherit)' },
      actions: { display: 'flex', gap: 8, marginTop: 4 },
      primary: {
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: '#3b82f6',
        color: '#fff',
        cursor: 'pointer',
        font: 'inherit',
      },
      secondary: {
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid #8886',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      },
      notice: {
        padding: '8px 10px',
        borderRadius: 8,
        background: '#3b82f61a',
        color: 'inherit',
      },
      error: {
        padding: '8px 10px',
        borderRadius: 8,
        background: '#ef44441a',
        color: '#ef4444',
      },
      link: { color: '#3b82f6', wordBreak: 'break-all' },
    }

    /** 轮询间隔：授权进行中 1.5s，其余 10s。 */
    const FAST_MS = 1500
    const SLOW_MS = 10000

    function TveyoCard() {
      const [state, setState] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState(null)
      const timer = react.useRef(null)

      const load = react.useCallback(async () => {
        try {
          const response = await fetch(BASE + '/state', { credentials: 'same-origin' })
          if (!response.ok) throw new Error('状态读取失败：' + response.status)
          setState(await response.json())
          setError(null)
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
      }, [])

      react.useEffect(() => {
        let cancelled = false
        const tick = async () => {
          if (cancelled) return
          await load()
          if (cancelled) return
          const waiting = state && state.attempting === true
          timer.current = setTimeout(tick, waiting ? FAST_MS : SLOW_MS)
        }
        tick()
        return () => {
          cancelled = true
          if (timer.current !== null) clearTimeout(timer.current)
        }
      }, [load, state && state.state + ':' + String(state.attempting)])

      /** 轮询到授权地址；Host 生成 URL 需要一次 401 往返，通常 1 秒内就绪。 */
      const waitForAuthorizationUrl = async (timeoutMs = 15000) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          try {
            const response = await fetch(BASE + '/state', { credentials: 'same-origin' })
            if (response.ok) {
              const next = await response.json()
              const url = next && next.notice && next.notice.url
              if (url) return url
            }
          } catch {
            /* 继续重试 */
          }
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
        return null
      }

      const connect = async () => {
        setBusy(true)
        setError(null)
        /*
         * 必须在这里同步开窗：浏览器只允许用户点击的同一个任务里创建弹窗，
         * 等 fetch 回来再 window.open 会被当成广告拦截。
         */
        let popup = null
        try {
          popup = window.open('about:blank', '_blank')
          if (popup) popup.opener = null
        } catch {
          popup = null
        }
        try {
          const response = await fetch(BASE + '/connect' + (popup ? '?surface=card' : ''), {
            method: 'POST',
            credentials: 'same-origin',
          })
          if (!response.ok && response.status !== 202) {
            throw new Error('发起授权失败：' + response.status)
          }
          if (popup) {
            const url = await waitForAuthorizationUrl()
            if (url && !popup.closed) {
              popup.location.replace(url)
            } else if (!popup.closed) {
              popup.close()
            }
          }
          await load()
        } catch (cause) {
          if (popup && !popup.closed) popup.close()
          setError(String(cause && cause.message ? cause.message : cause))
        } finally {
          setBusy(false)
        }
      }

      const disconnect = async () => {
        setBusy(true)
        setError(null)
        try {
          const response = await fetch(BASE + '/disconnect', {
            method: 'POST',
            credentials: 'same-origin',
          })
          if (!response.ok) throw new Error('断开失败：' + response.status)
          await load()
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        } finally {
          setBusy(false)
        }
      }

      const cancel = async () => {
        setBusy(true)
        try {
          await fetch(BASE + '/cancel', { method: 'POST', credentials: 'same-origin' })
          await load()
        } catch {
          /* 取消失败不额外提示 */
        } finally {
          setBusy(false)
        }
      }

      if (state === null && error === null) {
        return h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.dot('#9ca3af') }),
            h('strong', null, '旅映 MCP'),
            h('span', { style: { ...styles.label, marginLeft: 'auto' } }, '读取中…'),
          ),
        )
      }

      const connected = state && state.connected
      /* "需要授权"是静止状态，只有 attempting 才代表浏览器授权进行中。 */
      const waiting = state && state.attempting === true
      const color = connected ? '#22c55e' : waiting ? '#f59e0b' : '#ef4444'
      const label = (state && (state.label || STATE_LABEL[state.state])) || '未知'

      return h(
        'div',
        { style: styles.card },
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.dot(color) }),
          h('strong', null, '旅映 MCP'),
          h('span', { style: { ...styles.label, marginLeft: 'auto' } }, label),
        ),
        connected
          ? h(
              'div',
              { style: styles.row },
              h('span', { style: styles.label }, '空间'),
              h(
                'span',
                { style: styles.value },
                state.spaces && state.spaces.length
                  ? state.spaces.map((space) => space.name).join('、')
                  : '—',
              ),
            )
          : null,
        connected
          ? h(
              'div',
              { style: styles.row },
              h('span', { style: styles.label }, '工具'),
              h('span', { style: styles.value }, (state.tools || []).length + ' 个'),
            )
          : null,
        state && state.notice
          ? h(
              'div',
              { style: styles.notice },
              state.notice.message,
              state.notice.url
                ? h(
                    'div',
                    null,
                    h(
                      'a',
                      { href: state.notice.url, target: '_blank', rel: 'noreferrer', style: styles.link },
                      '打开授权页',
                    ),
                  )
                : null,
            )
          : null,
        state && state.lastError && state.state === 'error'
          ? h('div', { style: styles.error }, '最近错误：' + state.lastError)
          : null,
        error ? h('div', { style: styles.error }, error) : null,
        h(
          'div',
          { style: styles.actions },
          connected
            ? h(
                'button',
                { style: styles.secondary, disabled: busy, onClick: disconnect },
                busy ? '处理中…' : '断开连接',
              )
            : waiting
              ? h('button', { style: styles.secondary, disabled: busy, onClick: cancel }, '取消授权')
              : h(
                  'button',
                  { style: styles.primary, disabled: busy, onClick: connect },
                  busy ? '发起中…' : connected ? '重新授权' : '连接旅映',
                ),
        ),
      )
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const register = (slot, key) => {
        try {
          return ctx.slots.inject(slot, () =>
            ctx.slots.register({ name: slot, key, priority: 30, inject: () => ({}) }, TveyoCard),
          )
        } catch (cause) {
          console.error('[dsh-tveyo-mcp] 卡片注册失败：', cause)
          return undefined
        }
      }
      /*
       * 插件页按 key 与清单里的包名做精确相等匹配；安装行叫什么，key 就得是
       * 什么。两个 slot 都注册同名 key，覆盖「组合包」和「单行」两种呈现。
       */
      const disposers = [
        register('plugins.bundle.config', 'dsh-tveyo-mcp'),
        register('plugins.row.config', 'dsh-tveyo-mcp'),
      ].filter((disposer) => disposer !== undefined)
      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 已释放 */
          }
        }
      }, 'dsh-tveyo-mcp: 卡片释放')
    }

    return { apply, inject, name: 'dsh-tveyo-mcp' }
  },
})
