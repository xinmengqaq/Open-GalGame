import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { resolveContained } from '@infrastructure/git/containedPath'

import { assertPromptReference, type PromptReference } from './PromptReference'

export interface LoadedPrompt {
  reference: PromptReference
  body: string
  digest: string
}

/**
 * 源码树中的系统提示词根目录。
 * 打包后的资源根由装配方另行传入，读取器本身不查看当前工作目录。
 */
export function sourcePromptResourceRoot(): string {
  return fileURLToPath(new URL('../../../../resources/ai/prompts/', import.meta.url))
}

export class FilePromptLoader {
  private readonly resourcesRoot: string

  /** 在构造时把资源根固定为绝对路径。之后工作目录变化不影响读取。 */
  constructor(resourcesRoot: string) {
    this.resourcesRoot = resolve(resourcesRoot)
  }

  /**
   * @param reference - 不含正文的提示词引用。
   * @throws {AppException} 引用非法、文件缺失、正文为空、编码非法或链接越界。
   */
  async load(reference: PromptReference): Promise<LoadedPrompt> {
    const agentId = assertPromptReference(reference)
    let absolute: string
    try {
      absolute = await resolveContained(this.resourcesRoot, `${agentId}/system.md`)
    } catch (error) {
      if (isMissing(error)) throw missing(error)
      throw error
    }
    let bytes: Buffer
    try {
      bytes = await readFile(absolute)
    } catch (error) {
      if (isMissing(error)) throw missing(error)
      throw new AppException({
        code: ErrorCodes.invalidConfig,
        msg: '系统提示词无法读取',
        cause: error
      })
    }
    const body = decodeStrict(bytes)
    if (body.trim().length === 0) {
      throw new AppException({ code: ErrorCodes.invalidConfig, msg: '系统提示词为空' })
    }
    return {
      reference: { agentId },
      body,
      digest: createHash('sha256').update(bytes).digest('hex')
    }
  }
}

/**
 * @throws {AppException} 字节不是合法 UTF-8。
 */
function decodeStrict(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new AppException({
      code: ErrorCodes.invalidConfig,
      msg: '系统提示词不是合法的 UTF-8',
      cause: error
    })
  }
}

/** 判断底层错误是不是文件不存在。 */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function missing(cause: unknown): AppException {
  return new AppException({ code: ErrorCodes.invalidConfig, msg: '系统提示词不存在', cause })
}
