import {
  dialog,
  type BrowserWindow,
  type OpenDialogOptions,
  type OpenDialogReturnValue
} from 'electron'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import { projectDocumentFailure } from './projectDocumentFailure'
import { readJsonDocument, writeJsonDocument } from '../storage/jsonDocument'
import { parseUnknownValue } from '../validation/parseUnknownValue'
import type { ProjectLocation } from '@application/projects/models/ProjectLocation'
import type { ProjectFileDialogGateway } from '@application/projects/ports/ProjectFileDialogGateway'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'

const PROJECT_PREFERENCES_FILE_NAME = 'preferences.json'

const projectPreferencesDocumentSchema = z.strictObject({ lastSaveLocation: z.string().optional() })

type ProjectPreferencesDocument = z.infer<typeof projectPreferencesDocumentSchema>

const failure = projectDocumentFailure(ProjectErrorCodes.storageFailed, '本机界面偏好读写失败')

export class ElectronProjectFileDialogGatewayImpl implements ProjectFileDialogGateway {
  private pendingCreate: string | null = null

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly userDirectory: string,
    private readonly showDialog?: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>
  ) {}

  selectDirectory(): Promise<ProjectLocation | null> {
    return this.openDirectory('选择项目目录')
  }

  async chooseSaveLocation(): Promise<ProjectLocation | null> {
    const location = await this.openDirectory('选择保存位置')
    if (location) this.pendingCreate = location.directory
    return location
  }

  takeSaveLocation(): Promise<ProjectLocation | null> {
    if (this.pendingCreate) return Promise.resolve({ directory: this.pendingCreate })
    return this.openDirectory('选择保存位置')
  }

  clearSaveLocation(): void {
    this.pendingCreate = null
  }

  private async openDirectory(title: string): Promise<ProjectLocation | null> {
    const options: OpenDialogOptions = {
      title,
      buttonLabel: '使用此目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: await this.rememberedParent()
    }
    const result = await this.openNativeDialog(options)
    if (result.canceled || !result.filePaths.length) return null
    const location = { directory: await realpath(result.filePaths[0]) }
    await this.persist(location.directory)
    return location
  }

  private openNativeDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
    if (this.showDialog) return this.showDialog(options)
    const window = this.getWindow()
    return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options)
  }

  private async rememberedParent(): Promise<string | undefined> {
    const last = await this.readPersisted()
    if (!last) return undefined
    const parent = dirname(last)
    if (existsSync(parent)) return parent
    if (existsSync(last)) return last
    return undefined
  }

  private async persist(directory: string): Promise<void> {
    try {
      await writeJsonDocument(
        join(this.userDirectory, PROJECT_PREFERENCES_FILE_NAME),
        { lastSaveLocation: directory } satisfies ProjectPreferencesDocument,
        failure
      )
    } catch {
    }
  }

  private async readPersisted(): Promise<string | null> {
    try {
      const value = await readJsonDocument(
        join(this.userDirectory, PROJECT_PREFERENCES_FILE_NAME),
        failure
      )
      if (value === null) return null
      const preferences = parseUnknownValue(
        projectPreferencesDocumentSchema,
        value,
        failure.code,
        '界面偏好内容损坏'
      )
      return preferences.lastSaveLocation ?? null
    } catch {
      return null
    }
  }
}
