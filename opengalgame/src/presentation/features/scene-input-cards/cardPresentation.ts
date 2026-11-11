import type { SourceFactsView } from '../workbench-session/workbenchSessionSelectors'

/** 来源身份不可用时，不把内部来源标识当作名称展示。 */
export function sourceDisplayNameOf(facts: SourceFactsView): string {
  return facts.disconnected ? '来源信息不可用' : facts.name
}

/** 无媒体字节或来源不可用时，卡面只说明当前可确认的状态。 */
export function mediaBlockStateOf(facts: SourceFactsView): string {
  if (facts.disconnected) return '来源已断开'
  if (!facts.readable) return '来源不可读取'
  return '媒体数据不可用'
}
