import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const CHECKPOINT_ENVELOPE_VERSION = 1

export interface CheckpointCompatibility {
  envelopeVersion: number
  langgraph: string
  checkpointLibrary: string
  core: string
}

/**
 * @throws {Error} 已安装包没有版本号。
 */
export function currentCheckpointCompatibility(): CheckpointCompatibility {
  return {
    envelopeVersion: CHECKPOINT_ENVELOPE_VERSION,
    langgraph: installedPackageVersion('@langchain/langgraph'),
    checkpointLibrary: installedPackageVersion('@langchain/langgraph-checkpoint'),
    core: installedPackageVersion('@langchain/core')
  }
}

/**
 * 读取已安装包的版本，避免把依赖版本写死在源码里。
 * @throws {Error} 版本缺失。
 */
function installedPackageVersion(packageName: string): string {
  const manifest = require(`${packageName}/package.json`) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`无法读取 ${packageName} 的版本`)
  }
  return manifest.version
}
