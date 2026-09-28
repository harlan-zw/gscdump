import { access, readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { JSON_SCHEMA, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const readmes = ['../README.md', '../packages/cli/README.md']
const guideTrees = ['docs/gscdump-cli/', 'docs/gscdump-sdk/']

// Every file whose content can flip the guard's verdict must trigger the
// workflow that runs the guard, including on markdown-only changes.
const guardInputs = ['README.md', 'packages/cli/README.md', 'docs/readme-guide-links.test.ts', 'docs/gscdump-cli/**', 'docs/gscdump-sdk/**']

interface WorkflowJob {
  steps?: { run?: string }[]
}

interface Workflow {
  name?: string
  on?: Record<string, { paths?: string[] }> | null
  jobs?: Record<string, WorkflowJob>
}

function relativeLinks(markdown: string, readmeUrl: URL | string) {
  const links = [...markdown.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)].map(match => match[1])
  return links
    .filter(href => href.startsWith('./') || href.startsWith('../'))
    .map((href) => {
      const [path] = href.split('#')
      return { href, target: fileURLToPath(new URL(path, readmeUrl)) }
    })
}

async function frontmatter(target: string) {
  const text = await readFile(target, 'utf8')
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  return match?.[1] ?? ''
}

function coversPath(pattern: string, path: string) {
  if (pattern === path)
    return true
  if (pattern.endsWith('/**'))
    return path.startsWith(pattern.slice(0, -2))
  return false
}

describe('rEADME link guard CI wiring', () => {
  it('runs the guard whenever an input file changes, for push and pull requests', async () => {
    const workflowsUrl = new URL('../.github/workflows/', import.meta.url)
    const files = (await readdir(workflowsUrl)).filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
    expect(files.length, 'no workflow definitions found under .github/workflows').toBeGreaterThan(0)
    let guardRuns = 0
    for (const file of files) {
      const workflow = load(await readFile(new URL(file, workflowsUrl), 'utf8'), { schema: JSON_SCHEMA }) as Workflow
      for (const [job] of Object.entries(workflow.jobs ?? {})) {
        const runsGuard = (workflow.jobs![job]!.steps ?? []).some(step => step.run?.includes('docs/readme-guide-links.test.ts'))
        if (!runsGuard)
          continue
        guardRuns++
        for (const event of ['push', 'pull_request'] as const) {
          const paths = workflow.on?.[event]?.paths
          expect(Array.isArray(paths), `${file} must declare ${event}.paths so markdown-only changes still run the guard`).toBe(true)
          for (const input of guardInputs) {
            expect(
              paths!.some(pattern => coversPath(pattern, input)),
              `${file} ${event}.paths must cover ${input} or the guard never runs when only that file changes`,
            ).toBe(true)
          }
        }
      }
    }
    expect(guardRuns, `no workflow job runs vitest on docs/readme-guide-links.test.ts; a markdown-only README edit merges unguarded`).toBeGreaterThan(0)
  })
})

describe('rEADME guide links', () => {
  it('resolves every relative markdown link to an existing file', async () => {
    for (const readme of readmes) {
      const readmeUrl = new URL(readme, import.meta.url)
      const markdown = await readFile(readmeUrl, 'utf8')
      const links = relativeLinks(markdown, readmeUrl)
      expect(links.length, `no relative links found in ${readme}`).toBeGreaterThan(0)
      for (const { href, target } of links) {
        await access(target).catch(() => {
          throw new Error(`${readme} links ${href} but ${target} does not exist`)
        })
      }
    }
  })

  it('does not link navigation:false guide stubs', async () => {
    for (const readme of readmes) {
      const readmeUrl = new URL(readme, import.meta.url)
      const markdown = await readFile(readmeUrl, 'utf8')
      const links = relativeLinks(markdown, readmeUrl)
        .filter(({ target }) => guideTrees.some(tree => target.includes(`/${tree}`)))
      expect(links.length, `no relative ${guideTrees.join(' / ')} links found in ${readme}`).toBeGreaterThan(0)
      for (const { href, target } of links) {
        const meta = await frontmatter(target)
        expect(meta, `${readme} links ${href}, a guide stub that only says the guide moved`).not.toMatch(/navigation:\s*false/)
      }
    }
  })
})
