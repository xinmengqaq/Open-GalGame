/**
 * 预览与导出共同核对、允许使用的 WebGAL 引擎版本。
 * 导出 wire schema、输入校验、候选启动和运行时扩展都引用这里；
 * 升级版本时必须同步重新审计兼容性、模板与导出行为，不能只改常量。
 */
export const WEBGAL_AUDITED_VERSION = '4.6.5' as const
