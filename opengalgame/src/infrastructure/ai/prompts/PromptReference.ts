import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

const AGENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const MAX_AGENT_ID_LENGTH = 64

export interface PromptReference {
  agentId: string
}

/**
 * @throws {AppException} 标识为空、含路径符号或超出长度。
 */
export function assertAgentId(agentId: string): string {
  if (!AGENT_ID_PATTERN.test(agentId) || agentId.length > MAX_AGENT_ID_LENGTH) {
    throw new AppException({ code: ErrorCodes.invalidConfig, msg: '智能体标识无效' })
  }
  return agentId
}

/**
 * @throws {AppException} 标识为空、含路径符号或超出长度。
 */
export function assertPromptReference(reference: PromptReference): string {
  try {
    return assertAgentId(reference.agentId)
  } catch (error) {
    if (error instanceof AppException) {
      throw new AppException({ code: error.code, msg: '系统提示词引用无效', cause: error })
    }
    throw error
  }
}
