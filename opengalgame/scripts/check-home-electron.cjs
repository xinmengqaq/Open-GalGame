const { build } = require('esbuild')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { dependencies } = require('../package.json')

async function check() {
  await build({
    entryPoints: [path.join(__dirname, '../src/bootstrap/home.ts')],
    outfile: path.join(__dirname, '../out/qa/home.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    tsconfig: path.join(__dirname, '../tsconfig.node.json'),
    define: {
      'import.meta.url': JSON.stringify(
        pathToFileURL(path.join(__dirname, '../out/qa/home.cjs')).href
      )
    },
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
