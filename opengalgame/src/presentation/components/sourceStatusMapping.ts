export type SourceStatusCode = 'readable' | 'unreadable' | 'disconnected'

/** 共享状态只声明映射需要的来源事实，不反向依赖领域选择器。 */
export interface SourceStatusFacts {
  readable: boolean
  disconnected?: boolean
}

/** 来源事实到状态码的唯一映射：断开优先于不可读取。 */
export function sourceStatusOf(facts: SourceStatusFacts): SourceStatusCode {
  if (facts.disconnected) return 'disconnected'
  return facts.readable ? 'readable' : 'unreadable'
}
