export function isLatestDraftRevision(latest: number, dispatched: number): boolean {
  return latest === dispatched
}

export function nextDraftRevision(current: number): number {
  return current + 1
}
