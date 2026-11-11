import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'
import type { ProjectFileAssetKind, ProjectInputSource } from '../models/ProjectInputSource'

/**
 * @throws {AppException} 身份、版本或必需内容不成立。
 */
export function validateProjectInputSource(source: ProjectInputSource): void {
  requireText(source.sourceId, ProjectFileErrorCodes.blankSourceId, '来源身份不能为空')
  requireText(source.version, ProjectFileErrorCodes.blankSourceVersion, '来源版本不能为空')
  switch (source.contentKind) {
    case 'text':
      validateTextSource(source)
      return
    case 'image':
    case 'audio':
    case 'video':
      validateAssetSource(source)
      return
    default:
      throw new AppException({
        code: ProjectFileErrorCodes.invalidAssetPurpose,
        msg: '文件类型不受支持'
      })
  }
}

function validateTextSource(source: Extract<ProjectInputSource, { contentKind: 'text' }>): void {
  if (source.textKind === 'document') {
    requireText(source.title, ProjectFileErrorCodes.blankSourceContent, '文档标题不能为空')
    requireText(source.body, ProjectFileErrorCodes.blankSourceContent, '文档正文不能为空')
    if (!Array.isArray(source.topics)) {
      throw new AppException({
        code: ProjectFileErrorCodes.blankSourceContent,
        msg: '文档主题标签无效'
      })
    }
    for (const topic of source.topics) {
      requireText(topic, ProjectFileErrorCodes.blankSourceContent, '主题标签不能为空')
    }
    if (source.importFormat !== 'markdown' && source.importFormat !== 'plainText') {
      throw new AppException({
        code: ProjectFileErrorCodes.blankSourceContent,
        msg: '文档导入格式不受支持'
      })
    }
    return
  }
  throw new AppException({
    code: ProjectFileErrorCodes.blankSourceContent,
    msg: '文本来源子类型不受支持'
  })
}

function validateAssetSource(
  source: Extract<ProjectInputSource, { contentKind: ProjectFileAssetKind }>
): void {
  requireText(source.name, ProjectFileErrorCodes.blankSourceContent, '素材名称不能为空')
  requireText(source.fileId, ProjectFileErrorCodes.blankSourceContent, '文件引用身份不能为空')
}

function requireText(value: string, code: number, msg: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppException({ code, msg })
  }
}
