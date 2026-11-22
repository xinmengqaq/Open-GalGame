import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

export function toPosixPath(value: string): string {
  return value.split(sep).join('/')
}

export function safeRelativePosix(value: string): string | null {
  if (value.length === 0 || value.includes('\0') || value.includes('\\')) return null
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return null
  const parts = value.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return parts.join('/')
}

export async function realPathOfPossiblyMissing(target: string): Promise<string> {
  if (!isAbsolute(target)) throw new Error(`必须使用绝对路径：${target}`)
  const missing: string[] = []
  let current = resolve(target)
  for (;;) {
    try {
      const real = await realpath(current)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

export async function resolveInsideRealRoot(
  rootReal: string,
  relativePosix: string
): Promise<string> {
  const safe = safeRelativePosix(relativePosix)
  if (safe === null) throw new Error(`非法根内相对路径：${relativePosix}`)
  const parts = safe.split('/')
  let current = rootReal
  for (let index = 0; index < parts.length; index += 1) {
    const next = join(current, parts[index]!)
    let stats
    try {
      stats = await lstat(next)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return join(current, ...parts.slice(index))
      }
      throw error
    }
    if (stats.isSymbolicLink()) {
      const real = await realpath(next)
      if (!isPathInside(rootReal, real)) {
        throw new Error(`路径经链接越出真实根：${next} -> ${real}`)
      }
      current = real
    } else {
      current = next
    }
  }
  if (!isPathInside(rootReal, current)) {
    throw new Error(`路径越出真实根：${relativePosix}`)
  }
  return current
}
