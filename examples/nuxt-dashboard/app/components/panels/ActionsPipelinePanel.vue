<script setup lang="ts">
// Pipeline panel: action priority. `ownsLifecycle: true` so the
// GscAnalyzerPanel shell skips its loading/empty gating. State persists
// across tab switches via useState in `useActionPriority`.

const { runner, ready } = useGscPanelRunner()
const actionPriority = useActionPriority()
</script>

<template>
  <div class="pipeline-body">
    <button
      class="pipeline-run"
      :disabled="!ready || actionPriority.running.value"
      @click="actionPriority.run(runner)"
    >
      {{ actionPriority.running.value ? 'Running…' : actionPriority.actions.value.length > 0 ? 'Re-run' : 'Generate action plan' }}
    </button>

    <div v-if="actionPriority.error.value" class="pipeline-err">
      {{ actionPriority.error.value.message }}
    </div>
    <div v-else-if="actionPriority.progress.value.phase === 'running'" class="pipeline-status">
      {{ actionPriority.progress.value.message }}
    </div>
    <ActionPriorityPanel v-if="actionPriority.actions.value.length > 0" :actions="actionPriority.actions.value" />
    <div v-else-if="actionPriority.progress.value.phase === 'idle'" class="pipeline-intro">
      <h3>Action priority dashboard</h3>
      <p>
        Runs five analyzers in parallel (striking-distance, opportunity,
        cannibalization, ctr-anomaly, change-point), dedupes by keyword+page,
        and ranks by composite <code>impact × severity × effortMultiplier</code>.
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
.pipeline-intro { padding: 2rem 1.5rem; text-align: center; background: #fafafb; border: 1px dashed #e4e4f0; border-radius: 6px; }
.pipeline-intro h3 { margin: 0 0 0.8rem; font-size: 1.05rem; color: #1d1d1f; }
.pipeline-intro p { margin: 0.5rem auto; max-width: 540px; font-size: 0.85rem; color: #555; line-height: 1.55; }
.pipeline-intro code { background: #f0f0f3; padding: 0.05rem 0.3rem; border-radius: 3px; font-size: 0.74rem; color: #4c3ca0; }
.pipeline-err { padding: 1rem 1.25rem; color: #c00; background: #fff5f5; font-family: ui-monospace, monospace; font-size: 0.82rem; white-space: pre-wrap; }
</style>
