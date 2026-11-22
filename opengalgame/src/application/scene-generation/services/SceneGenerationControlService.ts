import type {
  ResumeSceneGenerationDTO,
  SceneGenerationRecoveryScopeDTO,
  SceneGenerationScopeDTO
} from '../dto/SceneGenerationDTO'
import type {
  SceneGenerationRenderStatusVO,
  SceneGenerationVerificationResultVO
} from '../vo/SceneGenerationRenderVO'

export interface SceneGenerationControlService {
  pauseSceneGeneration(request: SceneGenerationScopeDTO): Promise<SceneGenerationRenderStatusVO>

  resumeSceneGeneration(request: ResumeSceneGenerationDTO): Promise<SceneGenerationRenderStatusVO>

  /**
   * 继续尚未产生检查点的崩溃现场：只按操作、线程和分支身份核对持久事实，
   * 无活动代次且记录仍是待运行/运行中时复用原操作。已有检查点必须走检查点恢复。
   * @throws {AppException} 身份过期、仍有活动代次、已有检查点、待核对或记录不能证明。
   */
  resumeUnfinishedSceneGeneration(
    request: SceneGenerationRecoveryScopeDTO
  ): Promise<SceneGenerationRenderStatusVO>

  /**
   * 正式提交成功后只补做已登记的清理，不重开生成、不再次提交。
   * 重复请求是幂等的；无待清理事实时返回当前已提交状态。
   * @throws {AppException} 身份过期、仍有活动代次或记录不是已提交结果。
   */
  retrySceneGenerationCleanup(
    request: SceneGenerationRecoveryScopeDTO
  ): Promise<SceneGenerationRenderStatusVO>

  /**
   * 作者显式核对写入/提交回执不明的现场。线程串行、无活动代次，按五元身份
   * 重新读取真实提交事实、写入回执、不可变草稿与工作区归属。
   * 证据不足或只证明未写/未提交时记录保持不变；已证明写入进入既有候选校验/
   * 审阅门，已证明提交按原提交结算。不新增提交、不调用模型、不授予取消或删除。
   * @throws {AppException} 身份过期、仍有活动代次或核对读取失败。
   */
  verifyUnknownResult(
    request: SceneGenerationRecoveryScopeDTO
  ): Promise<SceneGenerationVerificationResultVO>

  /**
   * 取消前先核对提交副作用。已越过不可撤销提交门或作品已提交时明确拒绝，不伪报取消。
   * 取消受理后的迟到写入被持久事实拒绝；无活动运行时复用既有取消清理。
   * @throws {AppException} 操作不存在、正在提交、已提交/结束或清理失败。
   */
  cancelSceneGeneration(request: SceneGenerationScopeDTO): Promise<SceneGenerationRenderStatusVO>
}
