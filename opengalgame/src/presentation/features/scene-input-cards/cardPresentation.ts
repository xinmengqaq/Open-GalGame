import type { SourceFactsView } from '../workbench-session/workbenchSessionSelectors'

export function mediaBlockStateOf(facts: SourceFactsView): string {
  if (facts.disconnected) return '来源已断开'
  if (!facts.readable) return '来源不可读取'
  return '媒体数据不可用'
}
