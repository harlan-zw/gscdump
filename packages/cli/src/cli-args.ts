import type { CommandDef, Resolvable } from 'citty'
import { parseArgs } from 'node:util'

async function resolve<T>(value: Resolvable<T>): Promise<T> {
  return typeof value === 'function' ? (value as () => T | Promise<T>)() : value
}

const GLOBAL_OPTIONS = new Set(['help', 'h', 'version', 'no-color'])

/** Check only the selected command. Root help must keep lazy imports lazy. */
export async function checkCliArgs(command: CommandDef, rawArgs: string[], path = 'gscdump'): Promise<string | undefined> {
  const definitions = await resolve(command.args ?? {})
  const options: Record<string, { type: 'string' | 'boolean' }> = {
    'help': { type: 'boolean' },
    'h': { type: 'boolean' },
    'version': { type: 'boolean' },
    'no-color': { type: 'boolean' },
  }
  for (const [name, definition] of Object.entries(definitions)) {
    if (definition.type === 'positional')
      continue
    const type = definition.type === 'boolean' ? 'boolean' : 'string'
    const alias = 'alias' in definition ? definition.alias : undefined
    const aliases = typeof alias === 'string' ? [alias] : alias ?? []
    const names = [name, ...aliases, name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)]
    for (const key of names) {
      options[key] = { type }
      if (type === 'boolean' && !key.startsWith('no-'))
        options[`no-${key}`] = { type }
    }
  }
  const { tokens } = parseArgs({ args: rawArgs, options, strict: false, allowPositionals: true, tokens: true })
  const subCommands = await resolve(command.subCommands ?? {})
  const positional = tokens.find(token => token.kind === 'positional')
  const hasSubCommands = Object.keys(subCommands).length > 0
  const boundary = hasSubCommands && positional ? positional.index : rawArgs.length
  for (const token of tokens) {
    if (token.index >= boundary || token.kind !== 'option')
      continue
    const option = options[token.name]
    if (!option) {
      const matches = Object.keys(definitions).filter(name => definitions[name]?.type !== 'positional' && name.startsWith(token.name) && name.length - token.name.length <= 2)
      const suggestion = matches.length === 1 ? ` Use --${matches[0]}.` : ''
      return `Unknown option ${token.rawName}.${suggestion} Run ${path} --help.`
    }
    if (option.type === 'string' && (token.value === undefined || (!token.inlineValue && token.value.startsWith('-'))))
      return `${token.rawName} requires a value. Use ${token.rawName}=VALUE.`
  }
  if (hasSubCommands && positional?.kind === 'positional') {
    let selected = subCommands[positional.value]
    if (!selected) {
      for (const candidate of Object.values(subCommands)) {
        const meta = await resolve((await resolve(candidate))?.meta ?? {})
        const aliases = typeof meta.alias === 'string' ? [meta.alias] : meta.alias ?? []
        if (aliases.includes(positional.value)) {
          selected = candidate
          break
        }
      }
    }
    if (!selected)
      return `Unknown command ${positional.value}. Run ${path} --help.`
    // citty gives a subcommand only the argv after its name, so a flag placed
    // before the name would be dropped without a word.
    const early = tokens.find(token => token.index < boundary && token.kind === 'option' && !GLOBAL_OPTIONS.has(token.name))
    if (early?.kind === 'option')
      return `Put ${early.rawName} after the subcommand: ${path} ${positional.value} ${early.rawName}.`
    const child = await resolve(selected)
    if (child)
      return checkCliArgs(child, rawArgs.slice(boundary + 1), `${path} ${positional.value}`)
  }
}
