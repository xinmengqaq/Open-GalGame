import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDeflate } from 'node:zlib'

/**
 * 把文件流式写成 Git loose blob，不把整份内容留在内存里。
 * @param size - 调用前看到的文件字节数，必须与随后读到的内容一致。
 */
export async function writeLooseBlobFromFile(
  gitDir: string,
  filePath: string,
  size: number
): Promise<string> {
  const header = Buffer.from(`blob ${size}\0`)
  const hash = createHash('sha1')
  const tempDir = join(gitDir, 'objects', 'tmp')
  await mkdir(tempDir, { recursive: true })
  const tempPath = join(tempDir, randomUUID())
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  await pipeline(
    Readable.from(blobBytes(header, filePath)),
    hasher,
    createDeflate(),
    createWriteStream(tempPath)
  )
  const oid = hash.digest('hex')
  const finalDir = join(gitDir, 'objects', oid.slice(0, 2))
  await mkdir(finalDir, { recursive: true })
  await rename(tempPath, join(finalDir, oid.slice(2)))
  return oid
}

async function* blobBytes(header: Buffer, filePath: string): AsyncGenerator<Buffer> {
  yield header
  for await (const chunk of createReadStream(filePath)) yield chunk as Buffer
}
