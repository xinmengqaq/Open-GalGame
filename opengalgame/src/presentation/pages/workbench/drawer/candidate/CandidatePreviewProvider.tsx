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
  readonly active?: boolean
  readonly onActivate: () => void
  readonly children: ReactNode
}

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
