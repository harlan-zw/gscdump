import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { analyzeWaste, finalResponse, gradeAgent, gradeAnswer, invocation } from './core.mjs'

import { evaluatorIdentity } from './evidence.mjs'

// Reprocess existing evidence without running a model or contacting a Search Engine.
const directory = resolve(process.argv[2] ?? 'tmp/evals')
const files = await readdir(directory)
const original = await readFile(join(directory, 'report.json'), 'utf8')
const report = JSON.parse(original)
const evaluator = await evaluatorIdentity()
const stamp = `${new Date().toISOString().replaceAll(':', '-')}-${evaluator.grader.slice(0, 12)}`
const regrades = join(directory, 'regrades')
await mkdir(regrades, { recursive: true, mode: 0o700 })
let target
for (let attempt = 0; ; attempt++) {
  target = join(regrades, attempt === 0 ? stamp : `${stamp}.${attempt}`)
  try {
    await mkdir(target, { mode: 0o700 })
    break
  }
  catch (error) {
    if (error.code !== 'EEXIST')
      throw error
  }
}
const summaries = []
for (const filename of files.filter(name => /-\d+-calls\.json$/.test(name))) {
  const id = filename.replace('-calls.json', '')
  const recorded = report.agentTrials?.find(trial => trial.id === id || `${trial.kind}-${trial.trial}` === id)
  const kind = recorded?.kind ?? id.split('-')[0]
  const calls = JSON.parse(await readFile(join(directory, filename), 'utf8'))
  const eventText = await readFile(join(directory, `${id}-events.json`), 'utf8').catch((error) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
  const events = eventText === null ? [] : JSON.parse(eventText)
  const waste = analyzeWaste({ calls, events, kind })
  if (eventText === null)
    waste.findings.push({ kind: 'missing-events', evidence: { id }, suggestion: 'Inspect the saved process output. Agent event parsing failed.' })
  const loaded = events.some(event => event.type === 'tool_use' && event.part?.tool === 'skill' && event.part?.state?.input?.name === 'gscdump' && event.part?.state?.status === 'completed')
  const text = finalResponse(events)
  const processGrade = gradeAgent({ calls, loaded, kind, text, shouldTrigger: recorded?.shouldTrigger ?? true, storeUnchanged: recorded?.storeUnchanged, caseId: recorded?.caseId, expected: { site: report.site, start: report.start, end: report.end } })
  const query = calls.filter(call => invocation(call.args).command === 'query' && call.code === 0 && !invocation(call.args).help && !invocation(call.args).values.explain).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)).at(-1)
  let answerGrade = null
  if (!['consent', 'negative'].includes(kind) && query) {
    try {
      answerGrade = gradeAnswer(text, JSON.parse(query.stdout))
    }
    catch (error) {
      answerGrade = { passed: false, failures: [`Cannot compare the answer because query output is not JSON: ${error.message}`] }
    }
  }
  if (answerGrade && !answerGrade.passed)
    waste.findings.push({ kind: 'answer-mismatch', evidence: { failures: answerGrade.failures }, suggestion: 'Return the requested JSON without rewriting rows or calculating unsupported totals.' })
  summaries.push({ id, evidence: { calls: createHash('sha256').update(await readFile(join(directory, filename))).digest('hex'), events: eventText === null ? null : createHash('sha256').update(eventText).digest('hex') }, ...waste, processGrade, answerGrade })
}
await writeFile(join(target, 'report.json'), JSON.stringify({ original: { path: join(directory, 'report.json'), sha256: createHash('sha256').update(original).digest('hex'), evaluator: report.evaluator ?? null }, evaluator, trials: summaries }, null, 2), { mode: 0o600 })
const lines = ['# Agent execution findings', '', 'Observed behaviour from saved runs. Suggestions need review.', '', 'Harness denials do not prove a CLI defect.', 'Help lookups and repeated status checks are not automatically wasted work.', '']
for (const trial of summaries) {
  lines.push(`## ${trial.id}`, '', `${trial.commandCount} CLI calls. ${trial.repeatedCommands} exact repeats.`, '')
  for (const finding of trial.findings) {
    lines.push(`- **${finding.kind}**, ${finding.call ? `call ${finding.call}` : `event ${finding.event}`}. ${finding.suggestion}`, '', '```json', JSON.stringify(finding.evidence, null, 2), '```', '')
  }
}
await writeFile(join(target, 'findings.md'), `${lines.join('\n')}\n`, { mode: 0o600 })
console.log(`Findings: ${join(target, 'findings.md')}`)
