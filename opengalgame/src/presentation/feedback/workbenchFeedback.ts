/** 场景画布归属不匹配错误码。表现层只按结构化码判断，不读消息文本。 */
export const SCENE_CANVAS_OWNERSHIP_MISMATCH_CODE = 4418
/** 工程工作区未就绪。表现层只按结构化码替换安全文案。 */
export const PROJECT_WORKSPACE_NOT_READY_CODE = 1309
/** 文档正文已在别处变化。表现层只按结构化码替换安全文案。 */
export const DOCUMENT_BODY_CHANGED_CODE = 4338

export const workbenchFeedback = {
  importHint: '可将文件拖入当前文件夹，或点导入加入工程',
  importImported: (count: number) => `已导入 ${count} 个文件`,
  importFailedItem: (fileName: string, message: string) => `${fileName}：${message}`,
  catalogRefreshFailed: '来源列表刷新失败，仍显示上次结果',
  catalogWriteRefreshFailed: '操作已完成，但刷新目录失败',
  deleteConfirm: '删除后，画布上已有卡片可能显示来源缺失。',
  deleteFolderConfirm: (name: string, folderCount: number, fileCount: number) =>
    `将删除「${name}」及其子树：${folderCount} 个文件夹、${fileCount} 个文件。画布上已有卡片可能显示来源缺失。`,
  dropUnreadable: '该来源当前不可读取，无法添加到画布。',
  sourceMissing: '该来源已不在当前目录中。',
  cardAdded: '已添加到画布',
  canvasPlacementOverlap: '画布没有空闲位置，卡片已叠放，请拖动整理。',
  copiedFile: '已复制文件',
  copiedFolder: '已复制文件夹',
  cutFile: '已剪切文件，原位置仍保留直到粘贴',
  pastedCopy: '已粘贴副本',
  pastedMove: '已移动到目标目录',
  clipboardCleared: '剪贴板中的对象已不存在',
  folderCreated: '已新建文件夹',
  documentCreated: '已创建文档',
  titleBlank: '标题不能为空',
  editNotApplied: '修改没有应用，请稍后重试。',
  inspectDone: '工程检查完成',
  inspectIssues: (count: number) => `工程检查完成，发现 ${count} 项问题。`,
  catalogScanFailed: '输入来源读取失败',
  arrangementFailed: '画布编排读取失败',
  ownershipBlocked: '无法读取该工程文件，已阻止显示错误工程内容。',
  sessionEdit: '修改会写入本次画布编排，保存后保持。',
  saveAction: '保存',
  saveSucceeded: '已保存',
  documentSaveTooLong: '正文超过 20 万字符，无法保存',
  documentSaveMissingVersion: '缺少来源版本，请重新读取',
  documentSaveUnsupportedImage: '正文里还有未上传的图片，请先移除后再保存',
  documentImageUnavailable: '文档不支持图片，正文保持原样',
  documentBodyChanged: '正文已在别处变化，请重新读取后再保存',
  saveNoChanges: '没有需要保存的改动',
  saveUnsaved: '未保存：编排没有写入工程。',
  saveCommittedUnsubmitted: '已落盘，但尚未进入作品修订。',
  saveUnverified: '结果待核对：提交结果不明，请先核对持久事实。',
  saveFailed: '保存失败',
  canvasLayout: '画布位置仅用于整理，不代表剧情顺序。',
  emptyGuide: '从输入目录拖入文本和文件素材',
  emptyHint: '动画和特效在画布上添加卡片后选择。',
  emptyCatalog: '还没有可用输入来源',
  disconnected: '来源已断开'
} as const
