/** 第二阶段候选审阅边界标识前缀。不是 LangGraph 检查点，也不写入旧检查点存储。 */
const REVIEW_CHECKPOINT_PREFIX = 'pi-review-'

const REVIEW_CHECKPOINT_REASON = '候选审阅与暂停边界可从执行记录读取'

/**
 * 为一次已发布候选或安全暂停生成稳定的审阅边界标识。
 * 同一操作同一候选修订得到同一标识，便于执行记录、交互与预览互相对照。
 */
export function piReviewCheckpointId(operationId: string, candidateSnapshotId?: string): string {
  return `${REVIEW_CHECKPOINT_PREFIX}${operationId}-${candidateSnapshotId ?? 'none'}`
}

/** 判断标识是否属于 Pi 的审阅边界，避免与旧检查点标识混用。 */
export function isPiReviewCheckpointId(checkpointId: string): boolean {
  return checkpointId.startsWith(REVIEW_CHECKPOINT_PREFIX)
}

/** 审阅边界读取时的安全说明；不包含路径或模型原文。 */
export const PI_REVIEW_CHECKPOINT_REASON = REVIEW_CHECKPOINT_REASON
