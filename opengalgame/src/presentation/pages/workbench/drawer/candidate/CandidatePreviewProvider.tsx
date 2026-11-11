import { useMemo, type ReactElement, type ReactNode } from 'react'

import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'
import {
  CandidatePreviewContext,
  type CandidatePreviewTabController
} from './candidatePreviewContext'
import type { CandidatePreviewTarget } from './candidatePreviewState'
import { useCandidatePreview } from './useCandidatePreview'

type CandidatePreviewProviderProps = {
  readonly generationClient: Pick<SceneGenerationClient, 'openPreview' | 'closePreview'>
  readonly previewClient: Pick<
    ScenePreviewClient,
    'readCandidatePreview' | 'subscribeCandidatePreview'
  > | null
  readonly target: CandidatePreviewTarget | null
  /** 候选标签正在显示时才打开会话；未传时保持立即打开。 */
  readonly active?: boolean
  readonly onActivate: () => void
  readonly children: ReactNode
}

/** 抽屉内只创建一个候选会话，供审阅入口和只读标签共同消费。 */
export function CandidatePreviewProvider({
  generationClient,
  previewClient,
  target,
  active,
  onActivate,
  children
}: CandidatePreviewProviderProps): ReactElement {
  const controller = useCandidatePreview({ generationClient, previewClient, target, active })
  const value = useMemo<CandidatePreviewTabController>(
    () => ({
      ...controller,
      available: target !== null,
      activate: onActivate
    }),
    [controller, onActivate, target]
  )
  return (
    <CandidatePreviewContext.Provider value={value}>{children}</CandidatePreviewContext.Provider>
  )
}
