import type {
  ParsedScene,
  SceneCommandDeclaration,
  SceneScriptParseOptions
} from '../models/ParsedScene'
import type { SceneSourceSnapshot } from '../models/SceneSourceSnapshot'

export interface SceneScriptParserGateway {
  parseSceneScript(
    snapshot: SceneSourceSnapshot,
    relativePath?: string,
    options?: readonly SceneCommandDeclaration[] | SceneScriptParseOptions
  ): ParsedScene
}
