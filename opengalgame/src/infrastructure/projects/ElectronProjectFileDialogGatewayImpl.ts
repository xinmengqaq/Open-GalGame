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

  /**
   * @param getWindow - 取当前窗口，取不到时用无父窗口的选择器。
   * @param showDialog - 测试替身；不传时使用系统选择器。
   */
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

  /** 取用已选保存位置，没有则再打开选择器。 */
  takeSaveLocation(): Promise<ProjectLocation | null> {
    if (this.pendingCreate) return Promise.resolve({ directory: this.pendingCreate })
    return this.openDirectory('选择保存位置')
  }

  clearSaveLocation(): void {
    this.pendingCreate = null
  }

  /**
   * @returns 解析后的位置；用户取消时为 null。
   */
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

  /** 有测试替身时用它，否则用系统选择器并按是否有父窗口分派。 */
  private openNativeDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
    if (this.showDialog) return this.showDialog(options)
    const window = this.getWindow()
    return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options)
  }

  /**
   * 取上次保存位置所在目录作为默认路径；目录不在时退回该位置本身。
   * @returns 可用的默认路径；没有可用位置时为 undefined。
   */
  private async rememberedParent(): Promise<string | undefined> {
    const last = await this.readPersisted()
    if (!last) return undefined
    const parent = dirname(last)
    if (existsSync(parent)) return parent
    if (existsSync(last)) return last
    return undefined
  }

  /** 记住本次保存位置，记住失败不影响本次选择。 */
  private async persist(directory: string): Promise<void> {
    try {
      await writeJsonDocument(
        join(this.userDirectory, PROJECT_PREFERENCES_FILE_NAME),
        { lastSaveLocation: directory } satisfies ProjectPreferencesDocument,
        failure
      )
    } catch {}
  }

  /**
   * 读取上次记住的保存位置，读取或解析失败按没有记录处理。
   * @returns 上次保存位置；没有或不可读时为 null。
   */
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
