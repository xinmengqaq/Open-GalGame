export type DurableEffectStatus = 'started' | 'completed' | 'failed' | 'unknown'

export type DurableEffectKind = 'fileWrite' | 'commit' | 'none'

/** 调用方随完成结果保存的题组。缺省表示这份记录没有该事实，恢复时不能补造。 */
export type DurableEffectQuestion = {
  questionId: string
  prompt: string
  detail?: string
  options: readonly { id: string; label: string; description: string }[]
}

export interface DurableEffectRecord {
  operationId: string
  stepId: string
  inputDigest: string
  resultDigest?: string
  candidateRevision?: string
  status: DurableEffectStatus
  kind: DurableEffectKind
  questions?: readonly DurableEffectQuestion[]
}
