/**
 * project-files 跨功能公共入口。
 * 只重导出既有命名符号，不新增实现；project-files 内部的读写模块仍使用相对导入。
 */
export {
  decodeStorageKey,
  digestBytes,
  digestVersionParts,
  documentBodyPath,
  encodeStorageKey,
  identityFromDescriptorName,
  MAX_IDENTITY_BYTES,
  MAX_JSON_BYTES,
  MAX_MEDIA_BYTES,
  MAX_TEXT_CHARS,
  projectFileLocations,
  sourceDescriptorPath
} from '../projectFilePaths'
export { ProjectFileReadWindow, withProjectFileRead } from '../reading/ProjectFileReadWindow'
