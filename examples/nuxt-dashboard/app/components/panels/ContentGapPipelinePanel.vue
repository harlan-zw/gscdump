<script setup lang="ts">
// Pipeline panel: semantic content-gap detection. `ownsLifecycle: true` so
// the shell skips its gating; state persists via useState in useContentGap.

const { runner, ready } = useGscPanelRunner()
const contentGap = useContentGap()
</script>

<template>
  <div class="pipeline-body">
    <button
      class="pipeline-run"
      :disabled="!ready || contentGap.running.value"
      @click="contentGap.run(runner)"
    >
      {{ contentGap.running.value ? 'Running…' : contentGap.results.value.length > 0 ? 'Re-run' : 'Detect content gaps' }}
    </button>

    <div v-if="contentGap.error.value" class="pipeline-err">
      {{ contentGap.error.value.message }}
    </div>

    <div v-if="contentGap.progress.value.phase !== 'done' && contentGap.progress.value.phase !== 'idle'" class="pipeline-status">
      {{ contentGap.progress.value.message }}
      <div v-if="contentGap.progress.value.total" class="pipeline-progress-bar">
        <div class="pipeline-progress-fill" :style="{ width: `${((contentGap.progress.value.done ?? 0) / contentGap.progress.value.total) * 100}%` }" />
      </div>
    </div>

    <ContentGapPanel v-if="contentGap.results.value.length > 0" :rows="contentGap.results.value" />

    <div v-else-if="contentGap.progress.value.phase === 'idle'" class="pipeline-intro">
      <h3>Semantic content-gap detection</h3>
      <p>
        Embeds every top query and every URL via a local MiniLM model (22MB,
        cached in IndexedDB). Cosine-matches each query to its best semantic
        URL, then flags queries where Google ranks you on a different URL
        than the one that <em>topically</em> fits best.
      </p>
    </div>
  </div>
</template>

<style scoped>
.pipeline-body { display: flex; flex-direction: column; gap: 0.85rem; }
.pipeline-run { align-self: flex-end; padding: 0.55rem 1.1rem; border: 0; border-radius: 4px; background: #4c3ca0; color: #fff; font-weight: 600; font-size: 0.82rem; cursor: pointer; transition: background 0.15s; }
.pipeline-run:hover:not(:disabled) { background: #3a2c85; }
.pipeline-run:disabled { opacity: 0.5; cursor: not-allowed; }
.pipeline-status { padding: 0.7rem 0.9rem; background: #f6f6fb; border: 1px solid #e4e4f0; border-radius: 4px; font-size: 0.8rem; color: #444; }
.pipeline-progress-bar { margin-top: 0.4rem; height: 4px; background: #e4e4f0; border-radius: 2px; overflow: hidden; }
.pipeline-progress-fill { height: 100%; background: linear-gradient(90deg, #7a6cd0, #4c3ca0); transition: width 0.2s; }
.pipeline-intro { padding: 2rem 1.5rem; text-align: center; background: #fafafb; border: 1px dashed #e4e4f0; border-radius: 6px; }
.pipeline-intro h3 { margin: 0 0 0.8rem; font-size: 1.05rem; color: #1d1d1f; }
.pipeline-intro p { margin: 0.5rem auto; max-width: 540px; font-size: 0.85rem; color: #555; line-height: 1.55; }
.pipeline-intro em { color: #4c3ca0; font-style: italic; }
.pipeline-err { padding: 1rem 1.25rem; color: #c00; background: #fff5f5; font-family: ui-monospace, monospace; font-size: 0.82rem; white-space: pre-wrap; }
</style>
