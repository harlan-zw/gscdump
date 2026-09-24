import { isAbsolute, relative, resolve } from 'node:path'
import { invocation } from './core.mjs'

export function checkScope(args, settings) {
  const { command, subcommand, values, help, duplicateOptions, parseError } = invocation(args)
  if (parseError)
    return { reason: parseError, sync: false }
  const sync = command === 'sync' && !help && !values.status && !values['dry-run']
  const allowed = help || (!command && values.version) || ['query', 'sync', 'dump', 'analyze', 'report'].includes(command)
    || (command === 'auth' && subcommand === 'status')
    || (command === 'store' && (!subcommand || ['stats', 'ls', 'info'].includes(subcommand)))
    || (command === 'sites' && !subcommand)
    || (command === 'indexing' && subcommand === 'quota')
  let reason = allowed ? null : 'This operation is outside the evaluation scope.'
  if (duplicateOptions.length)
    reason = `Use each option once. Repeated options: ${duplicateOptions.map(name => `--${name}`).join(', ')}. Short flags are aliases.`
  if (['config-dir', 'profile', 'sql', 'all-sites', 'data-dir', 'api-key', 'api-root'].some(flag => flag in values))
    reason = 'The evaluation configuration cannot be overridden.'
  if (values.live && !settings.allowLive)
    reason = 'Use the Store for this trial.'
  const domainAlias = settings.site.startsWith('sc-domain:') ? settings.site.slice('sc-domain:'.length) : null
  if ('site' in values && values.site !== settings.site && values.site !== domainAlias)
    reason = 'The Site is outside the evaluation scope.'
  for (const key of ['out', 'output']) {
    if (!(key in values) || values[key] === '-')
      continue
    const path = values[key]
    const inside = typeof path === 'string' ? relative(settings.workspace, resolve(settings.workspace, path)) : '..'
    if (typeof path !== 'string' || isAbsolute(path) || inside === '..' || inside.startsWith('../') || isAbsolute(inside))
      reason = 'Output must stay inside the trial workspace.'
  }
  if (sync && (!/^\d{4}-\d{2}-\d{2}$/.test(values.start ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(values.end ?? '') || values.start < settings.start || values.end > settings.end || values.start > values.end || values.tables !== (settings.tables ?? 'pages')))
    reason = 'Sync must stay within the requested dates and tables.'
  return { reason, sync }
}
