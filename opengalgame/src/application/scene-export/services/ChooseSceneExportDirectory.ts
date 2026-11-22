import type { ChooseSceneExportDirectoryDTO } from '../dto/ChooseSceneExportDirectoryDTO'
import type { SceneExportDestinationGateway } from '../ports/SceneExportDestinationGateway'
import type { SceneExportDirectoryChoiceVO } from '../vo/SceneExportDestinationVO'

/** 只读选择端口，供用户接口层打开主进程目录选择器。 */
export interface ChooseSceneExportDirectoryService {
  chooseSceneExportDirectory(
    request: ChooseSceneExportDirectoryDTO
  ): Promise<SceneExportDirectoryChoiceVO>
}

/**
 * 目录选择只由主进程执行，并把选中路径换成 selectionId。
 * 用户取消时返回 canceled，不写盘、不登记选择。
 */
export class ChooseSceneExportDirectory implements ChooseSceneExportDirectoryService {
  constructor(private readonly gateway: SceneExportDestinationGateway) {}

  chooseSceneExportDirectory(
    request: ChooseSceneExportDirectoryDTO
  ): Promise<SceneExportDirectoryChoiceVO> {
    return this.gateway.chooseParentDirectory({
      projectId: request.projectId,
      sceneId: request.sceneId
    })
  }
}
