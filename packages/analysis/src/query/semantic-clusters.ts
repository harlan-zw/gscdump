/**
 * Deterministic average-linkage (UPGMA) semantic clustering over precomputed
 * canonical query embeddings.
 *
 * ADR-0027 compliant:
 * - Published formula (exact average-linkage cosine similarity with explicit
 *   model, threshold, centroid similarity, and minimum pairwise similarity).
 * - Label is the highest-impression query in the cluster (no LLM verdicts).
 * - Order-invariant (ARI = 1.000 under shuffled inputs) via canonical sorting
 *   and deterministic tie-breaking.
 * - Structural guardrails partition queries by numeric/version signature,
 *   polarity signature, and directional conversion signature before clustering
 *   so versions (`nuxt 3` vs `nuxt 4`), years (`2025` vs `2026`), negations
 *   (`robots index` vs `robots noindex`), and reversed conversions
 *   (`png to jpg` vs `jpg to png`) never collapse together.
 */

export const SEMANTIC_CLUSTERING_VERSION = 1
export const DEFAULT_SEMANTIC_THRESHOLD = 0.86

export interface SemanticClusterInput {
  query: string
  canonical: string
  impressions: number
  clicks: number
  position: number
  vector: Float32Array | readonly number[]
}

export interface SemanticClusterOptions {
  /** Minimum average-linkage cosine similarity to merge (0.5..0.99). Default: 0.86 */
  threshold?: number
  /** Minimum raw queries required to emit a cluster. Default: 2 */
  minClusterSize?: number
  /** Maximum canonical nodes allowed inside one cluster. Default: 250 */
  maxClusterSize?: number
  /** Maximum clusters to return (sorted by impressions desc). Default: 200 */
  limit?: number
  /** Embedding model identifier stamped into cluster metadata and IDs. */
  model?: string
}

export interface SemanticClusterMember {
  query: string
  canonical: string
  impressions: number
  clicks: number
  position: number
  similarityToCentroid: number
}

export interface SemanticCluster {
  clusterId: string
  label: string
  leadCanonical: string
  keywordCount: number
  canonicalCount: number
  totalImpressions: number
  totalClicks: number
  ctr: number
  avgPosition: number
  meanCentroidSimilarity: number
  minPairwiseSimilarity: number
  keywords: SemanticClusterMember[]
}

export interface SemanticClusteringMeta {
  algorithm: 'upgma'
  version: number
  model: string
  threshold: number
  minClusterSize: number
  maxClusterSize: number
  totalClusters: number
  returned: number
  clusteredQueries: number
  unclusteredQueries: number
  totalImpressions: number
  clusteredImpressions: number
}

export interface SemanticClusteringResult {
  results: SemanticCluster[]
  meta: SemanticClusteringMeta
}

const DIGIT_RUN_RE = /\d+/g
const WHITESPACE_RE = /\s+/

const POLARITY_TOKENS = new Set([
  'no',
  'not',
  'non',
  'without',
  'never',
  'noindex',
  'nofollow',
  'disallow',
  'disable',
  'disabled',
  'exclude',
  'off',
  'false',
  'vs',
  'versus',
  'alternative',
])

const DIRECTIONAL_CONNECTORS = new Set(['to', 'into', '>', '→'])
const NON_DIRECTIONAL_BEFORE = new Set([
  'how',
  'what',
  'why',
  'when',
  'where',
  'who',
  'which',
  'guide',
  'way',
  'tip',
  'intro',
  'introduction',
  'learn',
  'tutorial',
  'step',
  'reason',
  'idea',
  'example',
  'benefit',
  'need',
])

interface CanonicalNode {
  canonical: string
  unitVec: Float32Array
  members: Array<{ query: string, impressions: number, clicks: number, position: number }>
  impressions: number
  clicks: number
}

function normalizeUnit(vec: Float32Array | readonly number[]): Float32Array | null {
  const n = vec.length
  if (n === 0)
    return null
  let normSq = 0
  for (let i = 0; i < n; i++) {
    const v = vec[i]!
    if (!Number.isFinite(v))
      return null
    normSq += v * v
  }
  if (normSq === 0)
    return null
  const inv = 1 / Math.sqrt(normSq)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++)
    out[i] = vec[i]! * inv
  return out
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++)
    s += a[i]! * b[i]!
  return s
}

function guardrailBucketKey(canonical: string): string {
  const digits = canonical.match(DIGIT_RUN_RE)?.join('|') ?? ''
  const tokens = canonical.split(WHITESPACE_RE).filter(Boolean)
  const polarity: string[] = []
  let directional = ''
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (POLARITY_TOKENS.has(t))
      polarity.push(t)
    if (
      i > 0
      && i < tokens.length - 1
      && DIRECTIONAL_CONNECTORS.has(t)
      && !NON_DIRECTIONAL_BEFORE.has(tokens[i - 1]!)
    ) {
      directional = `${tokens[i - 1]}->${tokens[i + 1]}`
    }
  }
  polarity.sort()
  const polSig = polarity.length > 0 ? [...new Set(polarity)].join('|') : ''
  return `${digits}\x00${polSig}\x00${directional}`
}

function fnv1a64(input: string): string {
  let hi = 0x811C9DC5
  let lo = 0xCBF29CE4
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    lo ^= c
    const loMul = Math.imul(lo, 0x000001B3) >>> 0
    const carry = Math.floor((lo * 0x000001B3) / 0x100000000)
    const hiMul = (Math.imul(hi, 0x000001B3) + Math.imul(lo, 0x00000001) + carry) >>> 0
    lo = loMul
    hi = hiMul
  }
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0')
}

/**
 * Run exact deterministic average-linkage (UPGMA) clustering within one
 * connected component of the threshold similarity graph using scalar
 * Lance-Williams updates:
 *   sim(A ∪ B, D) = (|A| * sim(A, D) + |B| * sim(B, D)) / (|A| + |B|)
 * Computing pairwise dot products once per component reduces complexity from
 * O(k^3 * dims) to O(k^2 * dims) with bit-identical deterministic tie-breaking.
 */
function runComponentUpgma(
  nodes: readonly CanonicalNode[],
  componentIndices: readonly number[],
  threshold: number,
  maxClusterSize: number,
): number[][] {
  const k = componentIndices.length
  if (k <= 1)
    return [componentIndices.slice()]

  const members: number[][] = componentIndices.map(idx => [idx])
  const minCanonical: string[] = componentIndices.map(idx => nodes[idx]!.canonical)
  const size = new Int32Array(k).fill(1)
  const alive = new Uint8Array(k).fill(1)

  // Symmetric k × k average-linkage similarity matrix (computed once).
  const simMatrix = new Float64Array(k * k)
  for (let i = 0; i < k; i++) {
    const vi = nodes[componentIndices[i]!]!.unitVec
    for (let j = i + 1; j < k; j++) {
      const s = dot(vi, nodes[componentIndices[j]!]!.unitVec)
      simMatrix[i * k + j] = s
      simMatrix[j * k + i] = s
    }
  }

  const bestPartner = new Int32Array(k).fill(-1)
  const bestSim = new Float64Array(k).fill(-2)
  const TIE_EPS = 1e-12

  const recomputeBest = (i: number): void => {
    let partner = -1
    let topSim = threshold - TIE_EPS
    let topKeyA = ''
    let topKeyB = ''
    const rowOff = i * k
    const sizeI = size[i]!
    const keyI = minCanonical[i]!

    for (let j = 0; j < k; j++) {
      if (j === i || !alive[j])
        continue
      if (sizeI + size[j]! > maxClusterSize)
        continue
      const s = simMatrix[rowOff + j]!
      if (s < threshold)
        continue
      const keyJ = minCanonical[j]!
      const [kA, kB] = keyI < keyJ ? [keyI, keyJ] : [keyJ, keyI]
      const better = s > topSim + TIE_EPS
      const tied = Math.abs(s - topSim) <= TIE_EPS
        && (partner === -1 || kA < topKeyA || (kA === topKeyA && kB < topKeyB))
      if (better || tied) {
        topSim = s
        partner = j
        topKeyA = kA
        topKeyB = kB
      }
    }
    bestPartner[i] = partner
    bestSim[i] = partner === -1 ? -2 : topSim
  }

  for (let i = 0; i < k; i++)
    recomputeBest(i)

  let aliveCount = k
  while (aliveCount > 1) {
    let bestI = -1
    let bestJ = -1
    let topSim = threshold - TIE_EPS
    let topKeyA = ''
    let topKeyB = ''

    for (let i = 0; i < k; i++) {
      if (!alive[i])
        continue
      const j = bestPartner[i]!
      if (j === -1 || j < i || !alive[j])
        continue
      const s = bestSim[i]!
      if (s < threshold)
        continue
      const keyI = minCanonical[i]!
      const keyJ = minCanonical[j]!
      const [kA, kB] = keyI < keyJ ? [keyI, keyJ] : [keyJ, keyI]
      const better = s > topSim + TIE_EPS
      const tied = Math.abs(s - topSim) <= TIE_EPS
        && (bestI === -1 || kA < topKeyA || (kA === topKeyA && kB < topKeyB))
      if (better || tied) {
        topSim = s
        bestI = i
        bestJ = j
        topKeyA = kA
        topKeyB = kB
      }
    }

    if (bestI === -1 || bestJ === -1)
      break

    const sizeA = size[bestI]!
    const sizeB = size[bestJ]!
    const newSize = sizeA + sizeB
    const offA = bestI * k
    const offB = bestJ * k

    alive[bestJ] = 0
    aliveCount--
    size[bestI] = newSize
    members[bestI]!.push(...members[bestJ]!)
    if (minCanonical[bestJ]! < minCanonical[bestI]!)
      minCanonical[bestI] = minCanonical[bestJ]!

    // Lance-Williams average-linkage update against every other live cluster.
    for (let d = 0; d < k; d++) {
      if (!alive[d] || d === bestI)
        continue
      const updated = (sizeA * simMatrix[offA + d]! + sizeB * simMatrix[offB + d]!) / newSize
      simMatrix[offA + d] = updated
      simMatrix[d * k + bestI] = updated
    }

    recomputeBest(bestI)
    for (let d = 0; d < k; d++) {
      if (!alive[d] || d === bestI)
        continue
      const bp = bestPartner[d]!
      const newSim = simMatrix[d * k + bestI]!
      if (
        bp === bestI
        || bp === bestJ
        || (size[d]! + newSize <= maxClusterSize && newSim >= bestSim[d]! - TIE_EPS)
      ) {
        recomputeBest(d)
      }
    }
  }

  const out: number[][] = []
  for (let i = 0; i < k; i++) {
    if (alive[i])
      out.push(members[i]!)
  }
  return out
}

/**
 * Partition a guardrail bucket into connected components of the exact cosine
 * threshold graph (`dot(u_i, u_j) >= threshold`), then run exact UPGMA inside
 * each component. Because average linkage cannot exceed `max(sim(A, D), sim(B, D))`,
 * cross-component merges are mathematically impossible — producing results
 * identical to full O(N^2) UPGMA with drastically less work and memory.
 */
function clusterBucketUpgma(
  nodes: readonly CanonicalNode[],
  threshold: number,
  maxClusterSize: number,
): number[][] {
  const m = nodes.length
  if (m === 0)
    return []
  if (m === 1)
    return [[0]]

  const parent = new Int32Array(m)
  for (let i = 0; i < m; i++)
    parent[i] = i

  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r)
      r = parent[r]!
    let cur = x
    while (parent[cur] !== r) {
      const next = parent[cur]!
      parent[cur] = r
      cur = next
    }
    return r
  }

  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) {
      if (ra < rb)
        parent[rb] = ra
      else
        parent[ra] = rb
    }
  }

  for (let i = 0; i < m; i++) {
    const vi = nodes[i]!.unitVec
    for (let j = i + 1; j < m; j++) {
      if (dot(vi, nodes[j]!.unitVec) >= threshold)
        union(i, j)
    }
  }

  const components = new Map<number, number[]>()
  for (let i = 0; i < m; i++) {
    const root = find(i)
    const list = components.get(root)
    if (list)
      list.push(i)
    else
      components.set(root, [i])
  }

  const clusters: number[][] = []
  for (const comp of components.values()) {
    const subClusters = runComponentUpgma(nodes, comp, threshold, maxClusterSize)
    clusters.push(...subClusters)
  }
  return clusters
}

/**
 * Pure: cluster embedded queries using deterministic average-linkage (UPGMA)
 * cosine similarity with numeric/version, polarity, and directional guards.
 */
export function clusterQueryEmbeddings(
  inputs: readonly SemanticClusterInput[],
  options: SemanticClusterOptions = {},
): SemanticClusteringResult {
  const threshold = options.threshold ?? DEFAULT_SEMANTIC_THRESHOLD
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.99)
    throw new Error(`Invalid semantic clustering threshold ${threshold}. Expected a number between 0.5 and 0.99.`)

  const minClusterSize = options.minClusterSize ?? 2
  const maxClusterSize = options.maxClusterSize ?? 250
  const limit = options.limit ?? 200
  const model = options.model ?? 'unknown'

  // Collapse raw queries by canonical key first (aggregating duplicate raw strings safely).
  const byCanonical = new Map<string, {
    canonical: string
    unitVec: Float32Array
    byQuery: Map<string, { query: string, impressions: number, clicks: number, weightedPos: number, posSum: number, count: number }>
  }>()

  let expectedDims: number | null = null
  let totalInputImpressions = 0

  for (const row of inputs) {
    const query = row.query.trim()
    const canonical = row.canonical.trim()
    if (!query || !canonical)
      continue
    const unitVec = normalizeUnit(row.vector)
    if (!unitVec)
      continue
    if (expectedDims === null)
      expectedDims = unitVec.length
    else if (unitVec.length !== expectedDims)
      throw new Error(`Inconsistent embedding dimensions: expected ${expectedDims}, got ${unitVec.length} for "${canonical}".`)

    let entry = byCanonical.get(canonical)
    if (!entry) {
      entry = { canonical, unitVec, byQuery: new Map() }
      byCanonical.set(canonical, entry)
    }
    const existing = entry.byQuery.get(query) ?? { query, impressions: 0, clicks: 0, weightedPos: 0, posSum: 0, count: 0 }
    existing.impressions += row.impressions
    existing.clicks += row.clicks
    existing.weightedPos += (row.position - 1) * row.impressions
    existing.posSum += row.position
    existing.count += 1
    entry.byQuery.set(query, existing)
  }

  // Sort canonical nodes lexicographically so clustering is 100% order-invariant.
  const allNodes: CanonicalNode[] = [...byCanonical.values()]
    .sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0))
    .map((entry) => {
      const members = [...entry.byQuery.values()].map(m => ({
        query: m.query,
        impressions: m.impressions,
        clicks: m.clicks,
        position: m.impressions > 0 ? m.weightedPos / m.impressions + 1 : m.posSum / m.count,
      }))
      const impressions = members.reduce((s, m) => s + m.impressions, 0)
      const clicks = members.reduce((s, m) => s + m.clicks, 0)
      totalInputImpressions += impressions
      return {
        canonical: entry.canonical,
        unitVec: entry.unitVec,
        members,
        impressions,
        clicks,
      }
    })

  const totalUniqueQueries = allNodes.reduce((s, n) => s + n.members.length, 0)

  // Partition by structural guardrail bucket before UPGMA.
  const buckets = new Map<string, CanonicalNode[]>()
  for (const node of allNodes) {
    const key = guardrailBucketKey(node.canonical)
    const list = buckets.get(key)
    if (list)
      list.push(node)
    else
      buckets.set(key, [node])
  }

  const emitted: SemanticCluster[] = []
  let clusteredQueries = 0
  let clusteredImpressions = 0

  for (const bucketNodes of buckets.values()) {
    const nodeGroups = clusterBucketUpgma(bucketNodes, threshold, maxClusterSize)
    for (const idxGroup of nodeGroups) {
      const groupNodes = idxGroup.map(i => bucketNodes[i]!)
      const rawCount = groupNodes.reduce((s, n) => s + n.members.length, 0)
      if (rawCount < minClusterSize)
        continue

      // Compute unit centroid of the cluster's canonical vectors.
      const dims = groupNodes[0]!.unitVec.length
      const centroidSum = new Float32Array(dims)
      for (const node of groupNodes) {
        for (let d = 0; d < dims; d++)
          centroidSum[d] = centroidSum[d]! + node.unitVec[d]!
      }
      const centroid = normalizeUnit(centroidSum) ?? groupNodes[0]!.unitVec

      // Exact minimum pairwise cosine similarity across canonical members.
      let minPairwise = 1
      for (let i = 0; i < groupNodes.length; i++) {
        for (let j = i + 1; j < groupNodes.length; j++) {
          const sim = dot(groupNodes[i]!.unitVec, groupNodes[j]!.unitVec)
          if (sim < minPairwise)
            minPairwise = sim
        }
      }

      const keywords: SemanticClusterMember[] = []
      let totalImpressions = 0
      let totalClicks = 0
      let weightedPosSum = 0
      let posWeight = 0
      let posSum = 0
      let centroidSimSum = 0

      for (const node of groupNodes) {
        const simToCentroid = Math.min(1, Math.max(-1, dot(node.unitVec, centroid)))
        centroidSimSum += simToCentroid
        for (const m of node.members) {
          totalImpressions += m.impressions
          totalClicks += m.clicks
          posSum += m.position
          if (m.impressions > 0) {
            weightedPosSum += (m.position - 1) * m.impressions
            posWeight += m.impressions
          }
          keywords.push({
            query: m.query,
            canonical: node.canonical,
            impressions: m.impressions,
            clicks: m.clicks,
            position: m.position,
            similarityToCentroid: Math.round(simToCentroid * 10_000) / 10_000,
          })
        }
      }

      keywords.sort((a, b) =>
        b.impressions - a.impressions
        || b.clicks - a.clicks
        || (a.query < b.query ? -1 : a.query > b.query ? 1 : 0),
      )

      const sortedCanonicals = groupNodes.map(n => n.canonical).sort()
      const clusterId = `sem_${fnv1a64(`v${SEMANTIC_CLUSTERING_VERSION}|${model}|${threshold.toFixed(4)}|${sortedCanonicals.join('\x01')}`).slice(0, 12)}`
      const lead = keywords[0]!

      clusteredQueries += keywords.length
      clusteredImpressions += totalImpressions

      emitted.push({
        clusterId,
        label: lead.query,
        leadCanonical: lead.canonical,
        keywordCount: keywords.length,
        canonicalCount: groupNodes.length,
        totalImpressions,
        totalClicks,
        ctr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
        avgPosition: posWeight > 0 ? weightedPosSum / posWeight + 1 : posSum / keywords.length,
        meanCentroidSimilarity: Math.round((centroidSimSum / groupNodes.length) * 10_000) / 10_000,
        minPairwiseSimilarity: Math.round(minPairwise * 10_000) / 10_000,
        keywords,
      })
    }
  }

  emitted.sort((a, b) =>
    b.totalImpressions - a.totalImpressions
    || b.totalClicks - a.totalClicks
    || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  )

  const returned = emitted.slice(0, limit)
  return {
    results: returned,
    meta: {
      algorithm: 'upgma',
      version: SEMANTIC_CLUSTERING_VERSION,
      model,
      threshold,
      minClusterSize,
      maxClusterSize,
      totalClusters: emitted.length,
      returned: returned.length,
      clusteredQueries,
      unclusteredQueries: Math.max(0, totalUniqueQueries - clusteredQueries),
      totalImpressions: totalInputImpressions,
      clusteredImpressions,
    },
  }
}
