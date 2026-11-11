import type {
  ParsedScene,
  SceneCommandDeclaration,
  SceneScriptParseOptions
} from '../models/ParsedScene'
import type { SceneSourceSnapshot } from '../models/SceneSourceSnapshot'

export interface SceneScriptParserGateway {
  /**
   * 解析快照内的一份真实脚本，保留原文及当前引擎索引。
   * @param relativePath - 要解析的脚本，省略时使用入口。
   * @param options - 调用方声明的命令，或仅生成读取链设置的语法契约。
   * @throws {AppException} 脚本不在快照内或解析失败。
   */
  parseSceneScript(
    snapshot: SceneSourceSnapshot,
    relativePath?: string,
    options?: readonly SceneCommandDeclaration[] | SceneScriptParseOptions
  ): ParsedScene
}
