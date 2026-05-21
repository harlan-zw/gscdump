/**
 * Pure-JS drop-in replacement for `hysnappy`.
 *
 * `hysnappy`'s `snappyUncompressor()` eagerly compiles a WASM module
 * (`new WebAssembly.Module(byteArray)`) — and `hyparquet-compressors`
 * instantiates it at module top level (`SNAPPY: snappyUncompressor()`).
 * Cloudflare's `workerd` forbids compiling WebAssembly from a runtime buffer
 * (WASM must be a bundled module import), so any Worker bundle that imports
 * `icebird` (→ `hyparquet-compressors`) fails to start with
 * `CompileError: Wasm code generation disallowed by embedder`.
 *
 * `icebird`'s append path never actually decompresses a snappy data file — it
 * only reads gzipped `metadata.json` and Avro manifests — so the snappy
 * decompressor is instantiated but never invoked. This shim swaps the WASM
 * codec for `hyparquet`'s pure-JS snappy decompressor (a vendored snappyjs),
 * keeping the exact `hysnappy` API surface so `hyparquet-compressors` is
 * unaware of the swap. Wired in via a build-time `hysnappy` alias.
 *
 * See `docs/plans/2026-05-22-icebird-ingest-writer-spike.md` (section e).
 */

// `hyparquet/src/snappy.js` is a leaf module — pure JS, no deps, no WASM.
// `snappyDecodeInto(input, output)` decompresses `input` into the provided
// `output` buffer (snappyjs convention).
import { snappyUncompress as snappyDecodeInto } from 'hyparquet/src/snappy.js'

/** Decompress a snappy buffer, allocating the output. Matches the `hysnappy` contract. */
function decode(input: Uint8Array, outputLength: number): Uint8Array {
  const output = new Uint8Array(outputLength)
  snappyDecodeInto(input, output)
  return output
}

/**
 * Pure-JS stand-in for `hysnappy`'s `snappyUncompressor()`. Returns the
 * decompressor immediately — no WASM compilation, so it is safe to call at
 * module top level inside `workerd`.
 */
export function snappyUncompressor(): (input: Uint8Array, outputLength: number) => Uint8Array {
  return decode
}

/** Pure-JS stand-in for `hysnappy`'s `snappyUncompress(input, outputLength)`. */
export function snappyUncompress(input: Uint8Array, outputLength: number): Uint8Array {
  return decode(input, outputLength)
}
