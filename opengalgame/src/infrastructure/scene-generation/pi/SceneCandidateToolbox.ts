import { lstat, readFile } from 'node:fs/promises'

import type { AgentTool } from '@earendil-works/pi-agent-core'

import type { SceneGenerationInputsDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationQuestionVO } from '@application/scene-generation/vo/SceneGenerationVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { scheduleLongTimeout } from '@common/longTimeout'
import { AttemptTimedOut, throwIfStopped } from '@infrastructure/ai/execution/executionErrors'
import type { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { noteCandidateRead } from '@infrastructure/ai/execution/ReadLedger'
import { recordWrittenFile } from '@infrastructure/ai/execution/writtenFileLedger'
import { readTextRange, type TextRange } from '@infrastructure/ai/tools/textRange'
import { writeVerifiedBytes } from '@infrastructure/ai/tools/verifiedFileWrite'
import { resolveContained } from '@infrastructure/git/containedPath'
import { digestBytes } from '@infrastructure/git/objects/gitContent'
import { withFileTurn } from '@infrastructure/storage/fileTurn'
import { sceneClarificationQuestionsSchema } from '../agents/WebGalSceneAgentTypes'
import { authorizedInputReadPath } from '../agents/context/authorizedInputs'

/** 读取工具的默认与上限码位数；只限制单次工具结果，不限制创作长度。 */
const DEFAULT_READ_CHARS = 4000
const MAX_READ_CHARS = 8000

/** 当前候选草稿的权威摘要；写入必须与之匹配。 */
export interface SceneDraftFacts {
  readonly path: string
  readonly exists: boolean
  readonly bytes?: number
  readonly revision: string
}

/** 一次成功写入的宿主事实。 */
export interface SceneWriteFact {
  readonly path: string
  readonly bytes: number
  readonly digest: string
}

/** 一次运行共享的读取授权：物理文件白名单与不可变输入快照提供的虚拟正文。 */
export interface SceneReadAuthority {
  /** 候选工作区内允许读取的物理相对路径。 */
  readonly files: ReadonlySet<string>
  /** 当前输入快照的 readPath → 正文；不在磁盘物化。 */
  readonly inputs: ReadonlyMap<string, string>
}

/**
 * 从本次不可变输入快照建立读取授权。
 * 物理白名单只含入口、授权素材与产品元信息，不遍历工作区；旧候选遗留文件天然不可见。
 * @throws {AppException} 授权路径越出候选根或不是普通文件。
 */
export async function createSceneReadAuthority(input: {
  readonly workspaceRoot: string
  readonly entryPath: string
  readonly inputSnapshot: Pick<SceneGenerationInputsDTO, 'assets' | 'documents' | 'prompts'>
}): Promise<SceneReadAuthority> {
  const candidates = new Set<string>([
    input.entryPath,
    ...(input.inputSnapshot.assets ?? []).map((asset) => asset.relativePath),
    'game/config.txt',
    '.opengalgame/scene-locks.json'
  ])
  const files = new Set<string>()
  for (const path of candidates) {
    if (await isAuthorizedRegularFile(input.workspaceRoot, path)) files.add(path)
  }
  const inputs = new Map<string, string>()
  for (const document of input.inputSnapshot.documents ?? [])
    inputs.set(authorizedInputReadPath('documents', document.id), document.body)
  for (const prompt of input.inputSnapshot.prompts ?? [])
    inputs.set(authorizedInputReadPath('prompts', prompt.id), prompt.body)
  return { files, inputs }
}

export interface SceneCandidateToolboxOptions {
  /** 候选工作区根目录；工具只能解析到该目录内。 */
  readonly workspaceRoot: string
  /** 唯一允许写入的候选入口相对路径。 */
  readonly entryPath: string
  /** 本次运行的读取授权；list 与 read 共用同一权威，不遍历工作区。 */
  readonly authority: SceneReadAuthority
  readonly budget: ExecutionBudget
  /** 本次 Pi 运行的取消信号。 */
  readonly signal: AbortSignal
  /** 单次工具期限；到期中止该次工具调用，不冒充用户取消。 */
  readonly toolTimeoutMs?: number
  /** 单次工具结果码位上限；超出的列表或读取被显式截断。 */
  readonly toolResultCharLimit: number
  /**
   * 本轮是否允许在写入前提出一组创作问题。
   * 工作流只在尚无候选、非修复轮且本操作未回答过题组时打开；工具仍自行核对写入互斥。
   */
  readonly allowClarification?: boolean
  /**
   * 真实写入边界前的持久意图。只在路径、修订核对通过且即将写盘时调用；
   * 未发生的写入不会留下 started 记录。
   */
  readonly beforeWrite?: () => Promise<void>
  /**
   * 本代次写入资格。暂停先撤销旧执行资格，迟到的工具调用必须在落盘前被拒绝。
   */
  readonly writeAuthority?: { assertActive(): void }
}

/**
 * 绑定一次运行的工具集：列出授权目录、按范围读取、唯一候选写工具。
 * 工具不保存应用状态，也不发布候选修订；写入成功只返回实际字节数与摘要。
 */
export class SceneCandidateToolbox {
  private readonly workspaceRoot: string
  private readonly entryPath: string
  private readonly authority: SceneReadAuthority
  private readonly budget: ExecutionBudget
  private readonly signal: AbortSignal
  private readonly toolTimeoutMs: number | undefined
  private readonly toolResultCharLimit: number
  private readonly allowClarification: boolean
  private readonly beforeWrite: (() => Promise<void>) | undefined
  private readonly writeAuthority: { assertActive(): void } | undefined
  private readonly writes: SceneWriteFact[] = []
  private readonly attempts: SceneWriteFact[] = []
  private askedQuestions: readonly SceneGenerationQuestionVO[] | undefined
  private blockedReason: string | undefined

  readonly tools: readonly AgentTool[]

  /**
   * @param options - 已由宿主绑定到本次执行的工作区、目标和取消信号。
   * @throws {AppException} 入口或授权路径不在候选根内。
   */
  constructor(options: SceneCandidateToolboxOptions) {
    this.workspaceRoot = options.workspaceRoot
    this.entryPath = options.entryPath
    this.authority = options.authority
    this.budget = options.budget
    this.signal = options.signal
    this.toolTimeoutMs = options.toolTimeoutMs
    this.toolResultCharLimit = options.toolResultCharLimit
    this.allowClarification = options.allowClarification === true
    this.beforeWrite = options.beforeWrite
    this.writeAuthority = options.writeAuthority
    this.tools = [
      this.listDirectoryTool(),
      this.readTextRangeTool(),
      this.writeCandidateTool(),
      this.reportBlockedTool(),
      // 只在本轮允许写前追问时提供；否则模型看不到一个必然被拒绝的工具。
      ...(this.allowClarification ? [this.requestClarificationTool()] : [])
    ]
  }

  /** 本次运行成功的写入事实，按发生顺序。 */
  get writtenFiles(): readonly SceneWriteFact[] {
    return [...this.writes]
  }

  /** 至少成功写入过一次候选。 */
  get hasWritten(): boolean {
    return this.writes.length > 0
  }

  /** 最后一次成功写入的事实。 */
  get lastWrite(): SceneWriteFact | undefined {
    return this.writes.at(-1)
  }

  /** 已进入写盘边界但未成功返回的写入意图；失败时按磁盘事实核对是否已落盘。 */
  get writeAttempts(): readonly SceneWriteFact[] {
    return [...this.attempts]
  }

  /** 本轮已提出的一组创作问题；没有提问时为 undefined。 */
  get clarificationQuestions(): readonly SceneGenerationQuestionVO[] | undefined {
    return this.askedQuestions
  }

  /** 本轮已经提出过一组问题；与写入互斥。 */
  get hasAsked(): boolean {
    return this.askedQuestions !== undefined
  }

  /** 本轮模型明确报告的阻塞原因；没有报告时为 undefined。 */
  get blocked(): string | undefined {
    return this.blockedReason
  }

  private listDirectoryTool(): AgentTool {
    return {
      name: 'listDirectory',
      label: 'listDirectory',
      description:
        '列出本次授权清单内某个相对目录的直接子项。路径省略或为空时列出候选根；未授权或旧候选遗留路径不会出现。只读，不扩大授权。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '候选根内的相对目录，省略表示根目录' }
        },
        additionalProperties: false
      },
      execute: async (_toolCallId, params, signal) =>
        this.runTool(signal, async (bounded) => {
          throwIfStopped(this.signal)
          throwIfStopped(bounded)
          const path = optionalString(params, 'path') ?? ''
          const listing = limitDirectoryListing(
            path,
            listAuthorizedEntries(this.authority, path),
            this.toolResultCharLimit
          )
          return {
            content: [{ type: 'text', text: JSON.stringify(listing) }],
            details: listing
          }
        })
    }
  }

  private readTextRangeTool(): AgentTool {
    return {
      name: 'readTextRange',
      label: 'readTextRange',
      description:
        '按起始码位和最大字符数读取本次获准的候选文本。同一路径与范围内容未变时只返回版本和 unchanged，不重复返回正文。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本次获准读取的候选根内相对路径' },
          start: { type: 'number', description: '起始码位，从 0 开始；省略为 0' },
          maxChars: {
            type: 'number',
            description: `最多返回的码位数，省略为 ${DEFAULT_READ_CHARS}，单次最多 ${Math.min(MAX_READ_CHARS, this.toolResultCharLimit)}`
          }
        },
        required: ['path'],
        additionalProperties: false
      },
      execute: async (_toolCallId, params, signal) =>
        this.runTool(signal, async (bounded) => {
          throwIfStopped(this.signal)
          throwIfStopped(bounded)
          const path = requiredString(params, 'path')
          const memoryText = this.authority.inputs.get(path)
          if (memoryText === undefined && !this.authority.files.has(path))
            throw new AppException({ code: ErrorCodes.forbidden, msg: '路径不在本次获准读取清单' })
          const start = optionalNonNegativeInteger(params, 'start') ?? 0
          const requested = optionalPositiveInteger(params, 'maxChars') ?? DEFAULT_READ_CHARS
          const maxChars = Math.min(requested, MAX_READ_CHARS, this.toolResultCharLimit)
          const range =
            memoryText === undefined
              ? await readTextRange(
                  await requireRegularFile(this.workspaceRoot, path),
                  start,
                  maxChars,
                  bounded
                )
              : readMemoryTextRange(memoryText, start, maxChars)
          const repeat = noteCandidateRead(
            this.budget,
            { path, start: range.start, end: range.end, version: range.version },
            range.content
          )
          const result = {
            path,
            version: range.version,
            start: range.start,
            end: range.end,
            ...(range.charLength === undefined ? {} : { charLength: range.charLength }),
            complete: range.complete,
            truncated: range.truncated,
            ...(repeat === 'unchanged'
              ? { unchanged: true as const, content: '' }
              : { content: range.content })
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: result
          }
        })
    }
  }

  /**
   * 写前只读追问：只接收题面，不接收题号或候选身份。
   * 应用按顺序分配稳定题/选项 ID；同一轮只能提问一次，且写入后不再允许。
   */
  private requestClarificationTool(): AgentTool {
    return {
      name: 'requestClarification',
      label: 'requestClarification',
      description:
        '在尚无候选的首次生成前，请作者确认无法从已确认输入推导的创作决定。写 1 到 4 题，每题恰好三个选项；只问阻碍开始创作的问题，不要重复已确认的事实。只读，不写文件；本轮只能提问一次，提问后立即结束，与 writeCandidate 互斥。',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '按顺序排列的 1 到 4 个创作问题',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: '问题题干，最多 500 字' },
                detail: { type: 'string', description: '补充说明，最多 2000 字' },
                options: {
                  type: 'array',
                  description: '恰好三个可选项',
                  minItems: 3,
                  maxItems: 3,
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: '选项标题，最多 200 字' },
                      description: { type: 'string', description: '选项说明，最多 2000 字' }
                    },
                    required: ['label', 'description'],
                    additionalProperties: false
                  }
                }
              },
              required: ['prompt', 'options'],
              additionalProperties: false
            }
          }
        },
        required: ['questions'],
        additionalProperties: false
      },
      execute: async (_toolCallId, params, signal) =>
        this.runTool(signal, async (bounded) => {
          throwIfStopped(this.signal)
          throwIfStopped(bounded)
          if (!this.allowClarification)
            throw new AppException({ code: ErrorCodes.forbidden, msg: '当前轮次不允许创作提问' })
          if (this.hasWritten)
            throw new AppException({
              code: ErrorCodes.operationConflict,
              msg: '本轮已经写入候选，不能再提问'
            })
          if (this.askedQuestions !== undefined)
            throw new AppException({
              code: ErrorCodes.operationConflict,
              msg: '本轮已经提出过一组创作问题'
            })
          const parsed = sceneClarificationQuestionsSchema.safeParse(readParams(params).questions)
          if (!parsed.success)
            throw new AppException({
              code: ErrorCodes.invalidRequest,
              msg: '创作提问必须为 1 到 4 题，每题恰好三个选项，且题干、标题与说明不能为空'
            })
          const questions: SceneGenerationQuestionVO[] = parsed.data.map(
            (question, questionIndex) => ({
              questionId: `q${questionIndex + 1}`,
              prompt: question.prompt,
              ...(question.detail ? { detail: question.detail } : {}),
              options: question.options.map((option, optionIndex) => ({
                id: `q${questionIndex + 1}o${optionIndex + 1}`,
                label: option.label,
                description: option.description
              }))
            })
          )
          this.askedQuestions = questions
          const result = { questions }
          return {
            content: [
              {
                type: 'text' as const,
                text: `已记录 ${questions.length} 个创作问题，等待作者回答。`
              }
            ],
            details: result,
            terminate: true
          }
        })
    }
  }

  /**
   * 明确报告无法继续：只接收进程内原因，不写文件、不冒充创作提问。
   * 报告后本轮立即结束；宿主按真实候选状态进入修正等待。
   */
  private reportBlockedTool(): AgentTool {
    return {
      name: 'reportBlocked',
      label: 'reportBlocked',
      description:
        '无法在不编造事实的情况下继续时，向宿主报告阻塞原因。只读，不写文件；报告后立即结束本轮。需要作者确认创作决定时用 requestClarification，不要用本工具代替提问。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '阻塞原因，最多 500 字' }
        },
        required: ['reason'],
        additionalProperties: false
      },
      execute: async (_toolCallId, params, signal) =>
        this.runTool(signal, async (bounded) => {
          throwIfStopped(this.signal)
          throwIfStopped(bounded)
          if (this.askedQuestions !== undefined)
            throw new AppException({
              code: ErrorCodes.operationConflict,
              msg: '本轮已经提出创作问题，不能再报告阻塞'
            })
          if (this.blockedReason !== undefined)
            throw new AppException({
              code: ErrorCodes.operationConflict,
              msg: '本轮已经报告过阻塞'
            })
          const reason = requiredString(params, 'reason').trim()
          if (reason.length === 0 || [...reason].length > 500)
            throw new AppException({
              code: ErrorCodes.invalidRequest,
              msg: '阻塞原因不能为空且不能超过 500 字'
            })
          this.blockedReason = reason
          return {
            content: [{ type: 'text' as const, text: '已记录本轮阻塞原因，等待作者决定。' }],
            details: { reason },
            terminate: true
          }
        })
    }
  }

  private writeCandidateTool(): AgentTool {
    return {
      name: 'writeCandidate',
      label: 'writeCandidate',
      description:
        '用完整脚本内容原子替换唯一授权候选入口。写入前必须给出与当前 draft.revision 相同的 expectedRevision；摘要不符时不写入。唯一写工具。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '候选入口相对路径，必须与工作流事实中的 draft.path 一致'
          },
          content: { type: 'string', description: '完整候选脚本内容' },
          expectedRevision: {
            type: 'string',
            description: '当前草稿摘要；入口不存在时使用 absent'
          }
        },
        required: ['path', 'content', 'expectedRevision'],
        additionalProperties: false
      },
      execute: async (_toolCallId, params, signal) =>
        this.runTool(signal, async (bounded) => {
          throwIfStopped(this.signal)
          throwIfStopped(bounded)
          if (this.askedQuestions !== undefined)
            throw new AppException({
              code: ErrorCodes.operationConflict,
              msg: '本轮已经提出创作问题，不能再写入候选'
            })
          const path = requiredString(params, 'path')
          const content = requiredText(params, 'content')
          const expectedRevision = requiredString(params, 'expectedRevision')
          if (content.trim().length === 0)
            throw new AppException({ code: ErrorCodes.invalidRequest, msg: '候选内容不能为空' })
          if (path !== this.entryPath)
            throw new AppException({ code: ErrorCodes.forbidden, msg: '文件不在本次候选写入清单' })
          const absolute = await resolveContained(this.workspaceRoot, path)
          return withFileTurn(absolute, async () => {
            throwIfStopped(bounded)
            const current = await readSceneDraft(this.workspaceRoot, this.entryPath, bounded)
            if (current.revision !== expectedRevision)
              throw new AppException({
                code: ErrorCodes.operationConflict,
                msg: `草稿摘要不匹配，当前 revision 为 ${current.revision}`
              })
            const bytes = Buffer.from(content, 'utf8')
            const digest = digestBytes(bytes)
            const fact: SceneWriteFact = { path, bytes: bytes.byteLength, digest }
            // 已撤销资格的迟到调用不能在账本里留下 started，也不能进入写盘。
            this.writeAuthority?.assertActive()
            // 先保留写入意图：写盘抛错时宿主仍能按当前草稿核对是否已落盘。
            this.attempts.push(fact)
            await this.beforeWrite?.()
            // 持久意图写入期间可能发生暂停或新代次接管；落盘前再核对一次写资格。
            this.writeAuthority?.assertActive()
            throwIfStopped(bounded)
            await writeVerifiedBytes(absolute, bytes, bounded)
            const actual = await readFile(absolute)
            if (digestBytes(actual) !== digest)
              throw new AppException({
                code: ErrorCodes.internalError,
                msg: '候选回读摘要与写入不一致'
              })
            this.writes.push(fact)
            recordWrittenFile(this.budget, { path, version: `${bytes.byteLength}:${digest}` })
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `已写入 ${path}：${bytes.byteLength} 字节，当前摘要 ${digest}`
                }
              ],
              details: fact
            }
          })
        })
    }
  }

  /**
   * 在本次运行信号与工具调用信号之上叠加单次工具期限。
   * 期限只中止该次工具调用，不冒充用户取消；完成或失败后清理计时器。
   */
  private async runTool<T>(
    toolSignal: AbortSignal | undefined,
    task: (bounded: AbortSignal) => Promise<T>
  ): Promise<T> {
    const combined = this.combinedSignal(toolSignal)
    if (this.toolTimeoutMs === undefined) return task(combined)
    const deadline = new AbortController()
    const cancelDeadline = scheduleLongTimeout(this.toolTimeoutMs, () =>
      deadline.abort(new AttemptTimedOut())
    )
    try {
      return await task(AbortSignal.any([combined, deadline.signal]))
    } finally {
      cancelDeadline()
    }
  }

  /** 宿主取消信号与工具调用信号任一中断都必须停止。 */
  private combinedSignal(toolSignal: AbortSignal | undefined): AbortSignal {
    if (!toolSignal) return this.signal
    return AbortSignal.any([this.signal, toolSignal])
  }
}

/**
 * 读取当前候选草稿的权威事实。入口不存在时返回 absent。
 * @throws {AppException} 路径越界、链接或不是普通文件。
 */
export async function readSceneDraft(
  workspaceRoot: string,
  entryPath: string,
  signal?: AbortSignal
): Promise<SceneDraftFacts> {
  throwIfStopped(signal)
  const absolute = await resolveContained(workspaceRoot, entryPath)
  try {
    const stats = await lstat(absolute)
    if (stats.isSymbolicLink() || !stats.isFile())
      throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
    const bytes = await readFile(absolute)
    return {
      path: entryPath,
      exists: true,
      bytes: bytes.byteLength,
      revision: digestBytes(bytes)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: entryPath, exists: false, revision: 'absent' }
    }
    throw error
  }
}

/**
 * 确认目标路径是候选根内的普通文件，不跟随候选外的链接。
 * @returns 已解析的绝对路径。
 * @throws {AppException} 路径越界或不是普通文件。
 */
async function requireRegularFile(workspaceRoot: string, relativePath: string): Promise<string> {
  const absolute = await resolveContained(workspaceRoot, relativePath)
  const stats = await lstat(absolute).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '候选文件不存在' })
    throw error
  })
  if (stats.isSymbolicLink() || !stats.isFile())
    throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
  return absolute
}

/**
 * 从读取授权派生一层目录视图，不访问文件系统。
 * 旧候选遗留文件不在授权集合中，因此既不可列出也无法借目录名探测。
 * @throws {AppException} 该路径没有任何本次授权条目。
 */
function listAuthorizedEntries(
  authority: SceneReadAuthority,
  directory: string
): readonly { readonly name: string; readonly kind: 'file' | 'directory' }[] {
  const normalized = directory.replace(/\/+$/, '')
  const prefix = normalized === '' ? '' : `${normalized}/`
  const files = new Set<string>()
  const dirs = new Set<string>()
  for (const path of [...authority.files, ...authority.inputs.keys()]) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    if (rest === '') continue
    const separator = rest.indexOf('/')
    if (separator === -1) files.add(rest)
    else dirs.add(rest.slice(0, separator))
  }
  if (files.size === 0 && dirs.size === 0)
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '目录不存在或不在本次授权范围'
    })
  return [
    ...[...dirs].sort((left, right) => left.localeCompare(right)).map((name) => ({
      name,
      kind: 'directory' as const
    })),
    ...[...files].sort((left, right) => left.localeCompare(right)).map((name) => ({
      name,
      kind: 'file' as const
    }))
  ]
}

/**
 * 在不可变输入快照的正文上按码位分段读取，不物化物理文件。
 * 返回与文件读取相同的范围事实，便于模型沿用同一分段策略。
 */
function readMemoryTextRange(text: string, start: number, maxChars: number): TextRange {
  const characters = [...text]
  const end = Math.min(characters.length, start + maxChars)
  return {
    content: characters.slice(start, end).join(''),
    version: `memory:${digestBytes(Buffer.from(text))}`,
    start,
    end,
    charLength: characters.length,
    complete: end >= characters.length,
    truncated: end < characters.length
  }
}

/**
 * @returns 授权路径是否为候选根内的普通文件；不存在时返回 false。
 * @throws {AppException} 路径越界或不是普通文件。
 */
async function isAuthorizedRegularFile(
  workspaceRoot: string,
  relativePath: string
): Promise<boolean> {
  const absolute = await resolveContained(workspaceRoot, relativePath)
  try {
    const stats = await lstat(absolute)
    if (stats.isSymbolicLink() || !stats.isFile())
      throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * 按码位上限截断目录列表，仍返回有效 JSON 和明确的 truncated 标记。
 * 目录项本身通常远小于上限；保留至少一项避免空列表被误读为目录为空。
 */
function limitDirectoryListing(
  path: string,
  entries: readonly { readonly name: string; readonly kind: 'file' | 'directory' }[],
  limit: number
): {
  path: string
  entries: readonly { readonly name: string; readonly kind: 'file' | 'directory' }[]
  truncated?: true
} {
  const kept: { name: string; kind: 'file' | 'directory' }[] = []
  for (const entry of entries) {
    const next = [...kept, entry]
    if (kept.length > 0 && [...JSON.stringify({ path, entries: next })].length > limit) break
    kept.push(entry)
  }
  return {
    path,
    entries: kept,
    ...(kept.length < entries.length ? { truncated: true as const } : {})
  }
}

function readParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params))
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '工具参数格式不正确' })
  return params as Record<string, unknown>
}

function requiredString(params: unknown, key: string): string {
  const value = readParams(params)[key]
  if (typeof value !== 'string' || value.length === 0)
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: `工具参数 ${key} 不能为空` })
  return value
}

/** 完整脚本允许空字符串作为一次显式写入；校验会拒绝空入口内容。 */
function requiredText(params: unknown, key: string): string {
  const value = readParams(params)[key]
  if (typeof value !== 'string')
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: `工具参数 ${key} 必须是文本` })
  return value
}

function optionalString(params: unknown, key: string): string | undefined {
  const value = readParams(params)[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string')
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: `工具参数 ${key} 必须是文本` })
  return value
}

function optionalNonNegativeInteger(params: unknown, key: string): number | undefined {
  const value = readParams(params)[key]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: `工具参数 ${key} 必须是非负整数`
    })
  return value as number
}

function optionalPositiveInteger(params: unknown, key: string): number | undefined {
  const value = readParams(params)[key]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: `工具参数 ${key} 必须是正整数` })
  return value as number
}
