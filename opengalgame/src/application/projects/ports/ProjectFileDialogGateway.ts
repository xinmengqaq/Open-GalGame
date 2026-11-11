import type { ProjectLocation } from '../models/ProjectLocation'

export interface ProjectFileDialogGateway {
  /**
   * @returns 选择结果，取消为 null。
   */
  selectDirectory(): Promise<ProjectLocation | null>

  /**
   * @returns 选择结果，取消为 null。
   */
  chooseSaveLocation(): Promise<ProjectLocation | null>

  /**
   * 取用已选保存位置；没有则打开选择器。
   * @returns 选择结果，取消为 null。
   */
  takeSaveLocation(): Promise<ProjectLocation | null>

  clearSaveLocation(): void
}
