import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

const PATH_ESCAPE = new AppException({
  code: ErrorCodes.forbidden,
  msg: '路径超出允许范围'
})

/**
 * 把调用方给出的相对路径规范成仓库内的正斜杠路径。
 * @param input - 调用方路径。
 * @returns 不含绝对路径、上级跳转和 Git 元数据的相对路径。
 * @throws {AppException} 路径绝对、越界或指向 Git 元数据。
 */
export function assertRelativePath(input: string): string {
  if (input.length === 0 || input.includes('\0') || input.includes('\\')) throw PATH_ESCAPE
  if (isAbsolute(input) || /^[a-zA-Z]:/u.test(input) || input.startsWith('/')) throw PATH_ESCAPE
  const parts = input.split('/')
  if (
    parts.some(
      (part) => part.length === 0 || part === '.' || part === '..' || part.toLowerCase() === '.git'
    )
  ) {
    throw PATH_ESCAPE
  }
  return parts.join('/')
}

/**
 * 判断真实路径是否仍在根目录内。
 * @param root - 已解析的根目录。
 */
function staysInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target).replaceAll('\\', '/')
  return (
    fromRoot === '' || (!fromRoot.startsWith('../') && fromRoot !== '..' && !isAbsolute(fromRoot))
  )
}

/**
 * 逐段确认路径没有通过符号链接或 Windows 联接逃出根目录。
 * 不存在的末段只做词法拼接，不会为了探测而打开区外文件。
 * @param root - 允许访问的根目录。
 * @throws {AppException} 路径越界，或链接指向根外。
 */
export async function resolveContained(root: string, relativePath: string): Promise<string> {
  const safe = assertRelativePath(relativePath)
  let rootReal: string
  try {
    rootReal = await realpath(root)
  } catch (error) {
    throw new AppException({
      code: ErrorCodes.forbidden,
      msg: '路径超出允许范围',
      cause: error
    })
  }
  const metadata = await gitMetadataRoot(rootReal)
  let current = rootReal
  const parts = safe.split('/')
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink()) {
        const target = await realpath(current)
        assertInsideRoot(rootReal, metadata, target)
        current = target
      }
    } catch (error) {
      if (error instanceof AppException) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        current = join(current, ...parts.slice(index + 1))
        break
      }
      throw new AppException({
        code: ErrorCodes.forbidden,
        msg: '路径超出允许范围',
        cause: error
      })
    }
  }
  assertInsideRoot(rootReal, metadata, current)
  return current
}

/**
 * 确认 Git 元数据子目录的实际位置仍在本仓库 `.git` 内。
 * @returns 可安全创建缺失末段的目录。
 * @throws {AppException} 目录是链接，或实际位置越出仓库或 `.git`。
 */
export async function resolveRepositoryMetadata(
  projectRoot: string,
  segments: readonly string[]
): Promise<string> {
  if (!isAbsolute(projectRoot)) throw PATH_ESCAPE
  const rootReal = await realpath(projectRoot).catch((error: unknown) => {
    throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围', cause: error })
  })
  const gitLexical = join(rootReal, '.git')
  let gitStats
  try {
    gitStats = await lstat(gitLexical)
  } catch (error) {
    throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围', cause: error })
  }
  if (gitStats.isSymbolicLink() || !gitStats.isDirectory()) throw PATH_ESCAPE
  const gitReal = await realpath(gitLexical)
  if (!staysInside(rootReal, gitReal)) throw PATH_ESCAPE
  let current = gitReal
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink()) {
        const target = await realpath(current)
        if (!staysInside(rootReal, target) || !staysInside(gitReal, target)) throw PATH_ESCAPE
        current = target
      }
    } catch (error) {
      if (error instanceof AppException) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        current = join(current, ...segments.slice(index + 1))
        break
      }
      throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围', cause: error })
    }
  }
  if (!staysInside(rootReal, current) || !staysInside(gitReal, current)) throw PATH_ESCAPE
  return current
}

async function gitMetadataRoot(rootReal: string): Promise<string | null> {
  const lexical = join(rootReal, '.git')
  try {
    const stats = await lstat(lexical)
    if (!stats.isDirectory() && !stats.isSymbolicLink()) return null
    return await realpath(lexical)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围', cause: error })
  }
}

function assertInsideRoot(rootReal: string, metadata: string | null, target: string): void {
  if (!staysInside(rootReal, target)) throw PATH_ESCAPE
  if (metadata && staysInside(metadata, target)) throw PATH_ESCAPE
}
