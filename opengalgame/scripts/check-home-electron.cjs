const { build } = require('esbuild')
const { spawn } = require('node:child_process')
const path = require('node:path')

const { dependencies } = require('../package.json')

/**
 * 以 QA 入口构建主进程代码并跑通 home 冒烟测试，透传子进程退出码。
 * 实现思路：别名只写在 tsconfig.node.json，根 tsconfig 仅有 references，不指定就无法解析跨层导入。
 * @throws {Error} 构建或启动子进程失败。
 */
async function check() {
  await build({
    entryPoints: [path.join(__dirname, '../src/bootstrap/home.ts')],
    outfile: path.join(__dirname, '../out/qa/home.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    tsconfig: path.join(__dirname, '../tsconfig.node.json'),
    external: ['electron', ...Object.keys(dependencies)]
  })
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key]
  const child = spawn(
    require('electron'),
    [path.join(__dirname, '../tests/electron/home-smoke.cjs')],
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
check().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
