'use strict'

const { lstat, realpath, stat } = require('node:fs/promises')
const { isAbsolute, join, relative, resolve, sep } = require('node:path')

const { MigrationError } = require('./errors.cjs')

function pathKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right)
}

function isInside(root, candidate) {
  const rel = relative(root, candidate)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

async function realDirectory(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new MigrationError(`${label}必须是绝对路径：${String(path)}`)
  }
  let real
  try {
    real = await realpath(path)
  } catch (error) {
    throw new MigrationError(`${label}不存在或不可访问：${path}`, {
      exitCode: 4,
      details: { cause: error.code }
    })
  }
  const stats = await stat(real)
  if (!stats.isDirectory()) throw new MigrationError(`${label}不是目录：${path}`)
  return real
}

function safeRelativePosix(value, label = '相对路径') {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new MigrationError(`${label}为空或包含非法字符`)
  }
  if (value.includes('\\') || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
    throw new MigrationError(`${label}必须是根内 POSIX 相对路径：${value}`)
  }
  const parts = value.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new MigrationError(`${label}包含空段、当前目录或上级跳转：${value}`)
  }
  return parts.join('/')
}

function relativePosix(root, target, label = '路径') {
  if (!isInside(root, target)) throw new MigrationError(`${label}越出显式根：${target}`)
  const rel = relative(root, target)
  if (rel === '') throw new MigrationError(`${label}不能是根目录本身`)
  return safeRelativePosix(rel.split(sep).join('/'), label)
}

async function assertNoSymlinkEscape(root, target, label = '路径') {
  if (!isInside(root, target)) throw new MigrationError(`${label}越出显式根：${target}`)
  const rel = relative(root, target)
  if (rel === '') return
  let current = root
  for (const part of rel.split(sep)) {
    current = join(current, part)
    let stats
    try {
      stats = await lstat(current)
    } catch (error) {
      if (error.code === 'ENOENT') break
      throw new MigrationError(`${label}无法检查：${current}`, {
        exitCode: 4,
        details: { cause: error.code }
      })
    }
    if (!stats.isSymbolicLink()) continue
    let resolved
    try {
      resolved = await realpath(current)
    } catch (error) {
      throw new MigrationError(`${label}符号链接无法解析：${current}`, {
        exitCode: 4,
        details: { cause: error.code }
      })
    }
    if (!isInside(root, resolved)) {
      throw new MigrationError(`${label}经符号链接越出显式根：${current} -> ${resolved}`)
    }
  }
}

async function resolveInside(root, relativePath, label = '路径') {
  const safe = safeRelativePosix(relativePath, label)
  const target = resolve(root, ...safe.split('/'))
  if (!isInside(root, target)) throw new MigrationError(`${label}越出显式根：${relativePath}`)
  await assertNoSymlinkEscape(root, target, label)
  return target
}

async function assertNoSymlinkComponents(root, target, label = '路径') {
  if (!isInside(root, target)) {
    throw new MigrationError(`${label}越出显式根：${target}`, { exitCode: 3 })
  }
  const rel = relative(root, target)
  if (rel === '') return
  let current = root
  for (const part of rel.split(sep)) {
    current = join(current, part)
    let stats
    try {
      stats = await lstat(current)
    } catch (error) {
      if (error.code === 'ENOENT') break
      throw new MigrationError(`${label}无法检查：${current}`, {
        exitCode: 4,
        details: { cause: error.code }
      })
    }
    if (stats.isSymbolicLink()) {
      throw new MigrationError(`${label}包含符号链接或 junction，拒绝恢复：${current}`, {
        exitCode: 3
      })
    }
    let real
    try {
      real = await realpath(current)
    } catch (error) {
      throw new MigrationError(`${label}无法解析：${current}`, {
        exitCode: 4,
        details: { cause: error.code }
      })
    }
    if (!samePath(real, current)) {
      throw new MigrationError(`${label}包含链接/别名路径，拒绝恢复：${current} -> ${real}`, {
        exitCode: 3
      })
    }
  }
}

async function canonicalInside(root, relativePath, label = '路径') {
  const safe = safeRelativePosix(relativePath, label)
  const parts = safe.split('/')
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    const next = join(current, parts[index])
    let stats
    try {
      stats = await lstat(next)
    } catch (error) {
      if (error.code === 'ENOENT') return join(current, ...parts.slice(index))
      throw new MigrationError(`${label}无法检查：${next}`, {
        exitCode: 4,
        details: { cause: error.code }
      })
    }
    if (!stats.isSymbolicLink()) {
      current = next
      continue
    }
    let resolved
    try {
      resolved = await realpath(next)
    } catch (error) {
      throw new MigrationError(`${label}符号链接无法解析：${next}`, {
        exitCode: 4,
        details: { cause: error.code }
      })
    }
    if (!isInside(root, resolved)) {
      throw new MigrationError(`${label}经符号链接越出显式根：${next} -> ${resolved}`)
    }
    current = resolved
  }
  if (!isInside(root, current)) throw new MigrationError(`${label}越出显式根：${relativePath}`)
  return current
}

function assertRootsDisjoint(roots) {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (isInside(roots[left], roots[right]) || isInside(roots[right], roots[left])) {
        throw new MigrationError(`显式根不能重叠：${roots[left]} / ${roots[right]}`)
      }
    }
  }
}

function assertBackupRootOutsideSources(backupRoot, sourceRoots) {
  for (const root of sourceRoots) {
    if (isInside(root, backupRoot) || isInside(backupRoot, root)) {
      throw new MigrationError(`备份根不能位于源根内或包含源根：${backupRoot} / ${root}`)
    }
  }
}

function scopeRoots(scope) {
  return [scope.stateRoot, ...scope.projectRoots].filter((root) => root !== null)
}

function assertRootSetsEqual(manifestRoots, explicitRoots) {
  const left = new Set(manifestRoots.map(pathKey))
  const right = new Set(explicitRoots.map(pathKey))
  if (left.size !== right.size || [...left].some((root) => !right.has(root))) {
    throw new MigrationError('manifest 的显式根与 restore 传入根不一致，拒绝恢复', {
      details: { manifestRoots, explicitRoots }
    })
  }
}

module.exports = {
  assertBackupRootOutsideSources,
  assertNoSymlinkComponents,
  assertNoSymlinkEscape,
  assertRootSetsEqual,
  assertRootsDisjoint,
  canonicalInside,
  isInside,
  pathKey,
  realDirectory,
  relativePosix,
  resolveInside,
  safeRelativePosix,
  samePath,
  scopeRoots
}
