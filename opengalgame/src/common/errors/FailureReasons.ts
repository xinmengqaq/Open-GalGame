/**
 * 失败结果的可选结构化原因。
 * 只给数值码相同、业务含义不同、又要跨进程判别的少数抛点使用；
 * 它是失败信封里的窄投影，不是通用错误模型。稳定小驼峰 token，不承载可见文案。
 */
export const FailureReasons = {
  promptReferenceDuplicate: 'promptReferenceDuplicate',
  promptReferenceTargetMissing: 'promptReferenceTargetMissing'
} as const
