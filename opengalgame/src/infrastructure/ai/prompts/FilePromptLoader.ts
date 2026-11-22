import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { resolveContained } from '@infrastructure/git/containedPath'

import { assertPromptReference, type PromptReference } from './PromptReference'

export interface LoadedPrompt {
  reference: PromptReference
  body: string
  digest: string
}

export class FilePromptLoader {
  private readonly resourcesRoot: string

  constructor(resourcesRoot: string) {
    this.resourcesRoot = resolve(resourcesRoot)
  }

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

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function missing(cause: unknown): AppException {
  return new AppException({ code: ErrorCodes.invalidConfig, msg: '系统提示词不存在', cause })
}
