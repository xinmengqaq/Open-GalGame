import { resolve } from 'node:path'

const tails = new Map<string, Promise<unknown>>()

export function enqueueWorkWrite<T>(projectRoot: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(projectRoot)
  const previous = tails.get(key) ?? Promise.resolve()
  const result = previous.then(action, action)
  tails.set(
    key,
    result.then(
      () => undefined,
      () => undefined
    )
  )
  return result
}
