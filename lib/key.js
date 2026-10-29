/**
 * 凭据记录键。
 *
 * DSH 的 credentialKey() 只是给字符串加一个编译期品牌，运行时就是
 * "<scope>/<id>"。这里自己拼，避免为一个纯类型辅助引入运行时依赖——
 * 插件被 link 安装时裸导入解析更脆弱，能少一个是一个。
 */
export function credentialKeyOf(scope, id) {
  return `${scope}/${id}`
}
