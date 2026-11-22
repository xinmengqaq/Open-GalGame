import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { resolveContained } from '@infrastructure/git/containedPath'

import { readTextRange } from '../tools/textRange'
import { writeVerifiedBytes } from '../tools/verifiedFileWrite'

const SUMMARY_CHARS = 80
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const VERSION_PATTERN = /^[0-9a-f]{64}$/u

export interface ExternalContentReference {
  id: string
  version: string
  summary: string
  charLength: number
  truncated: boolean
}

export interface ExternalContentReadRequest {
  id: string
  version: string
  start?: number
  maxChars?: number
}

export interface ExternalContentRange {
  id: string
  version: string
  content: string
  start: number
  end: number
  charLength?: number
  complete: boolean
  truncated: boolean
}

export interface ExternalContentStore {
  put(text: string, signal?: AbortSignal): Promise<ExternalContentReference>

  read(request: ExternalContentReadRequest, signal?: AbortSignal): Promise<ExternalContentRange>
}

export class FileContextContentStore implements ExternalContentStore {
  constructor(private readonly root: string) {}

  async put(text: string, signal?: AbortSignal): Promise<ExternalContentReference> {
    const bytes = Buffer.from(text, 'utf8')
    const version = createHash('sha256').update(bytes).digest('hex')
    const id = randomUUID()
    const absolute = await resolveContained(this.root, `${id}/${version}.txt`)
    await writeVerifiedBytes(absolute, bytes, signal)
    const summary = summarize(text)
    return {
      id,
      version,
      summary,
      charLength: codePointLength(text),
      truncated: summary !== text
    }
  }

  async read(
    request: ExternalContentReadRequest,
    signal?: AbortSignal
  ): Promise<ExternalContentRange> {
    if (!ID_PATTERN.test(request.id) || !VERSION_PATTERN.test(request.version)) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '外置内容引用无效' })
    }
    const relative = `${request.id}/${request.version}.txt`
    const absolute = await resolveContained(this.root, relative)
    try {
      await fs.lstat(absolute)
    } catch (error) {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '外置内容版本不存在',
        cause: error
      })
    }
    const range = await readTextRange(absolute, request.start ?? 0, request.maxChars, signal)
    return {
      id: request.id,
      version: request.version,
      content: range.content,
      start: range.start,
      end: range.end,
      ...(range.charLength !== undefined ? { charLength: range.charLength } : {}),
      complete: range.complete,
      truncated: range.truncated
    }
  }
}

function summarize(text: string): string {
  const points = [...text]
  if (points.length <= SUMMARY_CHARS) return text
  return `${points.slice(0, SUMMARY_CHARS).join('')}…`
}

function codePointLength(text: string): number {
  return [...text].length
}
