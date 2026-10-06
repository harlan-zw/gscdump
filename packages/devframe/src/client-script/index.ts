// The page script. The hub imports it into the user's app page when the
// Search Console dock first opens. It shares the page in view with the panel
// over the in-page channel, so the panel follows client-side navigation.

import type { PageChannelProtocol, PageLocation } from '../shared/protocol'
import { createPageScriptChannel } from 'devframe/in-page-channel'
import { PAGE_CHANNEL } from '../shared/protocol'

const BOOTED = '__GSCDUMP_DEVFRAME_PAGE_SCRIPT__'

function currentLocation(): PageLocation {
  return { path: location.pathname, href: location.href, title: document.title }
}

async function start(): Promise<void> {
  const flags = globalThis as typeof globalThis & { [BOOTED]?: boolean }
  if (flags[BOOTED])
    return
  flags[BOOTED] = true

  const channel = createPageScriptChannel<PageChannelProtocol>({ name: PAGE_CHANNEL, functions: {} })
  const state = await channel.sharedState.get('location', { initialValue: currentLocation() })

  function publish(): void {
    const next = currentLocation()
    const previous = state.value()
    if (previous.href === next.href && previous.title === next.title)
      return
    state.mutate((draft) => {
      draft.path = next.path
      draft.href = next.href
      draft.title = next.title
    })
  }

  // Framework-neutral route tracking: wrap the History API and listen for
  // back and forward. The title updates after the route, so publish again on
  // the next frame.
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method]
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args)
      publish()
      requestAnimationFrame(publish)
      return result
    }
  }
  addEventListener('popstate', publish)
  new MutationObserver(publish).observe(document.head, { childList: true, subtree: true, characterData: true })
}

/** The dock client script entry. The hub calls it with its client context, which this script does not need. */
export default function setup(): Promise<void> {
  return start()
}
