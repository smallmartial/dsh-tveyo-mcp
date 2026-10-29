/**
 * 用系统默认浏览器打开一个地址。
 *
 * 为什么由 Host 打开而不是让卡片 window.open：
 *   - 浏览器可能拦截弹窗；
 *   - 授权页需要在真实浏览器里完成旅映登录，内嵌窗口不合适。
 * 失败只记录日志，不打断授权流程——用户仍可从卡片复制链接。
 */
import { spawn } from 'node:child_process'

/**
 * @param url 要打开的地址
 * @param log 日志函数
 * @returns 是否成功发起（不代表浏览器一定打开了）
 */
export function openBrowser(url, log) {
  const platform = process.platform
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', (error) => log?.('打开浏览器失败：' + String(error?.message ?? error)))
    child.unref()
    return true
  } catch (error) {
    log?.('打开浏览器失败：' + String(error?.message ?? error))
    return false
  }
}
