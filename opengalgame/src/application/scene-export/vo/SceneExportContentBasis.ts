/**
 * 导出侧消费的场景内容依据。
 * 预览保存记录仍是内容依据的权威；导出只依赖这份同形状契约，
 * 由基础设施边界从预览保存记录显式映射，不反向引用预览类型。
 */
export type SceneExportContentBasis = {
  readonly digest: string
  readonly parserVersion: string
  readonly engineVersion: string
}
