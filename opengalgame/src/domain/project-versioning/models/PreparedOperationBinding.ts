/**
 * 准备阶段固定的操作身份和内容指纹。
 * 声明路径只作为规则参数，不进入该绑定。
 */
export interface PreparedOperationBinding {
  readonly operationId: string
  readonly contentFingerprint: string
}
