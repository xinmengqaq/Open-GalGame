import type { GuideContextSnapshot, GuideFact } from '../features/beginner-guide/guideObservation'

/** 每条事实都由观察源统一分配单调序号和发生时间。 */
export type ConfirmedFactBase = {
  outcome: 'confirmed'
  sequence: number
  occurredAt: string
}

/** 页面动作观察器与观察源之间的最小接口；不向来源文件暴露订阅者集合。 */
export interface GuideActionFactContext {
  active(): boolean
  readCurrent(): GuideContextSnapshot
  factBase(): ConfirmedFactBase
  emit(fact: GuideFact): void
}
