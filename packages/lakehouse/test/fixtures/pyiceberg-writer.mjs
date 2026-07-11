import process from 'node:process'

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin)
  input += chunk

const job = JSON.parse(input)
process.stdout.write(JSON.stringify({ rowCount: job.rowCount }))
