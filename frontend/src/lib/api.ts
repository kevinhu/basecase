export type TrackKind =
  | 'gene'
  | 'variant'
  | 'regulatory'
  | 'signal'
  | 'repeat'
  | 'feature'

export type TrackDefinition = {
  id: string
  assembly: string
  label: string
  description: string
  category: string
  kind: TrackKind
  source_type: string
  source_url: string | null
  data_version: string | null
  default_visible: boolean
  default_rank: number | null
}

export type GenomicFeature = {
  id: string
  track_id: string
  assembly: string
  chrom: string
  start: number
  end: number
  label: string
  strand: string | null
  score: number | null
  value: number | null
  source_url: string | null
  attributes: Record<string, unknown>
}

export type AgentAnnotationTrack = {
  track: TrackDefinition
  features: GenomicFeature[]
}

export type TrackCatalog = {
  assembly: string
  source: 'ucsc'
  retrieved_at: string
  total: number
  offset: number
  limit: number
  tracks: TrackDefinition[]
}

export type TrackCatalogQuery = {
  query?: string
  kind?: TrackKind
  limit?: number
  offset?: number
}

export type TrackFeatures = {
  assembly: string
  track_id: string
  chrom: string
  start: number
  end: number
  source: 'ucsc'
  source_data_timestamp: string | null
  retrieved_at: string
  truncated: boolean
  features: GenomicFeature[]
}

export type GeneSearchResult = {
  id: string
  symbol: string
  description: string | null
  assembly: string
  chrom: string
  start: number
  end: number
  source_track: string
}

export type GeneSummary = {
  symbol: string
  full_name: string
  summary: string | null
  aliases: string[]
  chromosome: string | null
  map_location: string | null
  gene_id: string
  nomenclature_status: string | null
  mim_ids: string[]
  exon_count: number | null
  source: 'ncbi_gene'
  source_url: string
  retrieved_at: string
}

export type LiteratureArticle = {
  pmid: string
  title: string
  journal: string | null
  year: number | null
  authors: string[]
  doi: string | null
  pmcid: string | null
  relevance_score: number | null
  source_url: string
}

export type GeneLiterature = {
  symbol: string
  source: 'pubtator3'
  total: number
  articles: LiteratureArticle[]
  retrieved_at: string
}

export type TissueExpression = {
  tissue_id: string
  tissue_name: string
  ontology_id: string | null
  median: number
  unit: string
}

export type GeneExpression = {
  symbol: string
  source: 'gtex'
  dataset_id: string
  gencode_id: string
  tissues: TissueExpression[]
  retrieved_at: string
}

export type AgentGeneLink = {
  id: string
  symbol: string
  name: string | null
  assembly: string
  chrom: string
  start: number
  end: number
  score: number | null
  source_url: string | null
}

export type AgentMetric = {
  label: string
  value: string
  tone: 'neutral' | 'positive' | 'warning'
}

export type AgentSource = {
  label: string
  url: string
}

export type AgentVariant = {
  id: string
  label: string
  assembly: string
  chrom: string
  start: number
  end: number
  ref: string | null
  alt: string | null
  hgvs: string | null
  significance: string | null
  review_status: string | null
  consequence: string | null
  conditions: string[]
  distance: number | null
  source_url: string | null
}

export type AgentFeatureLink = {
  id: string
  label: string
  kind: TrackKind
  assembly: string
  chrom: string
  start: number
  end: number
  category: string | null
  context: string | null
  score: number | null
  value: number | null
  distance: number | null
  source_url: string | null
}

export type AgentRegionLink = Region & {
  id: string
  label: string
  description: string | null
}

export type AgentAction = {
  type: 'focus' | 'add_range' | 'add_track'
  label: string
  region: Region | null
  highlight_region?: Region | null
  track_id: string | null
}

export type AgentResponse = {
  kind: 'disease_genes' | 'region_context' | 'genomic_query' | 'help'
  title: string
  summary: string
  genes: AgentGeneLink[]
  metrics: AgentMetric[]
  sources: AgentSource[]
  variants: AgentVariant[]
  features: AgentFeatureLink[]
  regions: AgentRegionLink[]
  assumptions: { label: string; value: string }[]
  actions: AgentAction[]
  relations: {
    subject_id: string
    predicate: 'overlaps' | 'nearby' | 'derived_from' | 'annotates'
    object_id: string
    source: string
  }[]
  result_complete: boolean
  caveat: string | null
  thread_id: string | null
  backend: 'grounded_rules' | 'anthropic_api'
}

export type AgentRequest = {
  message: string
  assembly: string
  thread_id?: string
  region?: Region
  regions?: Region[]
  feature?: {
    label: string
    track_id: string
    kind: TrackKind
    chrom: string
    start: number
    end: number
  }
}

export type AgentStreamEvent =
  | { type: 'progress'; stage: 'grounding' | 'reasoning'; message: string }
  | { type: 'reasoning_part'; index: number }
  | { type: 'reasoning_delta'; index: number; delta: string }
  | { type: 'answer_delta'; delta: string }
  | { type: 'answer'; data: AgentResponse }
  | { type: 'error'; message: string }

type GeneSearchResponse = {
  query: string
  assembly: string
  source: 'ucsc' | 'mygene'
  results: GeneSearchResult[]
}

type Region = {
  assembly: string
  chrom: string
  start: number
  end: number
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null
    throw new Error(payload?.detail ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}

export function fetchTrackCatalog(
  assembly: string,
  options: TrackCatalogQuery = {},
  signal?: AbortSignal,
): Promise<TrackCatalog> {
  const params = new URLSearchParams({ assembly })
  if (options.query?.trim()) params.set('query', options.query.trim())
  if (options.kind) params.set('kind', options.kind)
  if (options.limit) params.set('limit', String(options.limit))
  if (options.offset) params.set('offset', String(options.offset))
  return getJson(`/api/ucsc/tracks?${params}`, signal)
}

export function fetchTrackFeatures(
  trackId: string,
  region: Region,
  maxItems = 500,
  signal?: AbortSignal,
): Promise<TrackFeatures> {
  const params = new URLSearchParams({
    assembly: region.assembly,
    chrom: region.chrom,
    start: String(region.start),
    end: String(region.end),
    max_items: String(maxItems),
  })
  return getJson(`/api/ucsc/tracks/${encodeURIComponent(trackId)}/features?${params}`, signal)
}

export function searchGenes(
  query: string,
  assembly: string,
  signal?: AbortSignal,
): Promise<GeneSearchResponse> {
  const params = new URLSearchParams({ query, assembly })
  return getJson(`/api/ucsc/genes/search?${params}`, signal)
}

export function fetchGeneSummary(symbol: string, signal?: AbortSignal): Promise<GeneSummary> {
  return getJson(`/api/genes/${encodeURIComponent(symbol)}/summary`, signal)
}

export function fetchGeneLiterature(
  symbol: string,
  signal?: AbortSignal,
): Promise<GeneLiterature> {
  return getJson(`/api/genes/${encodeURIComponent(symbol)}/literature?limit=4`, signal)
}

export function fetchGeneExpression(
  symbol: string,
  signal?: AbortSignal,
): Promise<GeneExpression> {
  return getJson(`/api/genes/${encodeURIComponent(symbol)}/expression`, signal)
}

export async function askEvidenceAgent(
  request: AgentRequest,
  signal?: AbortSignal,
): Promise<AgentResponse> {
  const response = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null
    throw new Error(payload?.detail ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<AgentResponse>
}

export async function streamEvidenceAgent(
  request: AgentRequest,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
): Promise<AgentResponse> {
  const response = await fetch('/api/agent/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null
    throw new Error(payload?.detail ?? `Request failed with status ${response.status}`)
  }
  if (!response.body) throw new Error('The evidence stream was unavailable')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer: AgentResponse | null = null

  function consume(line: string) {
    if (!line.trim()) return
    const event = JSON.parse(line) as AgentStreamEvent
    onEvent(event)
    if (event.type === 'answer') answer = event.data
    if (event.type === 'error') throw new Error(event.message)
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    lines.forEach(consume)
    if (done) break
  }
  consume(buffer)
  if (!answer) throw new Error('The evidence agent completed without an answer')
  return answer
}
