import * as fs from 'node:fs/promises'
import { relative } from 'node:path'

import type { ClientTool } from '@langchain/core/tools'
import { tool } from 'langchain'
import { z } from 'zod'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { resolveContained } from '@infrastructure/git/containedPath'
import { isTemporaryDocumentName } from '@infrastructure/storage/jsonDocument'

import type { WorkspaceBinding } from '../agents/AgentExecution'
import { ExecutionBudget } from '../execution/ExecutionBudget'
import { throwIfStopped } from '../execution/executionErrors'
import { noteCandidateRead } from '../execution/ReadLedger'
import { recordWrittenFile } from '../execution/writtenFileLedger'
import { readTextRange, type TextRange } from './textRange'
import { writeVerifiedBytes } from './verifiedFileWrite'

const fileTurns = new Map<string, Promise<void>>()

export const listDirectorySchema = z.object({
  path: z.string().optional()
})

export const readTextRangeSchema = z.object({
  path: z.string().min(1),
  start: z.number().int().nonnegative(),
  maxChars: z.number().int().positive()
})

export const writeTextSchema = z.object({
  path: z.string().min(1),
  content: z.string()
})

export const replaceTextSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
  expectedMatches: z.number().int().positive()
})

export interface DirectoryEntry {
  name: string
  kind: 'file' | 'directory' | 'other'
}

export interface DirectoryListing {
  path: string
  entries: DirectoryEntry[]
}

export type TextRangeResult = TextRange & { path: string; unchanged?: boolean }

export interface FileChangeResult {
  path: string
  version: string
  replaced?: number
}

interface ToolRuntimeLike {
  context?: unknown
  signal?: AbortSignal
}

/**
 * 创建列目录、范围读取、写入和精确替换四个工具。
 * 工具不保存工作区；调用时从本次运行上下文读取授权。
 */
export function createWorkspaceFileTools(): ClientTool[] {
  return [listDirectoryTool(), readTextRangeTool(), writeTextTool(), replaceTextTool()]
}

/** 列出授权根内的一层目录。空路径表示根目录本身。 */
function listDirectoryTool(): ClientTool {
  return tool(
    async (input: z.infer<typeof listDirectorySchema>, runtime: ToolRuntimeLike) => {
      const workspace = requireWorkspace(runtime)
      const signal = runtime.signal
      throwIfStopped(signal)
      const path = input.path ?? ''
      const absolute = await resolveWorkspacePath(workspace.root, path)
      let listing
      try {
        listing = await fs.readdir(absolute, { withFileTypes: true })
      } catch (error) {
        throw new AppException({
          code: ErrorCodes.invalidRequest,
          msg: '目录无法读取',
          cause: error
        })
      }
      const entries: DirectoryEntry[] = listing
        .filter((entry) => !isTemporaryDocumentName(entry.name))
        .map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
        }))
      return { path, entries } satisfies DirectoryListing
    },
    {
      name: 'listDirectory',
      description: '列出授权工作区内某一相对目录的直接子项。路径省略或为空时列出工作区根。',
      schema: listDirectorySchema
    }
  )
}

/**
 * 按码位范围读取文本，并标明是否截断。
 * @returns 文本、版本和截断信息。
 */
function readTextRangeTool(): ClientTool {
  return tool(
    async (input: z.infer<typeof readTextRangeSchema>, runtime: ToolRuntimeLike) => {
      const workspace = requireWorkspace(runtime)
      const signal = runtime.signal
      const absolute = await resolveWorkspacePath(workspace.root, input.path)
      const range = await readTextRange(absolute, input.start, input.maxChars, signal)
      const budget = readBudget(runtime)
      if (budget === undefined) return { path: input.path, ...range } satisfies TextRangeResult
      const repeat = noteCandidateRead(
        budget,
        { path: input.path, start: range.start, end: range.end, version: range.version },
        range.content
      )
      if (repeat === 'unchanged') {
        return {
          path: input.path,
          version: range.version,
          start: range.start,
          end: range.end,
          ...(range.charLength === undefined ? {} : { charLength: range.charLength }),
          complete: range.complete,
          truncated: range.truncated,
          content: '',
          unchanged: true
        } satisfies TextRangeResult
      }
      return { path: input.path, ...range } satisfies TextRangeResult
    },
    {
      name: 'readTextRange',
      description:
        '按起始码位和最大字符数读取授权工作区内的文本。结果会标明版本以及是否截断。同一路径与范围内容未变时只返回版本和 unchanged，不重复返回正文。',
      schema: readTextRangeSchema
    }
  )
}

/** 写入相对路径的完整文本。只读授权会失败。 */
function writeTextTool(): ClientTool {
  return tool(
    async (input: z.infer<typeof writeTextSchema>, runtime: ToolRuntimeLike) => {
      const workspace = requireWritable(runtime)
      const signal = runtime.signal
      const absolute = await resolveWorkspacePath(workspace.root, input.path)
      await requireWritePath(workspace, absolute)
      await withFileTurn(absolute, () =>
        writeVerifiedBytes(absolute, Buffer.from(input.content, 'utf8'), signal)
      )
      const version = await versionOf(absolute)
      rememberWrittenFile(runtime, input.path, version)
      return { path: input.path, version } satisfies FileChangeResult
    },
    {
      name: 'writeText',
      description: '把文本写入授权工作区内的相对路径。不能指定工作区根或命令。',
      schema: writeTextSchema
    }
  )
}

/**
 * 按预期出现次数替换文本。次数不符时不修改文件。
 * @throws {AppException} 匹配次数不符、路径越界或工作区不可写。
 */
function replaceTextTool(): ClientTool {
  return tool(
    async (input: z.infer<typeof replaceTextSchema>, runtime: ToolRuntimeLike) => {
      const workspace = requireWritable(runtime)
      const signal = runtime.signal
      const absolute = await resolveWorkspacePath(workspace.root, input.path)
      await requireWritePath(workspace, absolute)
      await withFileTurn(absolute, async () => {
        throwIfStopped(signal)
        const current = decodeStrictUtf8(await fs.readFile(absolute))
        const found = countMatches(current, input.oldText)
        if (found !== input.expectedMatches) {
          throw new AppException({
            code: ErrorCodes.invalidRequest,
            msg: '替换次数与预期不一致，文件未修改'
          })
        }
        const next = current.split(input.oldText).join(input.newText)
        await writeVerifiedBytes(absolute, Buffer.from(next, 'utf8'), signal)
      })
      const version = await versionOf(absolute)
      rememberWrittenFile(runtime, input.path, version)
      return {
        path: input.path,
        version,
        replaced: input.expectedMatches
      } satisfies FileChangeResult
    },
    {
      name: 'replaceText',
      description: '在授权工作区的相对路径中替换文本。必须给出预期匹配次数，次数不符则不修改文件。',
      schema: replaceTextSchema
    }
  )
}

/** 把成功写入留在本次执行的预算上。消息历史被裁剪后仍能核对。 */
function rememberWrittenFile(runtime: ToolRuntimeLike, path: string, version: string): void {
  const context = runtime.context
  if (!context || typeof context !== 'object' || !('budget' in context)) return
  if (!(context.budget instanceof ExecutionBudget)) return
  recordWrittenFile(context.budget, { path, version })
}

/** 从本次运行上下文取出预算，用来记录回读事实。没有预算时返回 undefined。 */
function readBudget(runtime: ToolRuntimeLike): ExecutionBudget | undefined {
  const context = runtime.context
  if (!context || typeof context !== 'object' || !('budget' in context)) return undefined
  return context.budget instanceof ExecutionBudget ? context.budget : undefined
}

/**
 * 解析工作区根或根内相对路径。空路径不交给相对路径检查。
 * @param root - 调用方授予的工作区根。
 * @param relativePath - 模型给出的相对路径。空字符串表示根。
 * @returns 确认仍在根内的绝对路径。
 * @throws {AppException} 路径绝对、越界或链接逃逸。
 */
export async function resolveWorkspacePath(root: string, relativePath: string): Promise<string> {
  if (relativePath === '') {
    try {
      return await fs.realpath(root)
    } catch (error) {
      throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围', cause: error })
    }
  }
  return resolveContained(root, relativePath)
}

/** 同一绝对路径上的修改串行执行，避免后一次静默覆盖前一次。 */
export function withFileTurn<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = fileTurns.get(key) ?? Promise.resolve()
  const run = previous.then(task)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  fileTurns.set(key, settled)
  void settled.then(() => {
    if (fileTurns.get(key) === settled) fileTurns.delete(key)
  })
  return run
}

/**
 * 从工具运行时取出工作区授权。授权只来自本次运行上下文，不从进程内作用域补取。
 * @throws {AppException} 本次上下文没有工作区。
 */
function requireWorkspace(runtime: ToolRuntimeLike): WorkspaceBinding {
  const workspace = readWorkspace(runtime.context)
  if (!workspace) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '本次执行没有授权工作区' })
  }
  return workspace
}

/**
 * @throws {AppException} 没有授权，或授权只读。
 */
function requireWritable(runtime: ToolRuntimeLike): WorkspaceBinding {
  const workspace = requireWorkspace(runtime)
  if (!workspace.writable) {
    throw new AppException({ code: ErrorCodes.forbidden, msg: '当前工作区不允许写入' })
  }
  return workspace
}

/**
 * @returns 形状符合约定时返回绑定，否则为 undefined。
 */
function readWorkspace(context: unknown): WorkspaceBinding | undefined {
  if (!context || typeof context !== 'object' || !('workspace' in context)) return undefined
  const workspace = context.workspace
  if (!workspace || typeof workspace !== 'object') return undefined
  if (!('root' in workspace) || typeof workspace.root !== 'string') return undefined
  if (!('writable' in workspace) || typeof workspace.writable !== 'boolean') return undefined
  const writablePaths = 'writablePaths' in workspace ? workspace.writablePaths : undefined
  if (
    writablePaths !== undefined &&
    (!Array.isArray(writablePaths) || writablePaths.some((path) => typeof path !== 'string'))
  ) {
    throw new AppException({ code: ErrorCodes.forbidden, msg: '候选写入授权无效' })
  }
  return { root: workspace.root, writable: workspace.writable, writablePaths }
}

/** 根据真实解析位置核对精确写入清单，不允许改动候选区内其他文件。 */
async function requireWritePath(workspace: WorkspaceBinding, absolute: string): Promise<void> {
  if (workspace.writablePaths === undefined) return
  for (const path of workspace.writablePaths) {
    const allowed = await resolveWorkspacePath(workspace.root, path)
    if (relative(allowed, absolute) === '') return
  }
  throw new AppException({ code: ErrorCodes.forbidden, msg: '文件不在本次候选脚本写入范围' })
}

/**
 * 按严格 UTF-8 解码文件字节。非法字节不替换成其他字符。
 * @throws {AppException} 字节不是合法 UTF-8。
 */
function decodeStrictUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '文件不是合法的 UTF-8',
      cause: error
    })
  }
}

function countMatches(text: string, needle: string): number {
  let count = 0
  let from = 0
  while (from <= text.length) {
    const found = text.indexOf(needle, from)
    if (found < 0) break
    count += 1
    from = found + needle.length
  }
  return count
}

/**
 * 读取文件当前版本。路径必须仍在原工作区内；这里只读取已解析文件的状态。
 * @throws {AppException} 写入后无法读取文件状态。
 */
async function versionOf(absolutePath: string): Promise<string> {
  try {
    const stat = await fs.stat(absolutePath)
    return `${stat.size}:${stat.mtimeMs}:${stat.ino}`
  } catch (error) {
    throw new AppException({
      code: ErrorCodes.internalError,
      msg: '文件写入后无法核对',
      cause: error
    })
  }
}
