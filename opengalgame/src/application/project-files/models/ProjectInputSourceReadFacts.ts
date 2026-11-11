import type { ProjectLocation } from '../../projects/models/ProjectLocation'
import type { ProjectInputSourceFact } from '@domain/project-files/models/ProjectFileDiagnostic'
import type {
  ProjectInputSource,
  ProjectInputSourceSummary
} from '@domain/project-files/models/ProjectInputSource'

/** 已核对登记身份和真实工程身份后的读取位置。不进入返回结果。 */
export type VerifiedProjectReadLocation = {
  projectId: string
  location: ProjectLocation
}

/** 工程内来源的检查事实。重复身份按条目保留，不用后出现的来源覆盖先出现的来源。 */
export type ProjectInputSourceInspectionFact = {
  projectId: string
  inputSourceFormatSupported: boolean
  sources: readonly ProjectInputSourceFact[]
  catalogDamaged: boolean
}

/** 同一次读取窗口内的完整来源事实。 */
export type ProjectInputSourcesReadFact = {
  projectId: string
  readVersion: string
  sources: readonly ProjectInputSource[]
}

export type { ProjectInputSourceSummary }
