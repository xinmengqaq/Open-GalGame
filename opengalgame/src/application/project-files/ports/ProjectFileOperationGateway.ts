import type { VerifiedProjectReadLocation } from '../models/ProjectInputSourceReadFacts'
import type { ProjectFolder } from '@domain/project-files/models/ProjectInputCatalog'
import type { ProjectFileAssetKind } from '@domain/project-files/models/ProjectInputSource'
import type { ProjectMediaVO } from '../vo/ProjectMediaVO'

export type ImportFileType = 'document' | ProjectFileAssetKind

export type InspectedImportFile =
  | {
      ok: true
      fileName: string
      fileType: ImportFileType
      importFormat?: 'markdown' | 'plainText'
    }
  | { ok: false; fileName: string; message: string }

export type PreparedProjectFileChange = {
  relativePath: string
  action: 'add' | 'modify' | 'delete'
  bytes?: Uint8Array
  sourceFile?: string
}

export type PreparedCatalogMutation = {
  changes: readonly PreparedProjectFileChange[]
  watchedPaths: readonly string[]
}

export type CatalogWriteFact = {
  folders: readonly ProjectFolder[]
  placements: readonly { sourceId: string; parentFolderId: string }[]
}

export type TextCreateSpec = {
  sourceId: string
  fileName: string
  textKind: 'document'
  format: 'markdown' | 'plainText'
  body: string
}

export type TextBodyUpdateSpec = {
  sourceId: string
  body: string
  expectedVersion: string
}

export type SourceCopySpec = {
  sourceId: string
  newSourceId: string
  newFileId: string
  fileName: string
}

export type LocatedProjectFile = {
  sourceId: string
  fileName: string
  contentKind: 'text' | ProjectFileAssetKind
  textKind?: 'document'
  readable: boolean
  absolutePath: string
}

export interface ProjectFileOperationGateway {
  inspectImportFile(
    project: VerifiedProjectReadLocation,
    localFilePath: string
  ): Promise<InspectedImportFile>

  listOccupiedFileNames(project: VerifiedProjectReadLocation): Promise<readonly string[]>

  prepareImport(
    project: VerifiedProjectReadLocation,
    sourceId: string,
    fileName: string,
    localFilePath: string
  ): Promise<readonly PreparedProjectFileChange[]>

  locateProjectFile(
    project: VerifiedProjectReadLocation,
    sourceId: string
  ): Promise<LocatedProjectFile>

  readProjectMedia(project: VerifiedProjectReadLocation, sourceId: string): Promise<ProjectMediaVO>

  prepareRename(
    project: VerifiedProjectReadLocation,
    sourceId: string,
    newFileName: string
  ): Promise<readonly PreparedProjectFileChange[]>

  prepareDelete(
    project: VerifiedProjectReadLocation,
    sourceId: string
  ): Promise<readonly PreparedProjectFileChange[]>

  prepareCatalogWrite(
    project: VerifiedProjectReadLocation,
    catalog: CatalogWriteFact
  ): Promise<PreparedCatalogMutation>

  prepareTextCreate(
    project: VerifiedProjectReadLocation,
    spec: TextCreateSpec
  ): Promise<readonly PreparedProjectFileChange[]>

  prepareTextUpdate(
    project: VerifiedProjectReadLocation,
    spec: TextBodyUpdateSpec
  ): Promise<readonly PreparedProjectFileChange[]>

  prepareFileCopy(
    project: VerifiedProjectReadLocation,
    spec: SourceCopySpec
  ): Promise<PreparedCatalogMutation>

  prepareSubtreeCopy(
    project: VerifiedProjectReadLocation,
    copies: readonly SourceCopySpec[]
  ): Promise<PreparedCatalogMutation>

  prepareOwnedDeletes(
    project: VerifiedProjectReadLocation,
    sourceIds: readonly string[]
  ): Promise<PreparedCatalogMutation>
}
