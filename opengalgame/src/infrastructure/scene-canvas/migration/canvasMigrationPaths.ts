import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 路径比较键；Windows 文件系统不区分大小写。 */
export function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/** 判断 candidate 是否等于 root 或位于 root 内。调用方传入解析后的绝对路径。 */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** 把本机分隔符路径转成正斜杠路径，用于 manifest 与报告。 */
export function toPosixPath(value: string): string {
  return value.split(sep).join('/')
}

/**
 * 校验根内 POSIX 相对路径。
 * @returns 合法路径；含空段、当前目录、上级跳转、反斜杠或盘符时为 null。
 */
export function safeRelativePosix(value: string): string | null {
  if (value.length === 0 || value.includes('\0') || value.includes('\\')) return null
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return null
  const parts = value.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return parts.join('/')
}

/**
 * 把可能尚不存在的绝对路径规范为真实路径：最近既存祖先取 realpath，缺失尾段按词法拼接。
 * 这样指向工程内的目录联接/junction 会在写入前暴露出来。
 * @throws 路径不是绝对路径，或既存祖先无法解析。
 */
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

/**
 * 在真实根内解析相对路径；已存在的链接必须仍落在根内，缺失尾段按词法拼接。
 * @throws 路径非法、经链接越出根或无法检查。
 */
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
