import type { SceneValidationReport } from './SceneValidationReport'

export type SceneCandidateJudgmentStatus =
  'acceptable' | 'correctable' | 'needsDecision' | 'rejected'

export interface SceneCandidateJudgment {
  readonly status: SceneCandidateJudgmentStatus
  readonly report: SceneValidationReport
}
