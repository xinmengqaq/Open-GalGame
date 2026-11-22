export interface ProjectFileChooser {
  chooseProjectFiles(): Promise<readonly string[] | null>
}
