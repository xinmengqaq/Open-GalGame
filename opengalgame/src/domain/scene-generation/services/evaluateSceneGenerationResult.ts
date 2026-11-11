import {
  requireSceneGenerationRequest,
  type SceneGenerationRequest
} from '../models/SceneGenerationRequest'
import type {
  SceneCandidateJudgment,
  SceneCandidateJudgmentStatus
} from '../models/SceneCandidateJudgment'
import type { SceneValidationIssue, SceneValidationReport } from '../models/SceneValidationReport'

/**
 * 结合校验问题、锁定和基线，判断候选能否覆盖目标场景。
 * 已确认且不能自动删除的问题优先留给人工。重复修正是否耗尽不在这里判断。
 * 锁定和基线问题不是改脚本能消除的，因此不可修正。
 * 这里只判断候选，不表示提交成功、取消或回退。
 * @param request - 锁定、基线和已确认控制。修正次数不决定候选是否还能修正。
 * @returns 接受、可修正、需要人工或拒绝，以及包含覆盖问题的报告。
 * @throws {AppException} 请求身份、三类输入或已确认控制不完整。
 */
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

/**
 * 把不允许覆盖的锁定和基线记成问题。
 * @returns 覆盖问题；允许覆盖时为空数组。
 */
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

/**
 * 组装一条不可修正的覆盖问题。
 * @returns 覆盖问题。
 */
function overwriteIssue(code: SceneValidationIssue['code'], message: string): SceneValidationIssue {
  return { code, message, correctable: false, requiresHumanDecision: false }
}

/**
 * 按不可修正和人工取舍决定结果。
 * 仍可修正的问题不受修正次数截断。
 * @param issues - 内容问题与覆盖问题。
 */
function judgeStatus(issues: readonly SceneValidationIssue[]): SceneCandidateJudgmentStatus {
  if (issues.length === 0) return 'acceptable'
  if (issues.some((issue) => !issue.correctable)) return 'rejected'
  if (issues.some((issue) => issue.requiresHumanDecision)) return 'needsDecision'
  return 'correctable'
}
