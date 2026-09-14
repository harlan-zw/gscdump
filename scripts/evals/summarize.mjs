import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { analyzeWaste, gradeAgent, gradeAnswer } from './core.mjs'

// Reprocess existing evidence without running a model or contacting a Search Engine.
const directory = resolve(process.argv[2] ?? 'tmp/evals')
const files = await readdir(directory)
const summaries = []
for (const filename of files.filter(name => /^(?:query|empty|consent)-\d+-calls\.json$/.test(name))) {
  const id = filename.replace('-calls.json', '')
  const calls = JSON.parse(await readFile(join(directory, filename), 'utf8'))
  const eventText = await readFile(join(directory, `${id}-events.json`), 'utf8').catch((error) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
  const events = eventText === null ? [] : JSON.parse(eventText)
  const waste = analyzeWaste({ calls, events, kind: id.split('-')[0] })
  if (eventText === null)
    waste.findings.push({ kind: 'missing-events', evidence: { id }, suggestion: 'Inspect the saved process output. Agent event parsing failed.' })
  const loaded = events.some(event => event.type === 'tool_use' && event.part?.tool === 'skill' && event.part?.state?.input?.name === 'gscdump' && event.part?.state?.status === 'completed')
  const text = events.filter(event => event.type === 'text').map(event => event.part?.text ?? '').join('\n')
  const processGrade = gradeAgent({ calls, loaded, kind: id.split('-')[0], text })
  const query = calls.findLast(call => call.args[0] === 'query' && call.code === 0 && !call.args.includes('--help') && !call.args.includes('--explain'))
  let answerGrade = null
  if (!id.startsWith('consent-') && query) {
    try {
      answerGrade = gradeAnswer(text, JSON.parse(query.stdout).data)
    }
    catch (error) {
      answerGrade = { passed: false, failures: [`Cannot compare the answer because query output is not JSON: ${error.message}`] }
    }
  }
  if (answerGrade && !answerGrade.passed)
    waste.findings.push({ kind: 'answer-mismatch', evidence: { failures: answerGrade.failures }, suggestion: 'Return the requested JSON without rewriting rows or calculating unsupported totals.' })
  summaries.push({ id, ...waste, processGrade, answerGrade })
}
await writeFile(join(directory, 'waste.json'), JSON.stringify(summaries, null, 2), { mode: 0o600 })
const lines = ['# Agent execution findings', '', 'Observed behaviour from saved runs. Suggestions need review.', '', 'Harness denials do not prove a CLI defect.', 'Help lookups and repeated status checks are not automatically wasted work.', '']
for (const trial of summaries) {
  lines.push(`## ${trial.id}`, '', `${trial.commandCount} CLI calls. ${trial.repeatedCommands} exact repeats.`, '')
  for (const finding of trial.findings) {
    lines.push(`- **${finding.kind}**, ${finding.call ? `call ${finding.call}` : `event ${finding.event}`}. ${finding.suggestion}`, '', '```json', JSON.stringify(finding.evidence, null, 2), '```', '')
  }
}
await writeFile(join(directory, 'findings.md'), `${lines.join('\n')}\n`, { mode: 0o600 })
console.log(`Findings: ${join(directory, 'findings.md')}`)
