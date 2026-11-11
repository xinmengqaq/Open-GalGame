const { spawn } = require('node:child_process')
const path = require('node:path')

const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') {
    delete env[key]
  }
}

const cli = path.join(__dirname, '..', 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
