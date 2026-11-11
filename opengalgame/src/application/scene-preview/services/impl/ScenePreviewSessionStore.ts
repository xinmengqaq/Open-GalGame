import type { DialogueTextEditDTO, ReadDialogueSaveSettlementDTO } from '../../dto/DialogueSaveDTO'
import type { ScenePreviewSessionState } from '../../models/ScenePreviewSessionState'
import type { ScenePreviewSourceFact } from '../../models/ScenePreviewSourceFact'
import type { PreviewStageVO } from '../../vo/PreviewRuntimeVO'
import type { SaveDialogueChangesVO } from '../../vo/DialogueSaveVO'

export type ActivePreviewSession = ScenePreviewSessionState & {
  prepare: 'idle' | 'preparing' | 'failed' | 'ready'
  lastConfirmed?: Pick<PreviewStageVO, 'phase' | 'position'>
  unsavedEdits: ReadonlyMap<string, DialogueTextEditDTO & { readonly editRevision: number }>
  saveTail: Promise<void>
  runtimeReleased: boolean
}

export type AcceptedSaveTask = {
  readonly previewSessionId: string
  readonly projectId: string
  readonly sceneId: string
  readonly requestId: string
  readonly editsSnapshot: string
  readonly completion: Promise<SaveDialogueChangesVO>
}

type SaveIdentity = {
  readonly projectId: string
  readonly sceneId: string
  readonly requestId: string
  readonly editsSnapshot: string
}

/** 活动会话和正在执行的保存。关闭后的结算不留在这里。 */
export class ScenePreviewSessionStore {
  private readonly sessions = new Map<string, ActivePreviewSession>()
  private readonly acceptedSaves = new Map<string, AcceptedSaveTask>()
  private readonly closedScenes = new Map<string, { projectId: string; sceneId: string }>()

  create(previewSessionId: string, source: ScenePreviewSourceFact): ActivePreviewSession {
    const session: ActivePreviewSession = {
      previewSessionId,
      source,
      runtimeGeneration: 0,
      lastSequence: 0,
      prepared: false,
      closed: false,
      prepare: 'idle',
      unsavedEdits: new Map(),
      saveTail: Promise.resolve(),
      runtimeReleased: false
    }
    this.sessions.set(previewSessionId, session)
    return session
  }

  find(previewSessionId: string): ActivePreviewSession | undefined {
    return this.sessions.get(previewSessionId)
  }

  findByScene(projectId: string, sceneId: string): ActivePreviewSession | undefined {
    for (const session of this.sessions.values()) {
      if (
        session.source.location.projectId === projectId &&
        session.source.location.sceneId === sceneId
      ) {
        return session
      }
    }
    return undefined
  }

  replace(session: ActivePreviewSession): void {
    this.sessions.set(session.previewSessionId, session)
  }

  bindSaveTail(previewSessionId: string, saveTail: Promise<void>): boolean {
    const session = this.sessions.get(previewSessionId)
    if (!session || session.closed) return false
    session.saveTail = saveTail
    return true
  }

  remove(previewSessionId: string): void {
    const session = this.sessions.get(previewSessionId)
    if (session) {
      this.closedScenes.set(previewSessionId, {
        projectId: session.source.location.projectId,
        sceneId: session.source.location.sceneId
      })
    }
    this.sessions.delete(previewSessionId)
  }

  closedScene(previewSessionId: string): { projectId: string; sceneId: string } | undefined {
    return this.closedScenes.get(previewSessionId)
  }

  rememberAcceptedSave(
    previewSessionId: string,
    identity: SaveIdentity,
    completion: Promise<SaveDialogueChangesVO>
  ): void {
    this.acceptedSaves.set(saveKey(identity), { previewSessionId, ...identity, completion })
  }

  findAcceptedSave(identity: SaveIdentity): AcceptedSaveTask | 'conflict' | undefined {
    const task = this.acceptedSaves.get(saveKey(identity))
    if (!task) return undefined
    if (task.editsSnapshot !== identity.editsSnapshot) return 'conflict'
    return task
  }

  findAcceptedSaveForSession(previewSessionId: string): AcceptedSaveTask | undefined {
    for (const task of this.acceptedSaves.values()) {
      if (task.previewSessionId === previewSessionId) return task
    }
    return undefined
  }

  findAcceptedSaveForIdentity(
    request: ReadDialogueSaveSettlementDTO
  ): AcceptedSaveTask | undefined {
    for (const task of this.acceptedSaves.values()) {
      if (
        task.projectId === request.projectId &&
        task.sceneId === request.sceneId &&
        task.requestId === request.requestId
      ) {
        return task
      }
    }
    return undefined
  }

  dropAcceptedSave(identity: SaveIdentity): void {
    this.acceptedSaves.delete(saveKey(identity))
  }
}

function saveKey(identity: SaveIdentity): string {
  return `${identity.projectId}\0${identity.sceneId}\0${identity.requestId}`
}
