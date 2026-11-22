export const INFORMATION_GAIN_NUDGE_AFTER = 2
export const INFORMATION_GAIN_STOP_AFTER = 6
export const POST_WRITE_CHECK_LIMIT = 2

export interface InformationRoundFact {
  readonly key: string
  readonly signature: string
  readonly repeat: boolean
}

export class InformationGainTracker {
  readonly nudgeAfter = INFORMATION_GAIN_NUDGE_AFTER
  readonly stopAfter = INFORMATION_GAIN_STOP_AFTER
  readonly postWriteCheckLimit = POST_WRITE_CHECK_LIMIT

  consecutiveNoGain = 0
  redundantRepeats = 0
  private readonly seen = new Map<string, Set<string>>()
  private readonly lastWriteSignature = new Map<string, string>()
  private nudged = false
  private candidateWritten = false
  private postWriteUnchecked = 0
  private postWriteNudged = false
  private postWriteEnded = false

  note(key: string, result: string): boolean {
    return this.record(key, result, false)
  }

  observe(key: string, result: string): void {
    this.record(key, result, true)
  }

  settleRound(facts: readonly InformationRoundFact[]): void {
    const repeated = facts.some((fact) => fact.repeat)
    if (repeated) {
      this.consecutiveNoGain += 1
      this.redundantRepeats += 1
      return
    }
    this.consecutiveNoGain = 0
  }

  onWriteSucceeded(path: string, signature: string, changed: boolean): void {
    if (!this.candidateWritten) this.candidateWritten = true
    this.lastWriteSignature.set(path, signature)
    this.resetExploration()
    if (!changed) this.settleRound([{ key: writeObservationKey(path), signature, repeat: true }])
  }

  lastSignature(path: string): string | undefined {
    return this.lastWriteSignature.get(path)
  }

  hasCandidateWritten(): boolean {
    return this.candidateWritten && !this.postWriteEnded
  }

  afterModelResponse(hasStructuredSubmission: boolean): void {
    if (!this.candidateWritten || this.postWriteEnded) return
    if (hasStructuredSubmission) {
      this.postWriteEnded = true
      return
    }
    this.postWriteUnchecked += 1
  }

  needsPostWriteNudge(): boolean {
    return (
      this.hasCandidateWritten() &&
      !this.postWriteNudged &&
      this.postWriteUnchecked >= this.postWriteCheckLimit
    )
  }

  takePostWriteNudge(): boolean {
    if (!this.needsPostWriteNudge()) return false
    this.postWriteNudged = true
    return true
  }

  shouldStopAfterPostWrite(): boolean {
    return this.hasCandidateWritten() && this.postWriteUnchecked >= this.postWriteCheckLimit + 1
  }

  postWriteRounds(): number {
    return this.postWriteUnchecked
  }

  reset(): void {
    this.resetExploration()
  }

  needsNudge(): boolean {
    return (
      !this.nudged &&
      (this.consecutiveNoGain >= this.nudgeAfter || this.redundantRepeats >= this.nudgeAfter)
    )
  }

  takeNudge(): boolean {
    if (this.nudged) return false
    this.nudged = true
    return true
  }

  shouldStop(): boolean {
    return this.consecutiveNoGain >= this.stopAfter || this.redundantRepeats >= this.stopAfter
  }

  private record(key: string, result: string, countNow: boolean): boolean {
    const previous = this.seen.get(key) ?? new Set<string>()
    const repeat = previous.has(result)
    if (!repeat) {
      previous.add(result)
      this.seen.set(key, previous)
    }
    if (!countNow) return repeat
    if (repeat) {
      this.consecutiveNoGain += 1
      this.redundantRepeats += 1
    } else {
      this.consecutiveNoGain = 0
    }
    return repeat
  }

  private resetExploration(): void {
    this.seen.clear()
    this.consecutiveNoGain = 0
    this.redundantRepeats = 0
    this.nudged = false
  }
}

function writeObservationKey(path: string): string {
  return `write:${path}`
}
