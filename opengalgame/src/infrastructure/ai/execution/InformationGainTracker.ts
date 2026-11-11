/** 同一调用和结果是否带来新内容。阈值是固定常量，不是调用次数上限。 */
export const INFORMATION_GAIN_NUDGE_AFTER = 2
export const INFORMATION_GAIN_STOP_AFTER = 6
/** 候选写出后允许的自动自检轮数。第 3 轮仍无合法提交才停止。 */
export const POST_WRITE_CHECK_LIMIT = 2

export interface InformationRoundFact {
  readonly key: string
  readonly signature: string
  /** 这一次结果是否命中已经见过的同一调用和摘要。 */
  readonly repeat: boolean
}

/**
 * 记录探索阶段的信息增益，以及候选写出后的自动自检轮数。
 * 重复只在一批工具结果结算后计数；写成功清空探索，但不清空写后阶段。
 */
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

  /** 登记一次结果并返回登记前是否已经见过。不改变无进展计数。 */
  note(key: string, result: string): boolean {
    return this.record(key, result, false)
  }

  /** 记下一次非写工具结果。命中任一旧签名都算无进展。 */
  observe(key: string, result: string): void {
    this.record(key, result, true)
  }

  /**
   * 一批工具结果结算后计入无进展。新结果清连续计数；
   * 一批里只要有重复，累计重复只加一次。
   */
  settleRound(facts: readonly InformationRoundFact[]): void {
    const repeated = facts.some((fact) => fact.repeat)
    if (repeated) {
      this.consecutiveNoGain += 1
      this.redundantRepeats += 1
      return
    }
    this.consecutiveNoGain = 0
  }

  /**
   * 成功写入入口后进入候选已写出阶段，并清空探索计数。
   * 相同内容仍按无增益计入；两种都不清空写后阶段。
   */
  onWriteSucceeded(path: string, signature: string, changed: boolean): void {
    if (!this.candidateWritten) this.candidateWritten = true
    this.lastWriteSignature.set(path, signature)
    this.resetExploration()
    if (!changed) this.settleRound([{ key: writeObservationKey(path), signature, repeat: true }])
  }

  /** 同一路径上次记录的写入签名。还没有成功写入时为空。 */
  lastSignature(path: string): string | undefined {
    return this.lastWriteSignature.get(path)
  }

  /** 候选入口已经成功写出，且本阶段还没有合法提交。 */
  hasCandidateWritten(): boolean {
    return this.candidateWritten && !this.postWriteEnded
  }

  /**
   * 只统计候选已写出后、模型自动发出且没有合法结构化提交的响应。
   * 合法提交结束阶段；未进入该阶段时不计数。
   */
  afterModelResponse(hasStructuredSubmission: boolean): void {
    if (!this.candidateWritten || this.postWriteEnded) return
    if (hasStructuredSubmission) {
      this.postWriteEnded = true
      return
    }
    this.postWriteUnchecked += 1
  }

  /** 自动自检已满 2 轮，下一次模型调用前提示必须提交。 */
  needsPostWriteNudge(): boolean {
    return (
      this.hasCandidateWritten() &&
      !this.postWriteNudged &&
      this.postWriteUnchecked >= this.postWriteCheckLimit
    )
  }

  /** 写后提示只发一次。 */
  takePostWriteNudge(): boolean {
    if (!this.needsPostWriteNudge()) return false
    this.postWriteNudged = true
    return true
  }

  /** 第 3 个自动响应仍没有合法结构化提交。 */
  shouldStopAfterPostWrite(): boolean {
    return this.hasCandidateWritten() && this.postWriteUnchecked >= this.postWriteCheckLimit + 1
  }

  /** 当前写后自动自检轮数。未进入阶段时为 0。 */
  postWriteRounds(): number {
    return this.postWriteUnchecked
  }

  /** 清空探索记录、计数和探索提示。不碰候选已写出阶段。 */
  reset(): void {
    this.resetExploration()
  }

  /** 尚未提示，且连续无进展或累计重复达到提示阈值。 */
  needsNudge(): boolean {
    return (
      !this.nudged &&
      (this.consecutiveNoGain >= this.nudgeAfter || this.redundantRepeats >= this.nudgeAfter)
    )
  }

  /** 只发出一次探索提示。已经提示过时返回 false。 */
  takeNudge(): boolean {
    if (this.nudged) return false
    this.nudged = true
    return true
  }

  /** 连续无进展或累计重复达到停止阈值。 */
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
