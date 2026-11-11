import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'

import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import {
  createWorkflowExecution,
  type WorkflowExecution
} from '@infrastructure/workflow/WorkflowExecution'
import {
  createWorkflowIdentity,
  type WorkflowIdentity
} from '@infrastructure/workflow/WorkflowIdentity'
import type { FileCheckpointSaver } from '@infrastructure/workflow/checkpoints/FileCheckpointSaver'

const directories: string[] = []
const State = Annotation.Root({
  value: Annotation<string>({ reducer: (_left, right) => right, default: () => '' })
})
const counterGraph = new StateGraph(State)
  .addNode('first', () => ({ value: 'one' }))
  .addNode('second', (state) => ({ value: `${state.value}-two` }))
  .addEdge(START, 'first')
  .addEdge('first', 'second')
  .addEdge('second', END)

export function compileCounter(
  checkpointer: FileCheckpointSaver
): ReturnType<typeof counterGraph.compile> {
  return counterGraph.compile({ checkpointer })
}

export async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'opengalgame-workflow-'))
  directories.push(directory)
  return directory
}

export async function removeTemporaryDirectories(): Promise<void> {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
}

export function identity(overrides: Partial<WorkflowIdentity> = {}): WorkflowIdentity {
  return createWorkflowIdentity({
    projectId: 'project-a',
    threadId: 'thread-a',
    branchId: 'branch-a',
    operationId: 'operation-a',
    ...overrides
  })
}

export function execution(
  stateRoot: string,
  overrides: Partial<WorkflowExecution> = {}
): WorkflowExecution {
  return createWorkflowExecution({
    identity: identity(),
    budget: new ExecutionBudget({ modelAttempts: 4, toolCalls: 4, activeMs: 5_000 }),
    stateRoot,
    recursionLimit: 12,
    ...overrides
  })
}
