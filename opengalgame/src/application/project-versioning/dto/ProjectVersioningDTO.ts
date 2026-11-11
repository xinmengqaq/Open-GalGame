import type { VersionTarget } from '../models/VersionTarget'

/** 用户主动保存，或周期、生成前等系统保存。 */
export type VersionSaveMode = 'manual' | 'system'

/** 普通创作操作或 AI 生成。确认候选不会把来源改成普通操作。 */
export type VersionContentSource = 'operation' | 'ai'

/** 建立或核对作品仓库的首个基线。 */
export type InitializeWorkBaselineDTO = {
  projectId: string
  initialPaths: readonly string[]
}

/** 在已有基线上固定本次操作的范围。 */
export type PrepareVersionOperationDTO = {
  projectId: string
  sourceModule: string
  targets: readonly VersionTarget[]
  changePaths: readonly string[]
  watchedPaths: readonly string[]
}

/** 提交前绑定调用方操作身份。范围必须与已准备操作一致。 */
export type BindCallerVersionOperationDTO = {
  projectId: string
  sourceModule: string
  callerOperationId: string
  operationId: string
  targets: readonly VersionTarget[]
  changePaths: readonly string[]
  watchedPaths: readonly string[]
}

/** 按工程、来源和调用方身份读取已绑定的版本身份。 */
export type ReadCallerVersionOperationDTO = {
  projectId: string
  sourceModule: string
  callerOperationId: string
}

/** 调用方没有工程时，按来源和调用方身份查找绑定。 */
export type FindCallerVersionOperationDTO = {
  sourceModule: string
  callerOperationId: string
}

/** 按原操作身份提交已声明的文件或不可变候选。 */
export type CommitVersionOperationDTO = {
  projectId: string
  operationId: string
  baselineRef: string
  input: FileChangesInputDTO | ImmutableCandidateInputDTO
  saveMode: VersionSaveMode
  contentSource: VersionContentSource
  title: string
  summary: string
}

/** 只读核对一个操作的持久结算。 */
export type ReadVersionOperationDTO = {
  projectId: string
  operationId: string
}

/** 受控回退一个已准备操作，路径以操作记录为准。 */
export type RollbackVersionOperationDTO = {
  projectId: string
  operationId: string
}

/** 结算后的内部维护。不接受保留数量或记录路径。 */
export type PruneVersionRecordsDTO = {
  projectId: string
}

/** 导入、文件操作和编排保存使用的文件变更。 */
export type FileChangesInputDTO = {
  kind: 'files'
  changes: readonly VersionFileChange[]
}

/** 已固定的不可变候选。只有声明路径进入作品。 */
export type ImmutableCandidateInputDTO = {
  kind: 'candidate'
  candidateRef: string
  changes: readonly VersionPathChange[]
}

/** 候选进入作品时的路径动作。内容由候选引用持有。 */
export type VersionPathChange = {
  relativePath: string
  action: 'add' | 'modify' | 'delete'
}

/** 文件变更。删除不携带内容，也不用空字节表示。 */
export type VersionFileChange =
  | {
      relativePath: string
      action: 'add' | 'modify'
      content: VersionContentInput
    }
  | {
      relativePath: string
      action: 'delete'
    }

/** 内联字节或来源模块已经准备好的不可变内容。 */
export type VersionContentInput =
  { kind: 'bytes'; bytes: Uint8Array } | { kind: 'prepared'; contentRef: string }

/** 按工程分页读取用户历史。游标不是 Git 修订。 */
export type ListVersionHistoryDTO = {
  projectId: string
  sourceModule?: string
  target?: VersionTarget
  saveMode?: VersionSaveMode
  contentSource?: VersionContentSource
  cursor?: string
  pageSize: number
}

/** 按历史条目撤销对应的单次操作。 */
export type UndoVersionHistoryDTO = {
  projectId: string
  historyId: string
}

/** 清理单条历史，或清理确认边界及其更早的同类记录。 */
export type ClearVersionHistoryDTO = {
  projectId: string
  selection:
    | { kind: 'entry'; historyId: string }
    | {
        kind: 'category'
        saveMode: VersionSaveMode
        throughHistoryId: string
        sourceModule?: string
        target?: VersionTarget
        contentSource?: VersionContentSource
      }
}
