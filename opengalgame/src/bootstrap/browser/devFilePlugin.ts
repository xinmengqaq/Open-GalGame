import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Plugin } from 'vite'

const callPath = '/__opengalgame/dev/call'
const stagePath = '/__opengalgame/dev/stage'
const mediaPath = '/__opengalgame/dev/media'
const progressPath = '/__opengalgame/dev/generation-progress'
const previewRuntimePath = '/__opengalgame/dev/scene-preview-runtime'
const candidatePreviewPath = '/__opengalgame/dev/scene-preview-candidate'
const jsonLimit = 1_000_000
const uploadLimit = 512 * 1024 * 1024

interface LoadedBackend {
  call(method: string, input: unknown): Promise<{ code: number; msg: string; data?: unknown }>
  stageFile(
    fileName: string,
    bytes: Uint8Array
  ): Promise<{ code: number; msg: string; data?: string }>
  readMedia(input: unknown): Promise<{ code: number; msg: string; data?: unknown }>
  watchGenerationProgress(
    input: unknown,
    publish: (event: unknown) => void
  ): Promise<{ result: { code: number; msg: string }; stop: () => void }>
  subscribeScenePreviewEvents(publish: (event: unknown) => void): () => void
  subscribeCandidatePreviewEvents(publish: (event: unknown) => void): () => void
}

/**
 * 只挂在 Vite 开发服务上。监听地址已限定为 127.0.0.1，请求再核对回环来源。
 */
export function browserDevFilesPlugin(): Plugin {
  return {
    name: 'opengalgame-browser-dev-files',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
        const url = requestUrl.pathname
        if (
          url !== callPath &&
          url !== stagePath &&
          url !== progressPath &&
          url !== mediaPath &&
          url !== previewRuntimePath &&
          url !== candidatePreviewPath
        ) {
          next()
          return
        }
        if (!isLoopback(request.socket.remoteAddress) || !isSameOriginDevRequest(request)) {
          response.statusCode = 403
          response.end()
          return
        }
        try {
          const loaded = (await server.ssrLoadModule('/browser/devFileBackend.ts')) as {
            loadDevFileBackend: () => Promise<LoadedBackend>
          }
          const backend = await loaded.loadDevFileBackend()
          if (url === stagePath) await writeStage(backend, request, response)
          else if (url === progressPath) await writeProgress(backend, requestUrl, request, response)
          else if (url === previewRuntimePath) writePreviewRuntime(backend, request, response)
          else if (url === candidatePreviewPath) writeCandidatePreview(backend, request, response)
          else if (url === mediaPath) await writeMedia(backend, requestUrl, request, response)
          else await writeCall(backend, request, response)
        } catch (error) {
          const invalidConfig =
            error instanceof Error && error.name === 'AppException' ? error : undefined
          const code = invalidConfig && 'code' in invalidConfig ? invalidConfig.code : undefined
          const message =
            invalidConfig && 'message' in invalidConfig ? invalidConfig.message : undefined
          if (code === 5101 && typeof message === 'string') {
            server.config.logger.error('[opengalgame] 开发用户目录不可用（5101）')
            writeJson(response, 500, { code, msg: message })
            return
          }
          writeJson(response, 500, { code: 5103, msg: '开发文件后端不可用' })
        }
      })
    }
  }
}

async function writeProgress(
  backend: LoadedBackend,
  requestUrl: URL,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const input = {
    projectId: requestUrl.searchParams.get('projectId'),
    sceneId: requestUrl.searchParams.get('sceneId'),
    operationId: requestUrl.searchParams.get('operationId'),
    threadId: requestUrl.searchParams.get('threadId'),
    branchId: requestUrl.searchParams.get('branchId')
  }
  const watched = await backend.watchGenerationProgress(input, (event) => {
    response.write(`data: ${JSON.stringify(event)}\n\n`)
  })
  if (watched.result.code !== 2000) {
    writeJson(response, 200, watched.result)
    return
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  request.on('close', () => watched.stop())
}

/**
 * 预览运行时事件走同源 SSE。事件已在应用层按会话过滤；渲染端仍按会话身份再过滤。
 * 订阅命令单独走 `/dev/call`，这里只负责把已确认的运行时事实送到页面。
 */
function writePreviewRuntime(
  backend: LoadedBackend,
  request: IncomingMessage,
  response: ServerResponse
): void {
  writeEventStream(response, (publish) => backend.subscribeScenePreviewEvents(publish), request)
}

function writeCandidatePreview(
  backend: LoadedBackend,
  request: IncomingMessage,
  response: ServerResponse
): void {
  writeEventStream(response, (publish) => backend.subscribeCandidatePreviewEvents(publish), request)
}

function writeEventStream(
  response: ServerResponse,
  subscribe: (publish: (event: unknown) => void) => () => void,
  request: IncomingMessage
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  response.write(': connected\n\n')
  const stop = subscribe((event) => {
    response.write(`data: ${JSON.stringify(event)}\n\n`)
  })
  request.on('close', stop)
}

async function writeCall(
  backend: LoadedBackend,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method !== 'POST') {
    response.statusCode = 405
    response.end()
    return
  }
  const body = await readBody(request, jsonLimit)
  if (body === 'too-large') {
    writeJson(response, 413, { code: 4101, msg: '请求参数格式不正确' })
    return
  }
  let parsed: { method?: unknown; input?: unknown }
  try {
    parsed = JSON.parse(body.toString('utf8')) as { method?: unknown; input?: unknown }
  } catch {
    writeJson(response, 400, { code: 4101, msg: '请求参数格式不正确' })
    return
  }
  if (typeof parsed.method !== 'string') {
    writeJson(response, 400, { code: 4101, msg: '请求参数格式不正确' })
    return
  }
  writeJson(response, 200, await backend.call(parsed.method, parsed.input))
}

async function writeStage(
  backend: LoadedBackend,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method !== 'POST') {
    response.statusCode = 405
    response.end()
    return
  }
  const header = request.headers['x-file-name']
  const encoded = Array.isArray(header) ? header[0] : header
  let fileName = ''
  try {
    fileName = encoded ? decodeURIComponent(encoded) : ''
  } catch {
    fileName = ''
  }
  const body = await readBody(request, uploadLimit)
  if (body === 'too-large') {
    writeJson(response, 413, { code: 4101, msg: '文件超出开发导入上限' })
    return
  }
  writeJson(response, 200, await backend.stageFile(fileName, body))
}

async function writeMedia(
  backend: LoadedBackend,
  requestUrl: URL,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method !== 'GET') {
    response.statusCode = 405
    response.end()
    return
  }
  const result = await backend.readMedia({
    projectId: requestUrl.searchParams.get('projectId') ?? '',
    sourceId: requestUrl.searchParams.get('sourceId') ?? ''
  })
  const data = result.data
  if (
    result.code !== 2000 ||
    data === null ||
    typeof data !== 'object' ||
    !('bytes' in data) ||
    !('mediaType' in data) ||
    !(data.bytes instanceof Uint8Array) ||
    typeof data.mediaType !== 'string'
  ) {
    writeJson(response, 200, { code: result.code, msg: result.msg })
    return
  }
  const fileName = 'fileName' in data && typeof data.fileName === 'string' ? data.fileName : 'media'
  response.writeHead(200, {
    'content-type': data.mediaType,
    'content-length': data.bytes.byteLength,
    'x-content-kind':
      'contentKind' in data && typeof data.contentKind === 'string' ? data.contentKind : '',
    'x-file-name': encodeURIComponent(fileName),
    'cache-control': 'no-store'
  })
  response.end(data.bytes)
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        resolve('too-large')
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function isLoopback(address: string | undefined): boolean {
  return (
    address === undefined ||
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  )
}

/**
 * 回环地址挡不住本机其他网页。写操作和事件流必须来自开发页自身。
 * 浏览器会带 Origin 或 Sec-Fetch-Site；两者都没有时只接受无来源的本机调用。
 */
function isSameOriginDevRequest(request: IncomingMessage): boolean {
  const site = singleHeader(request.headers['sec-fetch-site'])
  if (site === 'cross-site' || site === 'same-site') return false
  const source = singleHeader(request.headers.origin) ?? singleHeader(request.headers.referer)
  if (!source) return site === undefined || site === 'same-origin' || site === 'none'
  const host = singleHeader(request.headers.host)
  if (!host) return false
  try {
    const parsed = new URL(source)
    const loopback =
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '[::1]'
    return parsed.protocol === 'http:' && parsed.host === host && loopback
  } catch {
    return false
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  const normalized = first?.trim()
  return normalized ? normalized : undefined
}
