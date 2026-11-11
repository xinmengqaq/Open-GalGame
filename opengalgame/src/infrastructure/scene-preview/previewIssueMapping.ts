import type { SceneParseDiagnostic } from '@application/scenes/models/ParsedScene'
import type { SceneReferenceFact } from '@application/scenes/models/SceneReferenceFact'
import type {
  ScenePreviewIssueCode,
  ScenePreviewIssueVO
} from '@application/scene-preview/vo/ScenePreviewSessionVO'

const diagnosticIssues: Record<
  SceneParseDiagnostic['kind'],
  { code: ScenePreviewIssueCode; message: string }
> = {
  'unknown-command': { code: 'unsupportedStatement', message: '有一条语句当前不能识别' },
  'unsupported-command': { code: 'unsupportedStatement', message: '有一条语句当前不能播放' },
  'invalid-argument': { code: 'unsupportedParameter', message: '有一条语句使用了当前不支持的参数' },
  'unsupported-dialogue': {
    code: 'unsupportedStatement',
    message: '生成对白必须使用显式 say，旁白必须使用 -clear'
  }
}

const referenceIssues: Partial<
  Record<SceneReferenceFact['status'], { code: ScenePreviewIssueCode; message: string }>
> = {
  missing: { code: 'missingAsset', message: '缺少素材' },
  'invalid-path': { code: 'invalidAssetReference', message: '素材引用无效' }
}

export function previewIssuesFromRead(
  diagnostics: readonly SceneParseDiagnostic[],
  references: readonly SceneReferenceFact[]
): readonly ScenePreviewIssueVO[] {
  return [
    ...diagnostics.map((diagnostic) => diagnosticIssues[diagnostic.kind]),
    ...references.flatMap((reference) => {
      const issue = referenceIssues[reference.status]
      return issue ? [issue] : []
    })
  ]
}
