import { vi } from 'vitest'

import { ManageProjects } from '@application/projects/services/impl/ManageProjects'
import { ProjectDomainServiceImpl } from '@domain/projects/services/impl/ProjectDomainServiceImpl'

export function createProjectApplicationFixture(
  registrations: { id: string; directory: string }[] = []
): {
  service: ManageProjects
  dialogs: Record<
    'selectDirectory' | 'takeSaveLocation' | 'chooseSaveLocation' | 'clearSaveLocation',
    ReturnType<typeof vi.fn>
  >
  storage: Record<
    'inspect' | 'initialize' | 'isPublished' | 'discard' | 'saveProjectInfo',
    ReturnType<typeof vi.fn>
  >
  listQuery: Record<
    'listRegistrations' | 'countRegistrations' | 'findRegistration',
    ReturnType<typeof vi.fn>
  >
  registration: Record<'registerProject' | 'removeRegistration', ReturnType<typeof vi.fn>>
  logger: Record<'debug' | 'info' | 'warn' | 'error', ReturnType<typeof vi.fn>>
  recoverProjectFiles: ReturnType<typeof vi.fn>
} {
  const storage = {
    inspect: vi.fn(),
    initialize: vi.fn(),
    isPublished: vi.fn(),
    discard: vi.fn(),
    saveProjectInfo: vi.fn()
  }
  const listQuery = {
    listRegistrations: vi.fn(async (query: { offset: number; limit: number }) =>
      registrations.slice(query.offset, query.offset + query.limit)
    ),
    countRegistrations: vi.fn(async () => registrations.length),
    findRegistration: vi.fn(
      async (id: string) => registrations.find((item) => item.id === id) ?? null
    )
  }
  const registration = { registerProject: vi.fn(), removeRegistration: vi.fn() }
  const dialogs = {
    selectDirectory: vi.fn(),
    takeSaveLocation: vi.fn(),
    chooseSaveLocation: vi.fn(),
    clearSaveLocation: vi.fn()
  }
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const recoverProjectFiles = vi.fn(async () => undefined)
  const service = new ManageProjects({
    dialogs,
    storage,
    journal: {
      find: vi.fn(),
      begin: vi.fn(),
      markPublished: vi.fn(),
      complete: vi.fn(),
      remove: vi.fn(),
      listIncomplete: vi.fn()
    },
    execution: { executeProjectOperation: vi.fn(async (action) => action()) },
    identities: { findById: vi.fn() },
    domain: new ProjectDomainServiceImpl(),
    commit: { commit: vi.fn() },
    nextId: () => 'generated-id',
    notifications: { publishProgress: vi.fn() },
    listQuery,
    registration,
    logger,
    workspace: { ensureProjectWorkspace: vi.fn(), inspectProjectWorkspace: vi.fn() },
    recoverProjectFiles
  })
  return {
    service,
    dialogs,
    storage,
    listQuery,
    registration,
    logger,
    recoverProjectFiles
  }
}
