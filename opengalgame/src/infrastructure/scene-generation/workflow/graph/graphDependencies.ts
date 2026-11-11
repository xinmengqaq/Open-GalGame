import type { SceneGenerationRuntime } from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneArtifactGateway } from '@application/scene-generation/ports/SceneArtifactGateway'
import type { Agent } from '@infrastructure/ai/agents/Agent'
import type { AgentProgressObserver } from '@infrastructure/ai/execution/AgentProgress'
import type { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import type { FileCheckpointSaver } from '@infrastructure/workflow/checkpoints/FileCheckpointSaver'
import type {
  WebGalSceneAgentInput,
  WebGalSceneAgentOutput
} from '../../agents/WebGalSceneAgentTypes'

export type WebGalGenerationGraphDependencies = {
  saver: FileCheckpointSaver
  stateRoot: string
  artifacts: SceneArtifactGateway
  agent?: Agent<WebGalSceneAgentInput, WebGalSceneAgentOutput>
  runtime?: SceneGenerationRuntime
  budget?: ExecutionBudget
  pauseRequested?: () => boolean
  agentProgress?: AgentProgressObserver
}
