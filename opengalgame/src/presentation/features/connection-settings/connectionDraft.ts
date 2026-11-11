import type {
  ConnectionExtensionInput,
  ConnectionSettingsDTO,
  ListModelsDTO
} from '@application/connections/dto/ConnectionSettingsDTO'

export type ConnectionExtensionMode = 'keep' | 'set' | 'clear'

/** 扩展 JSON 的界面草稿：保存的内容永不回显，这里只保留用户新输入的文本。 */
export interface ConnectionExtensionDraft {
  readonly hasExtension: boolean
  readonly editorOpen: boolean
  readonly draft: string
  readonly mode: ConnectionExtensionMode
  readonly confirmingClear: boolean
}

export type ConnectionExtensionAction =
  | { readonly type: 'summary-loaded'; readonly hasExtension: boolean }
  | { readonly type: 'closed' }
  | { readonly type: 'editor-opened' }
  | { readonly type: 'editor-closed' }
  | { readonly type: 'draft-changed'; readonly value: string }
  | { readonly type: 'clear-requested' }
  | { readonly type: 'clear-cancelled' }
  | { readonly type: 'clear-confirmed' }
  | { readonly type: 'clear-undone' }
  | { readonly type: 'save-finished'; readonly hasExtension?: boolean }

export const emptyConnectionExtensionDraft: ConnectionExtensionDraft = {
  hasExtension: false,
  editorOpen: false,
  draft: '',
  mode: 'keep',
  confirmingClear: false
}

/**
 * 扩展输入的状态机。
 * 清空必须经过 `clear-confirmed` 才进入请求；只点“清空”不会把未修改误当清空。
 * `save-finished` 不带结果时保持现状，失败后用户输入与展开状态都不丢。
 */
export function connectionExtensionReducer(
  state: ConnectionExtensionDraft,
  action: ConnectionExtensionAction
): ConnectionExtensionDraft {
  switch (action.type) {
    case 'summary-loaded':
      return { ...emptyConnectionExtensionDraft, hasExtension: action.hasExtension }
    case 'closed':
      return emptyConnectionExtensionDraft
    case 'editor-opened':
      return { ...state, editorOpen: true, mode: 'keep', confirmingClear: false }
    case 'editor-closed':
      return { ...state, editorOpen: false, draft: '', mode: 'keep', confirmingClear: false }
    case 'draft-changed':
      return {
        ...state,
        draft: action.value,
        mode: action.value.trim() === '' ? 'keep' : 'set',
        confirmingClear: false
      }
    case 'clear-requested':
      return { ...state, confirmingClear: true }
    case 'clear-cancelled':
      return { ...state, confirmingClear: false }
    case 'clear-confirmed':
      return { ...state, confirmingClear: false, editorOpen: false, draft: '', mode: 'clear' }
    case 'clear-undone':
      return { ...state, mode: 'keep' }
    case 'save-finished':
      if (action.hasExtension === undefined) return state
      return {
        hasExtension: action.hasExtension,
        editorOpen: false,
        draft: '',
        mode: 'keep',
        confirmingClear: false
      }
  }
}

/**
 * 按用户意图构造三态；没有已存扩展且没有新输入时省略字段，请求与旧版一致。
 * 空输入永远表示保留，不会隐式清空。
 */
export function connectionExtensionRequest(
  state: ConnectionExtensionDraft
): ConnectionExtensionInput | undefined {
  if (state.mode === 'clear') return { kind: 'clear' }
  if (state.mode === 'set' && state.draft.trim() !== '') return { kind: 'set', value: state.draft }
  if (state.hasExtension) return { kind: 'keep' }
  return undefined
}

/** 只用于比较测试结果是否仍对应当前草稿，不写入界面或持久化。 */
export function connectionExtensionFingerprint(state: ConnectionExtensionDraft): string {
  return JSON.stringify([state.hasExtension, state.mode, state.mode === 'set' ? state.draft : ''])
}

export interface ConnectionDraftFields {
  providerId: ConnectionSettingsDTO['providerId']
  baseUrl: string
  model: string
  contextWindow: string
  maxOutputTokens: string
  temperature: string
  topP: string
  apiKey: string
}

/** 保存与测试共用同一份请求形状，扩展三态不会两处不一致。 */
export function buildConnectionSettingsRequest(
  fields: ConnectionDraftFields,
  extension: ConnectionExtensionInput | undefined
): ConnectionSettingsDTO {
  const request: ConnectionSettingsDTO = {
    providerId: fields.providerId,
    baseUrl: fields.baseUrl,
    model: fields.model,
    contextWindow: Number(fields.contextWindow),
    maxOutputTokens: Number(fields.maxOutputTokens),
    apiKey: fields.apiKey ? { kind: 'replace', value: fields.apiKey } : { kind: 'keep' }
  }
  if (fields.temperature) request.temperature = Number(fields.temperature)
  if (fields.topP) request.topP = Number(fields.topP)
  if (extension) request.extension = extension
  return request
}

/** 拉取列表走同一供应商端点时也带上同一份扩展三态。 */
export function buildListModelsRequest(
  fields: Pick<ConnectionDraftFields, 'providerId' | 'baseUrl' | 'apiKey'>,
  extension: ConnectionExtensionInput | undefined
): ListModelsDTO {
  const request: ListModelsDTO = {
    providerId: fields.providerId,
    baseUrl: fields.baseUrl,
    apiKey: fields.apiKey ? { kind: 'replace', value: fields.apiKey } : { kind: 'keep' }
  }
  if (extension) request.extension = extension
  return request
}
