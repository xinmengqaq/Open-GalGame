import type { ReactElement } from 'react'

import { useCandidatePreviewTab } from './candidatePreviewContext'
import { CandidatePreviewPane } from './CandidatePreviewPane'

/**
 * 生成抽屉的“游戏候选”标签内容。只消费抽屉级候选会话，不创建客户端、
 * 不改变候选，也不提供编辑、保存、提交或导出入口。
 */
export function CandidatePreviewTab(): ReactElement | null {
  const candidate = useCandidatePreviewTab()
  if (!candidate?.available) return null
  return (
    <div className="wb-candidate-tab">
      <CandidatePreviewPane controller={candidate} />
    </div>
  )
}
