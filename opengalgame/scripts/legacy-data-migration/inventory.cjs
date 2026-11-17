'use strict'

const { lstat, readFile, readdir } = require('node:fs/promises')
const { join } = require('node:path')

const { MigrationError } = require('./errors.cjs')
const { classifyFile } = require('./formats.cjs')
const { sha256, TOOL_VERSION } = require('./manifest.cjs')
const { assertNoSymlinkComponents, assertNoSymlinkEscape, isInside } = require('./scope.cjs')

const CANVAS_DIRECTORY = '.opengalgame/canvases'
const EXECUTION_DIRECTORY = 'scene-generation/projects'
const OPERATION_DIRECTORY = '.git/opengalgame/operations'
const UNVISITED_NOTE = '只盘点显式传入的根；未传入工程未访问，不能推断为已覆盖'

function isTemporaryName(name) {
  return name.startsWith('.opengalgame-tmp-')
}

async function optionalDirectory(path, label) {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw new MigrationError(`${label}无法访问：${path}`, {
      exitCode: 4,
      details: { cause: error.code }
    })
  }
  if (stats.isSymbolicLink()) throw new MigrationError(`${label}不能是符号链接：${path}`)
  if (!stats.isDirectory()) throw new MigrationError(`${label}不是目录：${path}`)
  const entries = await readdir(path, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new MigrationError(`${label}包含符号链接，拒绝越出显式根：${join(path, entry.name)}`)
    }
  }
  return entries
}

async function readProjectId(projectRoot) {
  try {
    const path = join(projectRoot, '.opengalgame', 'manifest.json')
    await assertNoSymlinkComponents(projectRoot, path, '工程身份文件')
    const value = JSON.parse(await readFile(path, 'utf8'))
    return value !== null && typeof value === 'object' && typeof value.projectId === 'string'
      ? value.projectId
      : null
  } catch {
    return null
  }
}

async function readTarget(path, family, root, context = {}) {
  await assertNoSymlinkEscape(root, path, `${family} 目标`)
  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new MigrationError(`${family} 目标不是普通文件：${path}`)
  }
  const bytes = await readFile(path)
  const classified = await classifyFile(bytes, family, context)
  return {
    family,
    path,
    formatVersion: classified.formatVersion ?? null,
    classification: classified.classification,
    sizeBytes: stats.size,
    sha256: sha256(bytes),
    modifiedAt: stats.mtime.toISOString(),
    ...(classified.details ? { details: classified.details } : {}),
    ...(classified.identityMatchesPath !== undefined
      ? { identityMatchesPath: classified.identityMatchesPath }
      : {}),
    ...(classified.records ? { records: classified.records } : {}),
    ...(classified.operationId ? { operationId: classified.operationId } : {}),
    ...(classified.phase !== undefined ? { phase: classified.phase } : {}),
    ...(classified.pathsCount !== undefined ? { pathsCount: classified.pathsCount } : {}),
    ...(classified.indexDigestPresent !== undefined
      ? { indexDigestPresent: classified.indexDigestPresent }
      : {}),
    ...(classified.indexDigestValidatedOnRead !== undefined
      ? { indexDigestValidatedOnRead: classified.indexDigestValidatedOnRead }
      : {}),
    ...(classified.indexDecodable !== undefined
      ? { indexDecodable: classified.indexDecodable }
      : {}),
    ...(classified.rollbackIndex ? { rollbackIndex: classified.rollbackIndex } : {}),
    ...(classified.error ? { error: classified.error } : {})
  }
}

async function inventoryCanvas(projectRoot) {
  const root = join(projectRoot, CANVAS_DIRECTORY)
  if (!isInside(projectRoot, root)) throw new MigrationError('画布目录越出工程根')
  const projectId = await readProjectId(projectRoot)
  const scenes = await optionalDirectory(root, '画布目录')
  const items = []
  for (const scene of scenes) {
    if (!scene.isDirectory() || isTemporaryName(scene.name)) continue
    const scenePath = join(root, scene.name)
    const files = await optionalDirectory(scenePath, '画布场景目录')
    for (const file of files) {
      if (!file.isFile() || isTemporaryName(file.name) || !file.name.endsWith('.json')) continue
      const target = join(scenePath, file.name)
      items.push(
        await readTarget(target, 'canvas', projectRoot, {
          identity: {
            projectId,
            sceneKey: scene.name,
            canvasKey: file.name.slice(0, -'.json'.length)
          }
        })
      )
    }
  }
  return items
}

async function inventoryExecutions(stateRoot) {
  if (stateRoot === null) return []
  const root = join(stateRoot, EXECUTION_DIRECTORY)
  if (!isInside(stateRoot, root)) throw new MigrationError('执行记录目录越出状态根')
  const projects = await optionalDirectory(root, '执行记录工程目录')
  const items = []
  for (const project of projects) {
    if (!project.isDirectory() || isTemporaryName(project.name)) continue
    const target = join(root, project.name, 'executions.json')
    let stats
    try {
      stats = await lstat(target)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw new MigrationError(`执行记录无法访问：${target}`, {
        exitCode: 4,
        details: { cause: error.code }
      })
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new MigrationError(`执行记录不是普通文件：${target}`)
    }
    items.push(
      await readTarget(target, 'execution', stateRoot, { projectId: project.name })
    )
  }
  return items
}

async function inventoryOperations(projectRoot) {
  const root = join(projectRoot, OPERATION_DIRECTORY)
  if (!isInside(projectRoot, root)) throw new MigrationError('操作记录目录越出工程根')
  const files = await optionalDirectory(root, '操作记录目录')
  const items = []
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.json') || isTemporaryName(file.name)) continue
    items.push(
      await readTarget(join(root, file.name), 'operation', projectRoot, {
        operationId: file.name.slice(0, -'.json'.length)
      })
    )
  }
  return items
}

function summarize(items) {
  const summary = {
    totalFiles: items.length,
    canvas: { current: 0, legacy: 0, unreadable: 0 },
    execution: { current: 0, legacy: 0, unreadable: 0 },
    operation: { current: 0, legacy: 0, unreadable: 0 }
  }
  for (const item of items) {
    const bucket = summary[item.family]
    if (bucket && Object.hasOwn(bucket, item.classification)) bucket[item.classification] += 1
  }
  return summary
}

async function inventory({ stateRoot = null, projectRoots }) {
  const canvas = []
  const execution = []
  const operation = []
  for (const projectRoot of projectRoots) {
    canvas.push(...(await inventoryCanvas(projectRoot)))
    operation.push(...(await inventoryOperations(projectRoot)))
  }
  execution.push(...(await inventoryExecutions(stateRoot)))
  const items = [...canvas, ...execution, ...operation]
  return {
    command: 'inventory',
    toolVersion: TOOL_VERSION,
    kind: 'inventory',
    dryRun: true,
    scope: {
      stateRoot,
      projectRoots: [...projectRoots],
      visitedProjects: [...projectRoots],
      unvisitedProjects: {
        known: false,
        count: null,
        note: UNVISITED_NOTE
      }
    },
    families: { canvas, execution, operation },
    summary: summarize(items)
  }
}

module.exports = {
  CANVAS_DIRECTORY,
  EXECUTION_DIRECTORY,
  OPERATION_DIRECTORY,
  UNVISITED_NOTE,
  inventory,
  summarize
}
