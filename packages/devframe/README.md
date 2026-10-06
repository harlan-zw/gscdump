# @gscdump/devframe

Search Console data for the page you are developing, in Vite DevTools, Nuxt DevTools, and any [devframe](https://devfra.me) hub.

The dock shows clicks, impressions, CTR, and average position for the page that is open in your app, with the change against the previous window, a daily chart, and the top queries. It follows client-side navigation. Type any path or URL to read another page.

The data comes from your gscdump [Hosted record](https://gscdump.com), so the devtool makes no calls to Google.

```bash
npm install -D @gscdump/devframe
```

## Vite

Enable Vite DevTools and add the plugin:

```ts
// vite.config.ts
import { gscdump } from '@gscdump/devframe/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  devtools: true,
  plugins: [gscdump({ site: 'example.com' })],
})
```

`@gscdump/devframe/vite` needs `@vitejs/devtools` in the project.

## Nuxt

Nuxt DevTools 4 hosts Vite DevTools docks. Add the plugin to Nuxt's Vite config:

```ts
// nuxt.config.ts
import { gscdump } from '@gscdump/devframe/vite'

export default defineNuxtConfig({
  devtools: { enabled: true },
  vite: {
    plugins: [gscdump({ site: 'example.com' })],
  },
})
```

## Any devframe hub

`createGscdumpDevframe()` returns a devframe definition for any hub or adapter:

```ts
import { initHub } from '@devframes/hub/initiate'
import { createGscdumpDevframe } from '@gscdump/devframe'

const hub = initHub({
  base: '/__devframes/',
  devframes: [createGscdumpDevframe({ site: 'example.com' })],
})
```

## Credentials

The devtool reads with a Hosted credential. It looks in this order:

1. The `apiKey` option.
2. The `GSCDUMP_API_KEY` environment variable: a user API key from gscdump.com.
3. The CLI's Hosted login. Run `gscdump auth login --mode hosted` once.

The credential stays in the dev server process. The panel never receives it.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `site` | The only Site | The Site to read: a Site ID, a Site URL, or its host. If the credential holds several Sites and `site` is not set, the panel asks you to pick one. |
| `apiKey` | See [Credentials](#credentials) | A gscdump user API key. |
| `apiRoot` | `GSCDUMP_API_ROOT`, then `https://gscdump.com/api` | The Hosted API root. |

## Pages and windows

Search Console stores a Site's pages by path. The devtool reads the path of the page in view, with its query string, and ignores the dev server's origin. Search Console matches a path exactly, so `/blog/` and `/blog` are different pages.

The window ends three days before today in Pacific time, because Google has not finalized newer days. The gscdump.com dashboard uses the same end. If the Hosted record ends earlier, the window ends on its last day. The comparison window is the same number of days just before it.

## Chrome extension (prototype)

The same panel also builds as a Chrome side panel. It shows the stats for the page in the current tab, on your live site. It is not on the Chrome Web Store yet.

```bash
pnpm --filter @gscdump/devframe build:extension
```

1. Open `chrome://extensions` and turn on Developer mode.
2. Select Load unpacked, then select `packages/devframe/dist-extension`.
3. Sign in to gscdump.com in the same browser.
4. Open a page on one of your Sites, then select the extension's toolbar button.

The extension stores no API key. It reads your Sites with your gscdump.com login, and the tab's host selects the Site. It asks for two permissions: `tabs`, to read the current tab's address, and access to gscdump.com.

## Coding agents

The `get-page-stats` function is also an MCP tool. When the host serves MCP (Vite DevTools does), a coding agent can read a page's clicks, impressions, CTR, position, and top queries while it changes the page.

## License

MIT
