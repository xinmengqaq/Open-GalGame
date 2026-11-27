/**
 * 只有后端确认成功的连接动作才会携带配置指纹进入新手引导。
 * 失败、取消和未确认结果都不产生可用于推进的事实。
 */
export type ConnectionActionOutcome = 'confirmed' | 'failed' | 'cancelled' | 'unverified'

export function connectionActionFingerprint(
  outcome: ConnectionActionOutcome,
  configFingerprint: string
): string | null {
  return outcome === 'confirmed' ? configFingerprint : null
}
