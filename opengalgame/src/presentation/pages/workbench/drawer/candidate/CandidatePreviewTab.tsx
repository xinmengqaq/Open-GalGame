import type { ReactElement } from 'react'

import { useCandidatePreviewTab } from './candidatePreviewContext'
import { CandidatePreviewPane } from './CandidatePreviewPane'

export function CandidatePreviewTab(): ReactElement | null {
  const candidate = useCandidatePreviewTab()
  if (!candidate?.available) return null
  return (
    <div className="wb-candidate-tab">
      <CandidatePreviewPane controller={candidate} />
    </div>
  )
}
