import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { resolveContained } from '@infrastructure/git/containedPath'

const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const MAX_SKILL_ID_LENGTH = 64

/** 一个已读取且未修改的技能文件。 */
export interface LoadedSkillFile {
  /** 相对技能根的正斜杠路径。 */
  path: string
  body: string
  digest: string
  bytes: number
}

/** 受信技能包的只读快照。 */
export interface LoadedSkill {
  id: string
  files: readonly LoadedSkillFile[]
  /** 按路径排序后的文件摘要，用于绑定执行使用的技能版本。 */
  digest: string
}

/**
 * 从资源根读取受信技能包。
 *
 * 只读取技能目录内的 Markdown 文件，拒绝链接和越界路径；不执行技能内容。
 * 返回的正文和摘要可在构造系统提示时注入，但本类不负责拼接提示词。
 */
export class FileSkillLoader {
  private readonly skillsRoot: string

  /** 在构造时把资源根固定为绝对路径。之后工作目录变化不影响读取。 */
  constructor(skillsRoot: string) {
    this.skillsRoot = resolve(skillsRoot)
  }

  /**
   * @param skillId - 技能目录名，只允许小写字母、数字和连字符。
   * @throws {AppException} 标识非法、技能缺失、文件不是 UTF-8 或路径越界。
   */
  async load(skillId: string): Promise<LoadedSkill> {
    const id = assertSkillId(skillId)
    const directory = await resolveContained(this.skillsRoot, id)
    const paths = await listMarkdown(directory, '')
    if (!paths.includes('SKILL.md'))
      throw new AppException({
        code: ErrorCodes.invalidConfig,
        msg: '技能描述不存在'
      })
    const files: LoadedSkillFile[] = []
    for (const relative of paths) {
      const absolute = await resolveContained(this.skillsRoot, `${id}/${relative}`)
      const bytes = await readFile(absolute).catch((error: unknown) => {
        throw new AppException({
          code: ErrorCodes.invalidConfig,
          msg: '技能文件无法读取',
          cause: error
        })
      })
      const body = decodeStrict(bytes)
      if (relative === 'SKILL.md' && body.trim().length === 0)
        throw new AppException({ code: ErrorCodes.invalidConfig, msg: '技能描述为空' })
      files.push({
        path: relative,
        body,
        digest: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.byteLength
      })
    }
    const digest = createHash('sha256')
      .update(files.map((file) => `${file.path}\u0000${file.digest}\n`).join(''))
      .digest('hex')
    return { id, files, digest }
  }
}

/**
 * @throws {AppException} 标识为空、含路径符号或超出长度。
 */
function assertSkillId(skillId: string): string {
  if (!SKILL_ID_PATTERN.test(skillId) || skillId.length > MAX_SKILL_ID_LENGTH)
    throw new AppException({ code: ErrorCodes.invalidConfig, msg: '技能标识无效' })
  return skillId
}

/**
 * 递归列出技能目录下所有 Markdown 文件，按路径稳定排序。
 * @param directory - 当前目录绝对路径。
 * @param prefix - 相对技能根的路径前缀。
 * @throws {AppException} 存在链接或目录无法读取。
 */
async function listMarkdown(directory: string, prefix: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error))
      throw new AppException({ code: ErrorCodes.invalidConfig, msg: '技能不存在' })
    throw new AppException({
      code: ErrorCodes.invalidConfig,
      msg: '技能目录无法读取',
      cause: error
    })
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink())
      throw new AppException({ code: ErrorCodes.invalidConfig, msg: '技能目录不能包含链接' })
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...(await listMarkdown(join(directory, entry.name), relative)))
      continue
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(relative)
  }
  return files
}

/** @throws {AppException} 字节不是合法 UTF-8。 */
function decodeStrict(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new AppException({
      code: ErrorCodes.invalidConfig,
      msg: '技能文件不是合法的 UTF-8',
      cause: error
    })
  }
}

/** 判断底层错误是不是文件不存在。 */
function isMissing(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) return false
  return error.code === 'ENOENT'
}
