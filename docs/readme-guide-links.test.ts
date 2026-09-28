import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const readmes = ['../README.md', '../packages/cli/README.md']
const guideTrees = ['docs/gscdump-cli/', 'docs/gscdump-sdk/']

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
