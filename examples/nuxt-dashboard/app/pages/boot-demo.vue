<script setup lang="ts">
// Visual demo of <GscBootProgress>. Doesn't run a real boot — it
// writes directly to the analytics context's progress map to simulate the
// multi-site fan-out so the component's visual states can be exercised
// without real data wiring.

// provideAnalytics is usually called by the layout; this page is standalone
// (it doesn't use the default layout) so we provide here.
definePageMeta({ layout: false })
const ctx = provideGscAnalytics()
const { progress, patchProgress, clearProgress } = ctx

const SITES = [
  'sc-domain:harlanzw.com',
  'sc-domain:nuxtseo.com',
  'https://zhead.dev/',
  'https://unhead.unjs.io/',
  'https://request-indexing.com/',
  'sc-domain:example.org',
  'https://foo.bar.baz/',
]

function seed() {
  const now = Date.now()
  for (let i = 0; i < SITES.length; i++) {
    patchProgress(SITES[i]!, {
      stage: 'wasm',
      filesAttached: 0,
      filesTotal: 0,
      startedAt: now + i * 50,
      endedAt: undefined,
      error: undefined,
    })
  }
}

async function simulate() {
  seed()
  await new Promise(r => setTimeout(r, 600))
  for (const id of SITES)
    patchProgress(id, { stage: 'manifest' })

  await new Promise(r => setTimeout(r, 800))
  for (const id of SITES)
    patchProgress(id, { stage: 'attach', filesTotal: 40 + Math.floor(Math.random() * 120) })

  const done = new Set<string>()
  while (done.size < SITES.length) {
    await new Promise(r => setTimeout(r, 80))
    for (const id of SITES) {
      if (done.has(id))
        continue
      const cur = progress.value[id]!
      const tick = Math.max(1, Math.floor(cur.filesTotal / (15 + Math.random() * 20)))
      const next = Math.min(cur.filesTotal, cur.filesAttached + tick)
      const ready = next >= cur.filesTotal
      patchProgress(id, {
        filesAttached: next,
        stage: ready ? 'ready' : 'attach',
        endedAt: ready ? Date.now() : undefined,
      })
      if (ready)
        done.add(id)
    }
  }
}

function simulateError() {
  seed()
  setTimeout(() => {
    patchProgress(SITES[2]!, {
      stage: 'error',
      error: 'fetch /api/__gsc/sites/foo/analysis-sources failed: 500',
      endedAt: Date.now(),
    })
  }, 400)
}

function reset() {
  clearProgress()
}
</script>

<template>
  <div class="wrap">
    <h1>GscBootProgress — visual demo</h1>
    <p class="note">
      This page does <em>not</em> hit the layer's analysis-sources endpoint — it seeds the
      analytics context's <code>progress</code> map directly to exercise the component's
      visual states. Real boot progress flows through the same map when a page calls
      <code>useGscAnalyzer(siteId)</code> and <code>useGscQuery</code> triggers analyzer init.
    </p>

    <div class="controls">
      <button type="button" @click="simulate">
        Simulate 7-site boot
      </button>
      <button type="button" @click="simulateError">
        Simulate error on one site
      </button>
      <button type="button" @click="reset">
        Reset
      </button>
    </div>

    <GscBootProgress />
  </div>
</template>

<style scoped>
.wrap {
  max-width: 640px;
  margin: 40px auto;
  padding: 0 16px;
  font-family: ui-sans-serif, system-ui, sans-serif;
  color: rgba(255, 255, 255, 0.92);
}
h1 {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 6px;
}
.note {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.55);
  line-height: 1.5;
  margin: 0 0 18px;
}
.note code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgba(255, 255, 255, 0.06);
  padding: 0 4px;
  border-radius: 2px;
}
.controls {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
button {
  appearance: none;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: inherit;
  padding: 6px 12px;
  font-size: 12px;
  font-family: inherit;
  border-radius: 3px;
  cursor: pointer;
  transition: background 120ms;
}
button:hover {
  background: rgba(255, 255, 255, 0.1);
}
</style>
