import fs from 'node:fs'

const pidFile = process.argv[2]
if (!pidFile) throw new Error('missing pid file')
fs.writeFileSync(pidFile, String(process.pid))
setInterval(() => {}, 1000)
