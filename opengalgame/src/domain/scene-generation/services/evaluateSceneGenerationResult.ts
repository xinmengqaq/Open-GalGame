import {
  requireSceneGenerationRequest,
  type SceneGenerationRequest
} from '../models/SceneGenerationRequest'
import type {
  SceneCandidateJudgment,
  SceneCandidateJudgmentStatus
} from '../models/SceneCandidateJudgment'
import type { SceneValidationIssue, SceneValidationReport } from '../models/SceneValidationReport'

export function evaluateSceneGenerationResult(
  report: SceneValidationReport,
  request: SceneGenerationRequest
): SceneCandidateJudgment {
  requireSceneGenerationRequest(request)
  const issues = [...report.issues, ...overwriteIssues(request)]
  return {
    status: judgeStatus(issues),
    report: { issues }
  }
}

function overwriteIssues(request: SceneGenerationRequest): SceneValidationIssue[] {
  const issues: SceneValidationIssue[] = []
  if (request.lockState === 'locked') {
    issues.push(overwriteIssue('scene-locked', '目标场景已锁定，不能覆盖'))
  }
  if (request.lockState === 'unknown') {
    issues.push(overwriteIssue('lock-unknown', '目标场景锁定状态不明，不能覆盖'))
  }
  if (request.baselineState === 'changed') {
    issues.push(overwriteIssue('baseline-changed', '目标场景基线已变化，不能覆盖'))
  }
  if (request.baselineState === 'unknown') {
    issues.push(overwriteIssue('baseline-unknown', '目标场景基线不明，不能覆盖'))
  }
  return issues
}

function overwriteIssue(code: SceneValidationIssue['code'], message: string): SceneValidationIssue {
  return { code, message, correctable: false, requiresHumanDecision: false }
}

function judgeStatus(issues: readonly SceneValidationIssue[]): SceneCandidateJudgmentStatus {
  if (issues.length === 0) return 'acceptable'
  if (issues.some((issue) => !issue.correctable)) return 'rejected'
  if (issues.some((issue) => issue.requiresHumanDecision)) return 'needsDecision'
  return 'correctable'
}
