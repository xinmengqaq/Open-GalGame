const path = require('node:path')

const appRoot = path.resolve(__dirname, '..', '..', '..')
const configFile = path.join(appRoot, 'vite.renderer.config.ts')
const entry = path.join(__dirname, 'home-test-entry.ts')

/**
 * 用应用自身的 Vite 配置生成首页用例可注入的脚本和样式。
 *
 * 直接调 esbuild 读不到根 solution tsconfig 里的 paths，也缺 alias、SVG 资源、
 * md-blockkit 与 Tailwind 的构建链。这里复用 renderer 的 Vite 配置，打包结果与
 * 真实页面一致；保持 IIFE + 独立 CSS，沿用用例原有的注入方式。
 * @returns 首页脚本与样式文本。
 */
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
        // 资源和样式都注入同一页面，避免测试页面再起静态资源服务。
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
