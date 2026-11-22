const fileTurns = new Map<string, Promise<void>>()

/** 同一绝对路径上的修改串行执行，避免后一次静默覆盖前一次。 */
export function withFileTurn<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = fileTurns.get(key) ?? Promise.resolve()
  const run = previous.then(task)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  fileTurns.set(key, settled)
  void settled.then(() => {
    if (fileTurns.get(key) === settled) fileTurns.delete(key)
  })
  return run
}
