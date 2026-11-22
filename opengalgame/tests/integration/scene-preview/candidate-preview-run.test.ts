import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import type { LogContext } from '@common/logging/LogContext'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { resolveRefIfExists } from '@infrastructure/git/objects/gitTree'
import { writeCandidateRevision } from '@infrastructure/git/objects/writeCandidateRevision'
import { GitCandidatePreviewGatewayImpl } from '@infrastructure/scene-generation/preview/GitCandidatePreviewGatewayImpl'
import { CandidatePreviewSessionGatewayImpl } from '@infrastructure/scene-preview/CandidatePreviewSessionGatewayImpl'
import { WEBGAL_COMPATIBILITY_PROFILE } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'

const dialogue = '放学后的空地渐渐安静下来。澪一直没有把手里的画稿递出去。'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('候选运行生命周期', () => {
  it('标题快照不会就绪；真实游戏快照才就绪，且不发送定位命令', async () => {
    const fixture = await publishedCandidate()
    const { gateway, revisionId, dialogue } = fixture
    const events: Array<{ type: string; previewSessionId: string }> = []
    gateway.subscribeCandidatePreviewEvents((event) => events.push(event))
    const opened = await gateway.openPublishedCandidatePreview(
      openRequest(revisionId, 'operation-start'),
      {
        entryFile: 'game/scene/start.txt',
        sceneName: 'start'
      }
    )
    const received: string[] = []
    const socket = await connectPreview(opened.preview.url, received)
    socket.send(registerRequest())
    socket.send(
      JSON.stringify({ kind: 'event', type: 'preview.ready.updated', payload: { ready: true } })
    )
    socket.send(
      JSON.stringify({
        kind: 'event',
        type: 'stage.snapshot.updated',
        payload: {
          sceneName: 'start.txt',
          sentenceId: 0,
          stageState: { showText: '', command: '', currentDialogKey: 'initial' }
        }
      })
    )
    setTimeout(() => {
      socket.send(
        JSON.stringify({
          kind: 'event',
          type: 'stage.snapshot.updated',
          payload: {
            sceneName: 'start.txt',
            sentenceId: 1,
            stageState: { showText: dialogue, command: 'say', currentDialogKey: 'line-1' }
          }
        })
      )
    }, 50)
    await opened.stage
    expect(
      events.filter((event) => event.previewSessionId === opened.preview.previewSessionId)
    ).toEqual([
      expect.objectContaining({ type: 'ready', previewSessionId: opened.preview.previewSessionId })
    ])
    expect(received.join('\n')).not.toContain('preview.command.sync-scene')
    expect(received.join('\n')).not.toContain('preview.command.run-scene-content')
    expect(received.join('\n')).not.toContain('preview.command.set-component-visibility')
    socket.close()

    const timedOut = await publishedCandidate()
    const failed = await timedOut.gateway.openPublishedCandidatePreview(
      openRequest(timedOut.revisionId, 'operation-title'),
      {
        entryFile: 'game/scene/start.txt',
        sceneName: 'start'
      }
    )
    const titleSocket = await connectPreview(failed.preview.url, [])
    titleSocket.send(registerRequest())
    titleSocket.send(
      JSON.stringify({
        kind: 'event',
        type: 'stage.snapshot.updated',
        payload: {
          sceneName: 'start.txt',
          sentenceId: 0,
          stageState: { showText: '', command: '', currentDialogKey: 'initial' }
        }
      })
    )
    await failed.stage
    expect(timedOut.gateway.readCandidatePreviewEvent(failed.preview.previewSessionId)).toMatchObject({
      type: 'stageFailed',
      message: '游戏加载超时'
    })
    const reopened = await timedOut.gateway.openPublishedCandidatePreview(
      openRequest(timedOut.revisionId, 'operation-title'),
      {
        entryFile: 'game/scene/start.txt',
        sceneName: 'start'
      }
    )
    expect(reopened.preview.previewSessionId).not.toBe(failed.preview.previewSessionId)
    expect(reopened.preview.candidateSnapshotId).toBe(timedOut.revisionId)
    expect(timedOut.gateway.readCandidatePreviewEvent(reopened.preview.previewSessionId)).toBeUndefined()
    titleSocket.close()
    await timedOut.gateway.close()

    await gateway.close()
  }, 15_000)

  it('运行到期释放宿主和物化根，保留候选修订，并让同候选开出新会话', async () => {
    const { gateway, revisionId, dialogue, gitDir } = await publishedCandidate(40)
    const events: Array<{ type: string }> = []
    gateway.subscribeCandidatePreviewEvents((event) => events.push(event))
    const opened = await gateway.openPublishedCandidatePreview(
      openRequest(revisionId, 'operation-expire'),
      {
        entryFile: 'game/scene/start.txt',
        sceneName: 'start'
      }
    )
    const sessions = new CandidatePreviewSessionGatewayImpl(gateway, Date.now)
    const active = await sessions.resolveCandidatePreviewSession({
      projectId: 'project-candidate',
      sceneId: 'scene-candidate',
      previewSessionId: opened.preview.previewSessionId
    })
    if (active.status !== 'resolved') throw new Error('候选会话没有建立')
    await expect
      .poll(async () =>
        sessions.resolveCandidatePreviewSession({
          projectId: 'project-candidate',
          sceneId: 'scene-candidate',
          previewSessionId: opened.preview.previewSessionId
        })
      )
      .toEqual({ status: 'rejected', reason: 'expired' })
    await expect
      .poll(async () => {
        try {
          await access(active.session.projectRoot)
          return 'present'
        } catch {
          return 'removed'
        }
      })
      .toBe('removed')
    await expect(
      resolveRefIfExists({ gitdir: gitDir }, `refs/opengalgame/revisions/${revisionId}`)
    ).resolves.toBe(revisionId)
    expect(events.some((event) => event.type === 'invalidated')).toBe(false)

    const reopened = await gateway.openPublishedCandidatePreview(
      openRequest(revisionId, 'operation-expire'),
      {
        entryFile: 'game/scene/start.txt',
        sceneName: 'start'
      }
    )
    expect(reopened.preview.previewSessionId).not.toBe(opened.preview.previewSessionId)
    expect(reopened.preview.candidateSnapshotId).toBe(revisionId)
    const next = await new CandidatePreviewSessionGatewayImpl(
      gateway,
      Date.now
    ).resolveCandidatePreviewSession({
      projectId: 'project-candidate',
      sceneId: 'scene-candidate',
      previewSessionId: reopened.preview.previewSessionId
    })
    if (next.status !== 'resolved') throw new Error('同一候选没有重新打开')
    expect(
      await readFile(join(next.session.projectRoot, 'game/scene/start.txt'), 'utf8')
    ).toContain(dialogue)
    expect(gateway.readCandidatePreviewEvent(reopened.preview.previewSessionId)).toBeUndefined()
    expect(gateway.readCandidatePreviewEvent(opened.preview.previewSessionId)).not.toMatchObject({
      previewSessionId: reopened.preview.previewSessionId
    })
    await gateway.close()
  })
})

async function publishedCandidate(sessionTtlMs?: number): Promise<{
  gateway: GitCandidatePreviewGatewayImpl
  revisionId: string
  dialogue: string
  gitDir: string
  root: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-candidate-run-'))
  roots.push(root)
  const projectRoot = join(root, 'project')
  const entry = join(projectRoot, 'game', 'scene', 'start.txt')
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(entry, `旁白:${dialogue}\n`, 'utf8')
  const files = new AiProjectFileSystemImpl(root)
  const workspace = files.locateWorkspace({
    projectId: 'project-candidate',
    threadId: 'thread-candidate',
    operationId: 'operation-start'
  })
  const gitDir = workspace.revisionGitDir
  await mkdir(dirname(gitDir), { recursive: true })
  const { revisionId } = await writeCandidateRevision(gitDir, [
    { relativePath: 'game/scene/start.txt', action: 'upsert', sourceFile: entry }
  ])
  const gateway = new GitCandidatePreviewGatewayImpl(
    files,
    join(root, 'state', 'ai'),
    Date.now,
    undefined,
    4_000,
    sessionTtlMs === undefined ? {} : { sessionTtlMs }
  )
  return { gateway, revisionId, dialogue, gitDir, root }
}

function openRequest(
  candidateSnapshotId: string,
  operationId: string
): {
  projectId: string
  sceneId: string
  operationId: string
  threadId: string
  branchId: string
  checkpointId: string
  candidateSnapshotId: string
} {
  return {
    projectId: 'project-candidate',
    sceneId: 'scene-candidate',
    operationId,
    threadId: 'thread-candidate',
    branchId: 'branch-candidate',
    checkpointId: 'checkpoint-candidate',
    candidateSnapshotId
  }
}

function registerRequest(): string {
  return JSON.stringify({
    kind: 'request',
    type: 'session.register-preview',
    requestId: 'register-1',
    payload: {}
  })
}

function connectPreview(pageUrl: string, received: string[]): Promise<WebSocket> {
  const url = new URL(pageUrl)
  const socket = new WebSocket(`ws://${url.host}${WEBGAL_COMPATIBILITY_PROFILE.previewPath}`, [
    WEBGAL_COMPATIBILITY_PROFILE.previewProtocol
  ])
  socket.on('message', (data) => received.push(data.toString()))
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

interface LogCall {
  level: 'debug' | 'info' | 'warn' | 'error'
  event: string
  context?: LogContext
}

function createLogger(): { logger: LoggerGateway; calls: LogCall[] } {
  const calls: LogCall[] = []
  const logger: LoggerGateway = {
    debug: (event, context) => calls.push({ level: 'debug', event, context }),
    info: (event, context) => calls.push({ level: 'info', event, context }),
    warn: (event, context) => calls.push({ level: 'warn', event, context }),
    error: (event, context) => calls.push({ level: 'error', event, context })
  }
  return { logger, calls }
}
