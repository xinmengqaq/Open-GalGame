const { build } = require('esbuild')
const { spawn } = require('node:child_process')
const path = require('node:path')

const { dependencies } = require('../package.json')

/**
 * 以内联别名构建主进程代码并运行根工程创建脚本，透传子进程退出码。
 * @throws {Error} 构建或启动子进程失败。
 */
async function run() {
  const src = path.join(__dirname, '../src')
  await build({
    entryPoints: [path.join(__dirname, '../src/bootstrap/home.ts')],
    outfile: path.join(__dirname, '../out/qa/home.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', ...Object.keys(dependencies)],
    alias: {
      '@bootstrap': path.join(src, 'bootstrap'),
      '@presentation': path.join(src, 'presentation'),
      '@interfaces': path.join(src, 'interfaces'),
      '@application': path.join(src, 'application'),
      '@domain': path.join(src, 'domain'),
      '@infrastructure': path.join(src, 'infrastructure'),
      '@common': path.join(src, 'common')
    }
  })
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key]
  const child = spawn(
    require('electron'),
    [path.join(__dirname, '../tests/electron/create-root-project.cjs')],
    { stdio: 'inherit', windowsHide: true, env }
  )
  child.on('error', (error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
  child.on('exit', (code) => {
    process.exitCode = code ?? 1
  })
}
run().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
