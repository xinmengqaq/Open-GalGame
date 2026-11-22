export type SceneValidationIssueCode =
  | 'missing-entry'
  | 'unknown-command'
  | 'unsupported-dialogue'
  | 'invalid-argument'
  | 'scene-jump'
  | 'option-edge'
  | 'condition'
  | 'unauthorized-asset'
  | 'missing-asset'
  | 'external-asset'
  | 'invalid-path'
  | 'purpose-mismatch'
  | 'identity-mismatch'
  | 'implicit-speaker'
  | 'automatic-effect-before-end'
  | 'missing-background'
  | 'missing-character'
  | 'scene-locked'
  | 'lock-unknown'
  | 'baseline-changed'
  | 'baseline-unknown'

export const SCENE_VERSION_CONFLICT_ISSUE_CODES = [
  'scene-locked',
  'lock-unknown',
  'baseline-changed',
  'baseline-unknown'
] as const satisfies readonly SceneValidationIssueCode[]

export type SceneVersionConflictIssueCode = (typeof SCENE_VERSION_CONFLICT_ISSUE_CODES)[number]

export function isVersionConflictIssueCode(
  code: SceneValidationIssueCode
): code is SceneVersionConflictIssueCode {
  return (SCENE_VERSION_CONFLICT_ISSUE_CODES as readonly SceneValidationIssueCode[]).includes(code)
}

export interface SceneValidationIssue {
  readonly code: SceneValidationIssueCode
  readonly message: string
  readonly sequence?: number
  readonly correctable: boolean
  readonly requiresHumanDecision: boolean
  readonly reference?: string
  readonly line?: number
  readonly nearestReference?: string
  readonly nearestAssetName?: string
  readonly nearestAssetPath?: string
}

export interface SceneValidationReport {
  readonly issues: readonly SceneValidationIssue[]
}
