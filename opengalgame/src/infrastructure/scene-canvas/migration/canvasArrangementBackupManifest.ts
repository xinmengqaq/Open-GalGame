import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'

import { isPathInside, pathKey, safeRelativePosix, toPosixPath } from './canvasMigrationPaths'

/** 与 R27 严格 manifest v1 契约一致；产品只写 canvas 族单条目批次。 */
export const CANVAS_MIGRATION_MANIFEST_FORMAT_VERSION = 1
export const CANVAS_MIGRATION_TOOL_VERSION = 'scene-canvas-1'
export const CANVAS_MIGRATION_BATCH_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
export const CANVAS_MIGRATION_UNVISITED_NOTE = '仅处理本次实际访问的工程；其他工程首次访问时迁移'

const absolutePath = z.string().refine((value) => isAbsolute(value), { message: '必须是绝对路径' })
const isoTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: '必须是 ISO-8601 时间' })
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u)
const batchId = z
  .string()
  .regex(CANVAS_MIGRATION_BATCH_ID_PATTERN)
  .refine((value) => value !== '.' && value !== '..', { message: '批次标识不能是 . 或 ..' })

const scopeSchema = z.strictObject({
  stateRoot: z.null(),
  projectRoots: z.array(absolutePath).min(1),
  visitedProjects: z.array(absolutePath),
  unvisitedProjects: z.strictObject({
    known: z.boolean(),
    count: z.number().int().nullable(),
    note: z.string().min(1)
  })
})

const entrySchema = z.strictObject({
  family: z.literal('canvas'),
  originalPath: absolutePath,
  backupPath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().refine(Number.isSafeInteger),
  sha256,
  modifiedAt: isoTime,
  backedUpAt: isoTime
})

const manifestSchema = z.strictObject({
  formatVersion: z.literal(CANVAS_MIGRATION_MANIFEST_FORMAT_VERSION),
  kind: z.literal('legacy-data-backup'),
  batchId,
  toolVersion: z.string().min(1),
  createdAt: isoTime,
  backupRoot: absolutePath,
  scope: scopeSchema,
  entries: z.array(entrySchema)
})

export type CanvasMigrationManifest = z.infer<typeof manifestSchema>

const CANVAS_RELATIVE_PATTERN = /^\.opengalgame\/canvases\/([0-9a-f]+)\/([0-9a-f]+)\.json$/u
const STORAGE_KEY_PATTERN = /^[0-9a-f]{2,250}$/u

/**
 * 严格校验产品写出的迁移 manifest，并核对 canvas 族路径与备份命名空间。
 * 与 R27 scripts/legacy-data-migration/manifest.cjs 的规则一致，不引用开发工具。
 * @throws {Error} 字段、显式根或路径命名空间不合法。
 */
export function assertCanvasMigrationManifest(value: unknown): CanvasMigrationManifest {
  const manifest = manifestSchema.parse(value)
  const roots = manifest.scope.projectRoots
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (isPathInside(roots[left]!, roots[right]!) || isPathInside(roots[right]!, roots[left]!)) {
        throw new Error('manifest 显式根不能重叠')
      }
    }
  }
  const originals = new Set<string>()
  const backups = new Set<string>()
  for (const entry of manifest.entries) {
    const original = resolve(entry.originalPath)
    const projectIndex = roots.findIndex((root) => isPathInside(root, original))
    if (projectIndex < 0) throw new Error(`manifest 原路径不在显式根内：${entry.originalPath}`)
    const relativePath = toPosixPath(relative(roots[projectIndex]!, original))
    const match = CANVAS_RELATIVE_PATTERN.exec(relativePath)
    if (!match || !isEvenStorageKey(match[1]!) || !isEvenStorageKey(match[2]!)) {
      throw new Error(`manifest 原路径不是真实画布位置：${entry.originalPath}`)
    }
    const expectedBackup = `files/project-${projectIndex}/${relativePath}`
    if (entry.backupPath !== expectedBackup) {
      throw new Error(`manifest 备份路径与源根不一致：${entry.backupPath}，期望 ${expectedBackup}`)
    }
    if (safeRelativePosix(entry.backupPath) === null) {
      throw new Error(`manifest 备份路径非法：${entry.backupPath}`)
    }
    const originalKey = pathKey(original)
    if (originals.has(originalKey)) throw new Error('manifest 原路径重复')
    originals.add(originalKey)
    const backupKey = pathKey(entry.backupPath)
    if (backups.has(backupKey)) throw new Error('manifest 备份路径重复')
    backups.add(backupKey)
  }
  return manifest
}

function isEvenStorageKey(value: string): boolean {
  return STORAGE_KEY_PATTERN.test(value) && value.length % 2 === 0
}

/**
 * 构造 R27 严格 manifest v1 的单画布备份批次。
 * @param input - 已解析的真实工程根、源路径、备份相对路径与摘要。
 */
export function createCanvasMigrationManifest(input: {
  batchId: string
  batchRoot: string
  projectRoot: string
  originalPath: string
  relativePath: string
  sizeBytes: number
  sha256: string
  modifiedAt: string
  backedUpAt: string
  createdAt: string
}): CanvasMigrationManifest {
  const relativePath = safeRelativePosix(input.relativePath)
  if (relativePath === null) throw new Error(`非法画布相对路径：${input.relativePath}`)
  return assertCanvasMigrationManifest({
    formatVersion: CANVAS_MIGRATION_MANIFEST_FORMAT_VERSION,
    kind: 'legacy-data-backup',
    batchId: input.batchId,
    toolVersion: CANVAS_MIGRATION_TOOL_VERSION,
    createdAt: input.createdAt,
    backupRoot: input.batchRoot,
    scope: {
      stateRoot: null,
      projectRoots: [input.projectRoot],
      visitedProjects: [input.projectRoot],
      unvisitedProjects: {
        known: false,
        count: null,
        note: CANVAS_MIGRATION_UNVISITED_NOTE
      }
    },
    entries: [
      {
        family: 'canvas',
        originalPath: input.originalPath,
        backupPath: `files/project-0/${relativePath}`,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        modifiedAt: input.modifiedAt,
        backedUpAt: input.backedUpAt
      }
    ]
  })
}
