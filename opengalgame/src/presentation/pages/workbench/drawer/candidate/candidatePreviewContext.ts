import { createContext, useContext } from 'react'

import type { CandidatePreviewController } from './useCandidatePreview'

/**
 * 抽屉级候选控制器：审阅气泡的入口和只读游戏候选标签共用同一个会话状态，
 * 不各自打开客户端或复制会话。打开语义仍由生成侧候选身份决定。
 */
export type CandidatePreviewTabController = CandidatePreviewController & {
  /** 当前生成交互是否提供了可预览的固定候选；没有时整个标签不出现。 */
  readonly available: boolean
  /** 切换到“游戏候选”标签，不改变候选身份，也不重新打开会话。 */
  readonly activate: () => void
}

export const CandidatePreviewContext = createContext<CandidatePreviewTabController | null>(null)

/** 不在生成抽屉内时返回 null；调用方据此隐藏候选入口，而不是渲染空标签。 */
export function useCandidatePreviewTab(): CandidatePreviewTabController | null {
  return useContext(CandidatePreviewContext)
}
