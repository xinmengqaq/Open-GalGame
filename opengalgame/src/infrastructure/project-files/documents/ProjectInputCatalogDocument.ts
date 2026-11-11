import { z } from 'zod'

import { requireFolderName } from '@domain/project-files/services/folderNameRules'
import { MAX_IDENTITY_BYTES, PROJECT_CATALOG_FORMAT_VERSION } from '../projectFilePaths'

const identity = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => Buffer.byteLength(value) <= MAX_IDENTITY_BYTES && !value.includes('\0'))

export const projectInputCatalogDocumentSchema = z.strictObject({
  formatVersion: z.literal(PROJECT_CATALOG_FORMAT_VERSION),
  projectId: identity,
  folders: z.array(
    z.strictObject({
      folderId: identity,
      parentFolderId: identity.nullable(),
      name: z.string().refine((value) => {
        try {
          requireFolderName(value)
          return true
        } catch {
          return false
        }
      })
    })
  ),
  placements: z.array(
    z.strictObject({
      sourceId: identity,
      parentFolderId: identity
    })
  )
})

export type ProjectInputCatalogDocument = z.infer<typeof projectInputCatalogDocumentSchema>
