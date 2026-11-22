const path = require('node:path')

const appRoot = path.resolve(__dirname, '..', '..', '..')
const configFile = path.join(appRoot, 'vite.renderer.config.ts')
const entry = path.join(__dirname, 'home-test-entry.ts')

async function buildHomeTestBundle() {
  const previousFilesMode = process.env.OPENGALGAME_BROWSER_FILES
  const previousNodeEnv = process.env.NODE_ENV
  process.env.OPENGALGAME_BROWSER_FILES = 'fixture'
  try {
    const { build } = await import('vite')
    const result = await build({
      configFile,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': JSON.stringify('development') },
      build: {
        write: false,
        minify: false,
        cssCodeSplit: false,
        assetsInlineLimit: 10 * 1024 * 1024,
        lib: {
          entry,
          name: 'OpenGalGameHomeTest',
          formats: ['iife'],
          fileName: () => 'home-test.js',
          cssFileName: 'home-test'
        }
      }
    })
    const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output
    const scriptOutput = outputs.find((output) => output.type === 'chunk' && output.isEntry)
    const styleOutput = outputs.find(
      (output) => output.type === 'asset' && output.fileName.endsWith('.css')
    )
    if (!scriptOutput || scriptOutput.type !== 'chunk') {
      throw new Error('Vite 未产出首页测试脚本')
    }
    if (!styleOutput || styleOutput.type !== 'asset') {
      throw new Error('Vite 未产出首页测试样式')
    }
    return {
      script: scriptOutput.code,
      stylesheet:
        typeof styleOutput.source === 'string'
          ? styleOutput.source
          : Buffer.from(styleOutput.source).toString('utf8')
    }
  } finally {
    if (previousFilesMode === undefined) delete process.env.OPENGALGAME_BROWSER_FILES
    else process.env.OPENGALGAME_BROWSER_FILES = previousFilesMode
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  }
}

module.exports = { buildHomeTestBundle }
