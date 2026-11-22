import type { ProjectWorkspaceVO } from '@application/projects/vo/ProjectWorkspaceVO'
import type {
  SceneGenerationBaseline,
  SceneGenerationCandidate,
  SceneGenerationCommitState,
  SceneGenerationExecution,
  SceneGenerationVersionFacts
} from '../models/SceneGenerationExecution'
import type { SceneSourceLocation } from '../../scenes/models/SceneSourceLocation'

export interface SceneVersionGateway {
  readBaseline(source: SceneSourceLocation): Promise<SceneGenerationBaseline>

  ensureWorkspace(projectId: string): Promise<ProjectWorkspaceVO>

  inspectBaseline(execution: SceneGenerationExecution): Promise<SceneGenerationVersionFacts>

  commitCandidate(
    execution: SceneGenerationExecution,
    candidate: SceneGenerationCandidate,
    requireVersion: (facts: SceneGenerationVersionFacts) => void
  ): Promise<{ commitId: string }>

  readOperationCommit(execution: SceneGenerationExecution): Promise<SceneGenerationCommitState>

  rollbackCandidate(
    execution: SceneGenerationExecution,
    commitId: string
  ): Promise<{ rollbackCommitId: string }>
}
