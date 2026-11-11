import type { CandidatePreviewReadContext } from '../models/CandidatePreviewReadContext'
import type { CandidatePreviewIssueVO, CandidatePreviewVO } from '../vo/CandidatePreviewVO'
import type { SceneParseDiagnostic } from '../../scenes/models/ParsedScene'
import type { SceneReferenceFact } from '../../scenes/models/SceneReferenceFact'

const diagnosticMessages: Record<SceneParseDiagnostic['kind'], string> = {
  'unknown-command': '有一条语句当前不能识别',
  'unsupported-command': '有一条语句当前不能播放',
  'invalid-argument': '有一条语句使用了当前不支持的参数',
  'unsupported-dialogue': '生成对白必须使用显式 say，旁白必须使用 -clear'
}

const referenceMessages: Partial<Record<SceneReferenceFact['status'], string>> = {
  missing: '缺少素材',
  external: '素材引用超出当前候选',
  'invalid-path': '素材引用无效'
}

export function toCandidatePreviewIssues(
  diagnostics: readonly SceneParseDiagnostic[],
  references: readonly SceneReferenceFact[]
): readonly CandidatePreviewIssueVO[] {
  return [
    ...diagnostics.map((diagnostic) => ({ message: diagnosticMessages[diagnostic.kind] })),
    ...references.flatMap((reference) => {
      const message = referenceMessages[reference.status]
      if (!message) return []
      const assetName = assetDisplayName(reference.runtimeReference)
      return [assetName === undefined ? { message } : { message, assetName }]
    })
  ]
}

export function toCandidatePreviewVO(context: CandidatePreviewReadContext): CandidatePreviewVO {
  return {
    projectId: context.session.projectId,
    sceneId: context.session.sceneId,
    sceneName: context.session.sceneName,
    readOnly: true,
    candidate: {
      previewSessionId: context.session.previewSessionId,
      candidateSnapshotId: context.session.candidateSnapshotId,
      expiresAt: context.session.expiresAt
    },
    contentBasis: {
      digest: context.snapshot.digest,
      parserVersion: context.compatibility.parserVersion,
      engineVersion: context.compatibility.engineVersion
    },
    issues: context.issues
  }
}

function assetDisplayName(reference: string): string | undefined {
  const normalized = reference.replaceAll('\\', '/')
  if (
    normalized.trim() === '' ||
    normalized.includes('/') ||
    normalized.includes('..') ||
    /^[a-z]+:/iu.test(normalized)
  ) {
    return undefined
  }
  return normalized
}
