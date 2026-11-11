import type { ParsedScene } from '../../scenes/models/ParsedScene'
import type { CandidatePreviewSession } from '../../scenes/models/CandidatePreviewSession'
import type { SceneReferenceFact } from '../../scenes/models/SceneReferenceFact'
import type { SceneSourceSnapshot } from '../../scenes/models/SceneSourceSnapshot'
import type { CandidatePreviewIssueVO } from '../vo/CandidatePreviewVO'
import type { SceneCompatibilityFacts } from './SceneCompatibilityFacts'

export type CandidatePreviewReadContext = {
  readonly session: CandidatePreviewSession
  readonly snapshot: SceneSourceSnapshot
  readonly parsed: ParsedScene
  readonly references: readonly SceneReferenceFact[]
  readonly issues: readonly CandidatePreviewIssueVO[]
  readonly compatibility: SceneCompatibilityFacts
}
