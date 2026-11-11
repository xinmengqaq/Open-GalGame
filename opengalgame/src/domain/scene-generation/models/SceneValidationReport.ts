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

export interface SceneValidationIssue {
  readonly code: SceneValidationIssueCode
  readonly message: string
  readonly sequence?: number
  readonly correctable: boolean
  readonly requiresHumanDecision: boolean
  /** 候选实际写出的素材引用；仅素材引用问题提供。旧记录可缺省。 */
  readonly reference?: string
  /** 候选入口文件中的实际行号（1 起）；仅素材引用问题提供。旧记录可缺省。 */
  readonly line?: number
  /** 本次素材清单中与该引用最近似的有效命令引用；仅缺失素材且有候选时提供。 */
  readonly nearestReference?: string
  /** 最近似引用对应的素材名称；随 nearestReference 提供。 */
  readonly nearestAssetName?: string
  /** 最近似引用对应的工程相对路径；随 nearestReference 提供。 */
  readonly nearestAssetPath?: string
}

export interface SceneValidationReport {
  readonly issues: readonly SceneValidationIssue[]
}
