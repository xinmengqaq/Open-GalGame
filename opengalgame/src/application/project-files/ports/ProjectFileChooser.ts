/** 选择待导入的本机文件。取消时返回 null。不导入、不写入。 */
export interface ProjectFileChooser {
  /**
   * @returns 选中路径；取消时为 null。
   */
  chooseProjectFiles(): Promise<readonly string[] | null>
}
