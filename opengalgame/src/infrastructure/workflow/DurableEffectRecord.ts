export type DurableEffectStatus = 'started' | 'completed' | 'failed' | 'unknown'

export type DurableEffectKind = 'fileWrite' | 'commit' | 'none'

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
