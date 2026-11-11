import { resolve } from 'node:path'

const tails = new Map<string, Promise<unknown>>()

/**
 * 同一工程的作品写入共用一个进程内短边界。不同实例不能各自排队。
 * @param action - 提交或回退。
 */
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
