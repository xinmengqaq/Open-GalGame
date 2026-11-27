import type {
  ConnectionExtensionInput,
  ConnectionSettingsDTO,
  ListModelsDTO
} from '@application/settings/connections/dto/ConnectionSettingsDTO'

export type ConnectionExtensionMode = 'keep' | 'set' | 'clear'

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

export function connectionExtensionRequest(
  state: ConnectionExtensionDraft
): ConnectionExtensionInput | undefined {
  if (state.mode === 'clear') return { kind: 'clear' }
  if (state.mode === 'set' && state.draft.trim() !== '') return { kind: 'set', value: state.draft }
  if (state.hasExtension) return { kind: 'keep' }
  return undefined
}

export function connectionExtensionFingerprint(state: ConnectionExtensionDraft): string {
  return JSON.stringify([state.hasExtension, state.mode, state.mode === 'set' ? state.draft : ''])
}

/**
 * 配置指纹：与设置弹窗里「测试成功是否仍对应当前输入」使用同一组字段。
 * 输出不含密钥或完整设置内容，只用于判断两次确认是否针对同一份配置。
 */
export function connectionConfigFingerprint(
  fields: ConnectionDraftFields,
  extension: ConnectionExtensionDraft
): string {
  const payload = JSON.stringify([
    fields.providerId,
    fields.baseUrl,
    fields.model,
    fields.apiKey,
    fields.contextWindow,
    fields.maxOutputTokens,
    fields.temperature,
    fields.topP,
    connectionExtensionFingerprint(extension)
  ])
  return digestConnectionPayload(payload)
}

function digestConnectionPayload(payload: string): string {
  let hashA = 0x811c9dc5
  let hashB = 0x9e3779b9
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index)
    hashA = Math.imul(hashA ^ code, 0x01000193)
    hashB = Math.imul(hashB ^ code, 0x85ebca6b)
  }
  return `cfg-${(hashA >>> 0).toString(16).padStart(8, '0')}-${(hashB >>> 0)
    .toString(16)
    .padStart(8, '0')}-${payload.length.toString(16)}`
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
