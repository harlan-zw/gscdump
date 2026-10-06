// Only pnpm resolves `workspace:` and `catalog:` dependency versions when it
// packs a package. `npm publish` ships them raw, and the published package
// cannot install. @gscdump/devframe 5.7.0 was published that way.

export type PublishAgentCheck
  = | { _tag: 'Allowed' }
    | { _tag: 'Refused', message: string }

/** Decide from `npm_config_user_agent` whether this publish resolves workspace versions. */
export function checkPublishAgent(userAgent: string | undefined): PublishAgentCheck {
  if (userAgent?.startsWith('pnpm/'))
    return { _tag: 'Allowed' }
  const tool = userAgent?.split('/')[0] || 'an unknown tool'
  return {
    _tag: 'Refused',
    message: `This package was published with ${tool}. Publish it with pnpm, for example \`pnpm publish --access public\` in the package directory. Other tools keep \`workspace:\` and \`catalog:\` versions, and the package then cannot install.`,
  }
}
