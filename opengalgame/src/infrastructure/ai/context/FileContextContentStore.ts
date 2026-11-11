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
  /**
   * @param signal - 取消本次写入。
   * @throws {AppException} 路径越界、写入失败或调用已取消。
   */
  put(text: string, signal?: AbortSignal): Promise<ExternalContentReference>

  /**
   * @param signal - 取消本次读取。
   * @returns 范围内的文本和截断标记。
   * @throws {AppException} 引用越界、版本不存在或编码非法。
   */
  read(request: ExternalContentReadRequest, signal?: AbortSignal): Promise<ExternalContentRange>
}

export class FileContextContentStore implements ExternalContentStore {
  /**
   * @param root - 外置内容根目录。所有标识都在这个目录内解析。
   */
  constructor(private readonly root: string) {}

  /**
   * @param signal - 取消本次写入。
   * @returns 内容引用和不超过固定长度的摘要。
   * @throws {AppException} 写入失败或调用已取消。
   */
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

  /**
   * @param request - 引用、起始码位和最大字符数。
   * @param signal - 取消本次读取。
   * @returns 范围内的文本。读到文件末尾时带真实总长度，否则省略总长度。
   * @throws {AppException} 引用非法、版本不符、编码非法或调用已取消。
   */
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

/**
 * 生成固定长度的摘要。短文本原样返回。
 * @returns 最多 80 个码位的摘要。
 */
function summarize(text: string): string {
  const points = [...text]
  if (points.length <= SUMMARY_CHARS) return text
  return `${points.slice(0, SUMMARY_CHARS).join('')}…`
}

/**
 * 统计 Unicode 码位数量。
 * @returns 码位个数。
 */
function codePointLength(text: string): number {
  return [...text].length
}
