import { createContext, useContext } from 'react'

import type { CandidatePreviewController } from './useCandidatePreview'

export type CandidatePreviewTabController = CandidatePreviewController & {
  readonly available: boolean
  readonly activate: () => void
}

export const CandidatePreviewContext = createContext<CandidatePreviewTabController | null>(null)

export function useCandidatePreviewTab(): CandidatePreviewTabController | null {
  return useContext(CandidatePreviewContext)
}
