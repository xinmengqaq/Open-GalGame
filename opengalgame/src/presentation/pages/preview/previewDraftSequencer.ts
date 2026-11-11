export type PreviewDraftIntent = {
  readonly dialogueId: string
  readonly text: string
  readonly revision: number
}

/**
 * 实时草稿按修订号排序。异步返回只允许提交仍对应最新输入的结果；
 * 旧修订不能覆盖新输入，也不能把舞台位置回拨到旧句。
 */
export function isLatestDraftRevision(latest: number, dispatched: number): boolean {
  return latest === dispatched
}

export function nextDraftRevision(current: number): number {
  return current + 1
}
