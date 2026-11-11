import { z } from 'zod'
import type {
  SceneGenerationExecution,
  SceneGenerationCandidate
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { ReplySceneGenerationInteractionDTO } from '@application/scene-generation/dto/SceneGenerationDTO'

export type WebGalSceneMemoryMessage = { id: string; role: 'user' | 'assistant'; content: string }

export type WebGalSceneAgentInput = {
  mode: 'generate' | 'repair' | 'finalize'
  execution: SceneGenerationExecution
  candidate?: SceneGenerationCandidate
  summary?: string
  writtenFiles?: readonly string[]
  memoryMessages?: readonly WebGalSceneMemoryMessage[]
  confirmedReplies?: readonly ReplySceneGenerationInteractionDTO[]
}

export type SceneAgentAction =
  | 'submit_scene_result'
  | 'report_blocked'
  | 'request_clarification'

const agentQuestionOption = z.object({
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000)
})
const agentQuestion = z.object({
  prompt: z.string().trim().min(1).max(500),
  detail: z.string().trim().max(2000).optional(),
  options: z.array(agentQuestionOption).length(3)
})
/** 工具回退路径的稳定提交名。原生路径不把它当工具调用。 */
export const SCENE_RESULT_TOOL_NAME = 'submit_scene_result'

export const sceneAgentOutputSchema = z
  .object({
    action: z
      .enum(['submit_scene_result', 'report_blocked', 'request_clarification'])
      .describe('本次终态动作：提交候选、报告阻塞或请求澄清。'),
    blockedReason: z.string().trim().min(1).max(500).optional(),
    summary: z.string(),
    writtenFiles: z.array(z.string()),
    usedAssetIds: z.array(z.string()),
    unresolvedIssues: z
      .array(z.string())
      .describe('仅填写阻断审阅的创作冲突：不作决定就无法审阅候选；没有冲突时返回空数组。'),
    tradeoffs: z
      .array(z.string())
      .describe('非阻断说明与取舍，包括未执行的解析、预览或播放验证，以及省略的非必要素材。'),
    questions: z
      .array(agentQuestion)
      .max(4)
      .default([])
      .describe('仅填写无法从已确认输入得出、且阻碍审阅的新问题，0 到 4 题；没有疑问时返回空数组。')
  })
  .superRefine((value, context) => {
    if (value.action === 'report_blocked' && value.blockedReason === undefined)
      context.addIssue({
        code: 'custom',
        path: ['blockedReason'],
        message: '报告阻塞时必须填写具体阻塞'
      })
    if (value.action === 'request_clarification') {
      if (value.questions.length < 1)
        context.addIssue({
          code: 'custom',
          path: ['questions'],
          message: '请求澄清时至少返回 1 个问题'
        })
      if (value.writtenFiles.length > 0)
        context.addIssue({
          code: 'custom',
          path: ['writtenFiles'],
          message: '请求澄清时不能写入文件'
        })
    }
  })
  .meta({
    title: SCENE_RESULT_TOOL_NAME
  })

export type WebGalSceneAgentOutput = Omit<
  z.infer<typeof sceneAgentOutputSchema>,
  'action'
> & {
  /** 旧假智能体可能不返回动作，调用方按 submit_scene_result 兼容。 */
  action?: SceneAgentAction
  memoryMessages: readonly WebGalSceneMemoryMessage[]
}
