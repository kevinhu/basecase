import { useEffect, useState } from 'react'
import {
  ArrowRight,
  Activity,
  BookOpen,
  CircleGauge,
  Dna,
  ExternalLink,
  Focus,
  Layers3,
  Microscope,
  Sparkles,
} from 'lucide-react'
import type {
  GeneExpression,
  GeneLiterature,
  GeneSummary,
  GenomicFeature,
  TissueExpression,
  TrackDefinition,
  TrackFeatures,
} from '@/lib/api'
import {
  fetchGeneExpression,
  fetchGeneLiterature,
  fetchGeneSummary,
  fetchTrackFeatures,
} from '@/lib/api'
import { formatCoordinate, formatSpan } from '@/lib/genome'
import type { Region } from '@/lib/genome'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type GeneDetailDialogProps = {
  selection: { feature: GenomicFeature; track: TrackDefinition } | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onFocus: (region: Region, highlight?: Region) => void
}

type GeneTab = 'overview' | 'clinical' | 'transcripts' | 'expression' | 'literature' | 'sources'

type GeneLocusEvidence = {
  clinvar: TrackFeatures
  regulatory: TrackFeatures
  conservation: TrackFeatures
}

export function GeneDetailDialog({
  selection,
  open,
  onOpenChange,
  onFocus,
}: GeneDetailDialogProps) {
  const [summary, setSummary] = useState<GeneSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState(false)
  const [literature, setLiterature] = useState<GeneLiterature | null>(null)
  const [literatureLoading, setLiteratureLoading] = useState(false)
  const [literatureError, setLiteratureError] = useState(false)
  const [expression, setExpression] = useState<GeneExpression | null>(null)
  const [expressionLoading, setExpressionLoading] = useState(false)
  const [expressionError, setExpressionError] = useState(false)
  const [activeTab, setActiveTab] = useState<GeneTab>('overview')
  const [locusEvidence, setLocusEvidence] = useState<GeneLocusEvidence | null>(null)
  const [locusEvidenceLoading, setLocusEvidenceLoading] = useState(false)
  const [locusEvidenceError, setLocusEvidenceError] = useState(false)
  const selectedSymbol = selection ? geneSymbol(selection.feature) : null

  useEffect(() => {
    if (open) setActiveTab('overview')
  }, [open, selectedSymbol])

  useEffect(() => {
    if (!open || !selectedSymbol) return
    const controller = new AbortController()
    setSummary(null)
    setSummaryError(false)
    setSummaryLoading(true)
    fetchGeneSummary(selectedSymbol, controller.signal)
      .then(setSummary)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setSummaryError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setSummaryLoading(false)
      })
    return () => controller.abort()
  }, [open, selectedSymbol])

  useEffect(() => {
    if (!open || !selection) return
    const controller = new AbortController()
    const region = geneFocusRegion(selection.feature)
    setLocusEvidence(null)
    setLocusEvidenceError(false)
    setLocusEvidenceLoading(true)
    Promise.all([
      fetchTrackFeatures('clinvarMain', region, 1_000, controller.signal),
      fetchTrackFeatures('cCREregistry', region, 1_000, controller.signal),
      fetchTrackFeatures('phyloP100way', region, 2_000, controller.signal),
    ])
      .then(([clinvar, regulatory, conservation]) => {
        setLocusEvidence({ clinvar, regulatory, conservation })
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setLocusEvidenceError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLocusEvidenceLoading(false)
      })
    return () => controller.abort()
  }, [open, selection])

  useEffect(() => {
    if (!open || !selectedSymbol) return
    const controller = new AbortController()
    setLiterature(null)
    setLiteratureError(false)
    setLiteratureLoading(true)
    fetchGeneLiterature(selectedSymbol, controller.signal)
      .then(setLiterature)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setLiteratureError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLiteratureLoading(false)
      })
    return () => controller.abort()
  }, [open, selectedSymbol])

  useEffect(() => {
    if (!open || !selectedSymbol) return
    const controller = new AbortController()
    setExpression(null)
    setExpressionError(false)
    setExpressionLoading(true)
    fetchGeneExpression(selectedSymbol, controller.signal)
      .then(setExpression)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setExpressionError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setExpressionLoading(false)
      })
    return () => controller.abort()
  }, [open, selectedSymbol])

  if (!selection) return null

  const { feature, track } = selection
  const symbol = geneSymbol(feature)
  const attributes = feature.attributes
  const transcript = cleanIdentifier(feature.id)
  const ensemblGene = identifier(attributes.geneName, 'ENSG')
    ?? identifier(attributes.geneSymbol, 'ENSG')
  const refSeq = optionalText(attributes.ncbiId)
  const protein = optionalText(attributes.ensemblProtAcc)
    ?? optionalText(attributes.ncbiProtAcc)
  const geneType = readable(optionalText(attributes.geneType)
    ?? optionalText(attributes.transcriptType)
    ?? 'gene')
  const maneStatus = optionalText(attributes.maneStat)
  const exonCount = numberValue(attributes.blockCount)
  const codingStart = numberValue(attributes.thickStart)
  const codingEnd = numberValue(attributes.thickEnd)
  const isCoding = codingStart !== null && codingEnd !== null && codingEnd > codingStart
  const span = feature.end - feature.start
  const paddedRegion = geneFocusRegion(feature)
  const links = geneLinks(feature, symbol, transcript, ensemblGene, summary)
  const clinicalCounts = summarizeClinicalEvidence(locusEvidence?.clinvar.features ?? [])
  const regulatoryCounts = summarizeRegulatoryEvidence(locusEvidence?.regulatory.features ?? [])
  const conservationPeak = peakConservation(locusEvidence?.conservation.features ?? [])
  const selectedRecordLabel = maneStatus ? 'MANE transcript' : `${track.label} transcript`
  const tabs: Array<{ id: GeneTab; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'clinical', label: 'Clinical' },
    { id: 'transcripts', label: 'Transcripts' },
    { id: 'expression', label: 'Expression' },
    { id: 'literature', label: 'Literature' },
    { id: 'sources', label: 'Sources' },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gene-detail-dialog">
        <DialogHeader className="gene-detail-header">
          <div className="gene-detail-identity">
            <div className="gene-detail-icon"><Dna /></div>
            <div>
              <div className="gene-detail-title-line">
                <DialogTitle>{symbol}</DialogTitle>
                <Badge variant="secondary">{geneType}</Badge>
                {maneStatus ? <Badge className="gene-mane-badge">{maneStatus}</Badge> : null}
              </div>
              <DialogDescription>
                {feature.chrom}:{formatCoordinate(feature.start)}–{formatCoordinate(feature.end - 1)} · {feature.strand === '-' ? 'reverse' : 'forward'} strand · {feature.assembly}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="gene-detail-body">
          <div className="gene-tabs" role="tablist" aria-label="Gene information">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                id={`gene-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls="gene-tab-panel"
                tabIndex={activeTab === tab.id ? 0 : -1}
                className={activeTab === tab.id ? 'is-active' : undefined}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => {
                  const currentIndex = tabs.findIndex((candidate) => candidate.id === tab.id)
                  const nextIndex = event.key === 'ArrowRight'
                    ? (currentIndex + 1) % tabs.length
                    : event.key === 'ArrowLeft'
                      ? (currentIndex - 1 + tabs.length) % tabs.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : null
                  if (nextIndex === null) return
                  event.preventDefault()
                  setActiveTab(tabs[nextIndex].id)
                  document.getElementById(`gene-tab-${tabs[nextIndex].id}`)?.focus()
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div id="gene-tab-panel" className="gene-tab-panel" role="tabpanel" aria-labelledby={`gene-tab-${activeTab}`}>
            {activeTab === 'overview' ? (
              <>
                <div className="gene-record-context">
                  <span>Selected record</span>
                  <strong>{selectedRecordLabel}</strong>
                  <code>{transcript}</code>
                  <p>Gene-level context below is separated from facts specific to this transcript.</p>
                </div>

                <GeneSummaryPanel
                  symbol={symbol}
                  summary={summary}
                  loading={summaryLoading}
                  error={summaryError}
                />

                <LocusEvidencePanel
                  clinicalCounts={clinicalCounts}
                  regulatoryCounts={regulatoryCounts}
                  conservationPeak={conservationPeak}
                  loading={locusEvidenceLoading}
                  error={locusEvidenceError}
                  truncated={locusEvidence?.clinvar.truncated ?? false}
                  onOpenClinical={() => setActiveTab('clinical')}
                />
              </>
            ) : null}

            {activeTab === 'clinical' ? (
              <div className="gene-tab-stack">
                <section className="gene-detail-section clinical-evidence-section">
                  <div className="gene-section-heading">
                    <CircleGauge />
                    <h3>Clinical variants at this gene</h3>
                    <span>UCSC ClinVar</span>
                  </div>
                  {locusEvidenceLoading ? <InsightSkeleton rows={4} /> : locusEvidenceError ? (
                    <p className="gene-summary-unavailable">Clinical evidence is temporarily unavailable. The selected transcript remains available.</p>
                  ) : (
                    <>
                      <div className="clinical-count-grid">
                        <EvidenceCount label="Pathogenic" value={clinicalCounts.pathogenic} tone="danger" />
                        <EvidenceCount label="Uncertain" value={clinicalCounts.uncertain} tone="warning" />
                        <EvidenceCount label="Conflicting" value={clinicalCounts.conflicting} tone="violet" />
                        <EvidenceCount label="Benign" value={clinicalCounts.benign} tone="success" />
                      </div>
                      <p className="clinical-source-note">
                        {clinicalCounts.total.toLocaleString()} ClinVar records overlap the selected gene window.
                        {locusEvidence?.clinvar.truncated ? ' The source reached its display limit; zoom in for a complete local set.' : ''}
                      </p>
                      <ClinicalVariantList
                        features={locusEvidence?.clinvar.features ?? []}
                        onOpen={(variant) => {
                          onFocus(paddedEvidenceRegion(variant), exactEvidenceRegion(variant))
                          onOpenChange(false)
                        }}
                      />
                    </>
                  )}
                </section>

                <section className="gene-detail-section">
                  <div className="gene-section-heading">
                    <BookOpen />
                    <h3>Disease records</h3>
                    <span>NCBI · OMIM</span>
                  </div>
                  <div className="gene-context-row clinical-record-row">
                    {summary ? <span><b>NCBI Gene</b>{summary.gene_id}</span> : null}
                    {summary?.mim_ids.map((mimId) => (
                      <a key={mimId} href={`https://omim.org/entry/${mimId}`} target="_blank" rel="noreferrer">
                        <b>OMIM</b>{mimId} <ExternalLink />
                      </a>
                    ))}
                  </div>
                  <p className="clinical-source-note">These are source records, not an automated diagnosis or a gene–disease validity assertion.</p>
                </section>
              </div>
            ) : null}

            {activeTab === 'transcripts' ? (
              <div className="gene-tab-stack">
                <section className="gene-overview" aria-label="Selected transcript overview">
                  <div className="gene-summary-grid">
                    <GeneStat label="Selected span" value={formatSpan(span)} />
                    <GeneStat label="Transcript exons" value={exonCount?.toLocaleString() ?? '—'} />
                    <GeneStat label="Transcript" value={transcript} mono />
                    <GeneStat label="Protein" value={protein ?? (isCoding ? 'Coding' : 'Non-coding')} mono={Boolean(protein)} />
                  </div>
                  <TranscriptMap feature={feature} />
                </section>

                <section className="gene-detail-section">
                  <div className="gene-section-heading">
                    <Microscope />
                    <h3>Selected transcript record</h3>
                    <span>{track.label}</span>
                  </div>
                  <dl className="gene-facts">
                    <GeneFact label="Gene symbol" value={symbol} />
                    <GeneFact label="Transcript" value={transcript} mono />
                    <GeneFact label="Ensembl gene" value={ensemblGene ?? '—'} mono />
                    <GeneFact label="RefSeq" value={refSeq ?? '—'} mono />
                    <GeneFact label="Strand" value={feature.strand ?? '—'} />
                    <GeneFact label="Selection status" value={maneStatus ?? 'Track-selected'} />
                    <GeneFact label="Source track" value={track.label} />
                  </dl>
                </section>
              </div>
            ) : null}

            {activeTab === 'expression' ? (
              <ExpressionPanel symbol={symbol} expression={expression} loading={expressionLoading} error={expressionError} />
            ) : null}

            {activeTab === 'literature' ? (
              <LiteraturePanel symbol={symbol} literature={literature} loading={literatureLoading} error={literatureError} />
            ) : null}

            {activeTab === 'sources' ? (
              <div className="gene-detail-columns gene-source-columns">
                <section className="gene-detail-section">
                  <div className="gene-section-heading">
                    <Layers3 />
                    <h3>Evidence provenance</h3>
                  </div>
                  <dl className="gene-facts">
                    <GeneFact label="Gene context" value="NCBI Gene" />
                    <GeneFact label="Transcript" value={`UCSC · ${track.id}`} mono />
                    <GeneFact label="Variants" value="UCSC ClinVar" />
                    <GeneFact label="Regulatory" value="ENCODE4 cCREs" />
                    <GeneFact label="Conservation" value="phyloP 100 vertebrates" />
                    <GeneFact label="Expression" value={expression?.dataset_id ?? 'GTEx'} mono />
                    <GeneFact label="Literature" value="PubTator 3" />
                    <GeneFact label="Transcript version" value={track.data_version ?? 'Live UCSC dataset'} mono />
                    <GeneFact label="Gene retrieved" value={formatRetrieved(summary?.retrieved_at)} />
                    <GeneFact label="ClinVar retrieved" value={formatRetrieved(locusEvidence?.clinvar.retrieved_at)} />
                    <GeneFact label="Expression retrieved" value={formatRetrieved(expression?.retrieved_at)} />
                    <GeneFact label="Literature retrieved" value={formatRetrieved(literature?.retrieved_at)} />
                  </dl>
                </section>

                <section className="gene-detail-section">
                  <div className="gene-section-heading">
                    <BookOpen />
                    <h3>Primary records</h3>
                  </div>
                  <div className="gene-record-links">
                    {links.map((link) => (
                      <a key={link.label} href={link.href} target="_blank" rel="noreferrer">
                        <span>
                          <strong>{link.label}</strong>
                          <small>{link.detail}</small>
                        </span>
                        <ExternalLink />
                      </a>
                    ))}
                  </div>
                </section>
              </div>
            ) : null}
          </div>
        </div>

        <div className="gene-detail-footer">
          <p>Exact record from UCSC <code>{track.id}</code></p>
          <div>
            <Button variant="outline" asChild>
              <a href={ucscUrl(feature)} target="_blank" rel="noreferrer">
                Open in UCSC <ExternalLink data-icon="inline-end" />
              </a>
            </Button>
            <Button
              onClick={() => {
                onFocus(paddedRegion)
                onOpenChange(false)
              }}
            >
              Focus gene <Focus data-icon="inline-end" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function GeneSummaryPanel({
  symbol,
  summary,
  loading,
  error,
}: {
  symbol: string
  summary: GeneSummary | null
  loading: boolean
  error: boolean
}) {
  return (
    <section className="gene-function-section" aria-label={`${symbol} gene summary`}>
      <div className="gene-section-heading">
        <Sparkles />
        <h3>Why this gene matters</h3>
        <span>NCBI Gene</span>
      </div>
      {loading ? (
        <div className="gene-summary-loading" aria-label="Loading gene summary">
          <i />
          <i />
          <i />
        </div>
      ) : summary ? (
        <>
          <strong className="gene-full-name">{summary.full_name}</strong>
          {summary.summary ? <p className="gene-function-copy">{summary.summary}</p> : null}
          <div className="gene-context-row">
            {summary.map_location ? <span><b>Cytoband</b>{summary.map_location}</span> : null}
            <a href={summary.source_url} target="_blank" rel="noreferrer"><b>NCBI Gene</b>{summary.gene_id} <ExternalLink /></a>
            {summary.exon_count ? <span><b>Gene exons</b>{summary.exon_count}</span> : null}
            {summary.mim_ids[0] ? (
              <a href={`https://omim.org/entry/${summary.mim_ids[0]}`} target="_blank" rel="noreferrer">
                <b>OMIM</b>{summary.mim_ids[0]} <ExternalLink />
              </a>
            ) : null}
          </div>
          {summary.aliases.length > 0 ? (
            <div className="gene-aliases">
              <span>Also known as</span>
              <div>{summary.aliases.slice(0, 8).map((alias) => <Badge key={alias} variant="secondary">{alias}</Badge>)}</div>
            </div>
          ) : null}
        </>
      ) : error ? (
        <p className="gene-summary-unavailable">Gene-level context is temporarily unavailable. Transcript details remain exact.</p>
      ) : null}
    </section>
  )
}

function LocusEvidencePanel({
  clinicalCounts,
  regulatoryCounts,
  conservationPeak,
  loading,
  error,
  truncated,
  onOpenClinical,
}: {
  clinicalCounts: ReturnType<typeof summarizeClinicalEvidence>
  regulatoryCounts: ReturnType<typeof summarizeRegulatoryEvidence>
  conservationPeak: number | null
  loading: boolean
  error: boolean
  truncated: boolean
  onOpenClinical: () => void
}) {
  return (
    <section className="locus-evidence-section" aria-label="Evidence at this locus">
      <div className="gene-section-heading">
        <CircleGauge />
        <h3>Evidence at this locus</h3>
        <span>Live tracks</span>
      </div>
      {loading ? <InsightSkeleton rows={3} /> : error ? (
        <p className="gene-summary-unavailable">Locus evidence is temporarily unavailable.</p>
      ) : (
        <div className="locus-evidence-grid">
          <button type="button" onClick={onOpenClinical}>
            <span className="evidence-kicker">ClinVar</span>
            <strong>{clinicalCounts.pathogenic.toLocaleString()}</strong>
            <small>pathogenic records{truncated ? ' in the returned set' : ''}</small>
          </button>
          <div>
            <span className="evidence-kicker">Regulatory</span>
            <strong>{regulatoryCounts.total.toLocaleString()}</strong>
            <small>{regulatoryCounts.promoter} promoter · {regulatoryCounts.enhancer} enhancer</small>
          </div>
          <div>
            <span className="evidence-kicker">Conservation</span>
            <strong>{conservationPeak === null ? '—' : conservationPeak.toFixed(2)}</strong>
            <small>peak phyloP score in the gene window</small>
          </div>
        </div>
      )}
      <p className="locus-evidence-note">Counts are computed from the exact gene window and link back to the active UCSC-backed datasets.</p>
    </section>
  )
}

function EvidenceCount({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'danger' | 'warning' | 'violet' | 'success'
}) {
  return (
    <div className={`evidence-count evidence-count-${tone}`}>
      <strong>{value.toLocaleString()}</strong>
      <span>{label}</span>
    </div>
  )
}

function ClinicalVariantList({ features, onOpen }: {
  features: GenomicFeature[]
  onOpen: (feature: GenomicFeature) => void
}) {
  const records = [...features]
    .sort((left, right) => clinicalPriority(right) - clinicalPriority(left))
    .slice(0, 6)
  if (records.length === 0) return <p className="clinical-source-note">No individual ClinVar records were returned for this window.</p>
  return (
    <div className="clinical-variant-list" aria-label="ClinVar records">
      <div className="gene-section-subheading"><strong>Records to inspect</strong><span>Highest clinical priority first</span></div>
      {records.map((record) => (
        <button type="button" key={`${record.id}-${record.start}-${String(record.attributes.alt ?? '')}`} onClick={() => onOpen(record)}>
          <span>
            <strong>{formatClinicalVariant(record)}</strong>
            <small>{String(record.attributes.clinSign ?? 'Unspecified significance')}</small>
          </span>
          <code>{record.chrom}:{formatCoordinate(record.start + 1)}</code>
          <ArrowRight />
        </button>
      ))}
    </div>
  )
}

function clinicalPriority(feature: GenomicFeature): number {
  const significance = String(feature.attributes.clinSign ?? '').toLowerCase()
  if (significance.includes('pathogenic')) return 4
  if (significance.includes('conflict')) return 3
  if (significance.includes('uncertain')) return 2
  if (significance.includes('benign')) return 1
  return 0
}

function formatClinicalVariant(feature: GenomicFeature): string {
  const ref = optionalText(feature.attributes.ref)
  const alt = optionalText(feature.attributes.alt)
  return ref && alt ? `${feature.chrom}:${formatCoordinate(feature.start + 1)} ${ref}>${alt}` : feature.label
}

function ExpressionPanel({
  symbol,
  expression,
  loading,
  error,
}: {
  symbol: string
  expression: GeneExpression | null
  loading: boolean
  error: boolean
}) {
  const primaryTissues = expression?.tissues.filter(
    (tissue) => !tissue.tissue_id.startsWith('Cells_'),
  ) ?? []
  const tissues = primaryTissues.slice(0, 6)
  const maximum = Math.max(1, ...tissues.map((tissue) => tissue.median))
  const detected = primaryTissues.filter((tissue) => tissue.median >= 1).length

  return (
    <section className="gene-insight-card expression-panel" aria-label={`${symbol} tissue expression`}>
      <div className="gene-section-heading">
        <Activity />
        <h3>Tissue expression</h3>
        <span>GTEx v10</span>
      </div>
      {loading ? <InsightSkeleton rows={6} /> : error ? (
        <p className="gene-summary-unavailable">GTEx expression is temporarily unavailable.</p>
      ) : expression && tissues.length > 0 ? (
        <>
          <p className="expression-summary">
            Detected at ≥1 TPM in <strong>{detected}</strong> of {primaryTissues.length} tissues
          </p>
          <p className="gene-insight-note">Top six tissues by median TPM; open GTEx for the complete tissue set.</p>
          <div className="expression-bars">
            {tissues.map((tissue) => (
              <ExpressionBar key={tissue.tissue_id} tissue={tissue} maximum={maximum} />
            ))}
          </div>
          <a
            className="insight-source-link"
            href={`https://gtexportal.org/home/gene/${encodeURIComponent(expression.gencode_id)}`}
            target="_blank"
            rel="noreferrer"
          >
            Explore all tissues <ExternalLink />
          </a>
        </>
      ) : <p className="gene-summary-unavailable">No GTEx tissue expression was found.</p>}
    </section>
  )
}

function ExpressionBar({ tissue, maximum }: { tissue: TissueExpression; maximum: number }) {
  return (
    <div className="expression-bar">
      <span title={tissue.tissue_name}>{tissue.tissue_name}</span>
      <div><i style={{ width: `${Math.max(2, (tissue.median / maximum) * 100)}%` }} /></div>
      <strong>{formatTpm(tissue.median)}</strong>
    </div>
  )
}

function LiteraturePanel({
  symbol,
  literature,
  loading,
  error,
}: {
  symbol: string
  literature: GeneLiterature | null
  loading: boolean
  error: boolean
}) {
  return (
    <section className="gene-insight-card literature-panel" aria-label={`${symbol} relevant literature`}>
      <div className="gene-section-heading">
        <BookOpen />
        <h3>Relevant literature</h3>
        <span>PubTator 3</span>
      </div>
      {loading ? <InsightSkeleton rows={4} /> : error ? (
        <p className="gene-summary-unavailable">PubTator literature is temporarily unavailable.</p>
      ) : literature?.articles.length ? (
        <>
          <p className="gene-insight-note">Ranked by PubTator entity relevance; this is not a systematic literature review.</p>
          <div className="literature-list">
            {literature.articles.map((article) => (
              <a key={article.pmid} href={article.source_url} target="_blank" rel="noreferrer">
                <strong>{article.title}</strong>
                <span>
                  {article.authors[0] ? `${article.authors[0]}${article.authors.length > 1 ? ' et al.' : ''} · ` : ''}
                  {article.journal ?? 'PubMed'}{article.year ? ` · ${article.year}` : ''}
                  {article.relevance_score !== null ? ` · relevance ${article.relevance_score.toFixed(2)}` : ''}
                </span>
                <ExternalLink />
              </a>
            ))}
          </div>
          <a
            className="insight-source-link"
            href={`https://www.ncbi.nlm.nih.gov/research/pubtator3/?q=${encodeURIComponent(`@GENE_${symbol}`)}`}
            target="_blank"
            rel="noreferrer"
          >
            Search all entity-matched papers <ExternalLink />
          </a>
        </>
      ) : <p className="gene-summary-unavailable">No entity-matched publications were found.</p>}
    </section>
  )
}

function InsightSkeleton({ rows }: { rows: number }) {
  return (
    <div className="insight-skeleton" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => <i key={index} />)}
    </div>
  )
}

function formatTpm(value: number): string {
  if (value >= 10) return value.toFixed(1)
  if (value >= 1) return value.toFixed(2)
  return value.toFixed(3)
}

function GeneStat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <span>{label}</span>
      <strong className={mono ? 'is-mono' : undefined}>{value}</strong>
    </div>
  )
}

function GeneFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? 'is-mono' : undefined}>{value}</dd>
    </div>
  )
}

function TranscriptMap({ feature }: { feature: GenomicFeature }) {
  const blocks = exonBlocks(feature)
  const span = Math.max(1, feature.end - feature.start)
  return (
    <div className="transcript-map" aria-label={`${blocks.length} exon transcript structure`}>
      <div className="transcript-direction">
        <span>5′</span>
        <ArrowRight className={feature.strand === '-' ? 'is-reverse' : undefined} />
        <span>3′</span>
      </div>
      <div className="transcript-line">
        {blocks.map((block, index) => (
          <i
            key={`${block.start}-${index}`}
            style={{
              left: `${((block.start - feature.start) / span) * 100}%`,
              width: `${Math.max(0.7, ((block.end - block.start) / span) * 100)}%`,
            }}
          />
        ))}
      </div>
    </div>
  )
}

function geneSymbol(feature: GenomicFeature): string {
  for (const candidate of [
    feature.attributes.geneSymbol,
    feature.attributes.hgncSymbol,
    feature.attributes.gene_name,
    feature.attributes.geneName,
    feature.attributes.geneName2,
    feature.label,
  ]) {
    const value = optionalText(candidate)
    if (value && value.toLowerCase() !== 'none' && !value.startsWith('ENSG')) return value
  }
  return feature.id
}

function exonBlocks(feature: GenomicFeature): Array<{ start: number; end: number }> {
  const absoluteStarts = String(feature.attributes.exonStarts ?? '').split(',').filter(Boolean).map(Number)
  const absoluteEnds = String(feature.attributes.exonEnds ?? '').split(',').filter(Boolean).map(Number)
  if (absoluteStarts.length > 0) {
    return absoluteStarts.flatMap((start, index) => {
      const end = absoluteEnds[index]
      return Number.isFinite(start) && Number.isFinite(end) ? [{ start, end }] : []
    })
  }
  const sizes = String(feature.attributes.blockSizes ?? '').split(',').filter(Boolean).map(Number)
  const starts = String(feature.attributes.chromStarts ?? '').split(',').filter(Boolean).map(Number)
  return starts.flatMap((offset, index) => {
    const size = sizes[index]
    return Number.isFinite(offset) && Number.isFinite(size)
      ? [{ start: feature.start + offset, end: feature.start + offset + size }]
      : []
  })
}

function geneFocusRegion(feature: GenomicFeature): Region {
  const padding = Math.max(500, Math.round((feature.end - feature.start) * 0.08))
  const start = Math.max(0, feature.start - padding)
  return { assembly: feature.assembly, chrom: feature.chrom, start, end: feature.end + padding }
}

function paddedEvidenceRegion(feature: GenomicFeature): Region {
  return {
    assembly: feature.assembly,
    chrom: feature.chrom,
    start: Math.max(0, feature.start - 500),
    end: Math.max(feature.end, feature.start + 1) + 500,
  }
}

function exactEvidenceRegion(feature: GenomicFeature): Region {
  return {
    assembly: feature.assembly,
    chrom: feature.chrom,
    start: feature.start,
    end: Math.max(feature.end, feature.start + 1),
  }
}

function summarizeClinicalEvidence(features: GenomicFeature[]) {
  const counts = {
    total: features.length,
    pathogenic: 0,
    uncertain: 0,
    conflicting: 0,
    benign: 0,
    other: 0,
  }
  for (const feature of features) {
    const significance = String(feature.attributes.clinSign ?? '').toLowerCase()
    if (significance.includes('pathogenic')) counts.pathogenic += 1
    else if (significance.includes('conflict')) counts.conflicting += 1
    else if (significance.includes('uncertain')) counts.uncertain += 1
    else if (significance.includes('benign')) counts.benign += 1
    else counts.other += 1
  }
  return counts
}

function summarizeRegulatoryEvidence(features: GenomicFeature[]) {
  let promoter = 0
  let enhancer = 0
  for (const feature of features) {
    const category = String(feature.attributes.cCRE_class ?? '').toLowerCase()
    if (category.includes('promoter')) promoter += 1
    if (category.includes('enhancer')) enhancer += 1
  }
  return { total: features.length, promoter, enhancer }
}

function peakConservation(features: GenomicFeature[]): number | null {
  const values = features.flatMap((feature) => feature.value === null ? [] : [feature.value])
  return values.length > 0 ? Math.max(...values) : null
}

function geneLinks(
  feature: GenomicFeature,
  symbol: string,
  transcript: string,
  ensemblGene: string | null,
  summary: GeneSummary | null,
) {
  const ncbiGeneId = summary?.gene_id
    ?? optionalText(feature.attributes.ncbiGene)?.replace(/^GeneID:/, '')
  const links = [
    {
      label: 'Ensembl',
      detail: ensemblGene ?? transcript,
      href: feature.source_url
        ?? `https://www.ensembl.org/Homo_sapiens/Gene/Summary?g=${encodeURIComponent(ensemblGene ?? symbol)}`,
    },
    {
      label: 'NCBI Gene',
      detail: ncbiGeneId ? `Gene ID ${ncbiGeneId}` : symbol,
      href: ncbiGeneId
        ? `https://www.ncbi.nlm.nih.gov/gene/${encodeURIComponent(ncbiGeneId)}`
        : `https://www.ncbi.nlm.nih.gov/gene/?term=${encodeURIComponent(`${symbol}[sym] AND human[orgn]`)}`,
    },
    {
      label: 'ClinVar',
      detail: `Variants in ${symbol}`,
      href: `https://www.ncbi.nlm.nih.gov/clinvar/?term=${encodeURIComponent(`${symbol}[gene]`)}`,
    },
  ]
  if (summary?.mim_ids[0]) {
    links.push({
      label: 'OMIM',
      detail: `Entry ${summary.mim_ids[0]}`,
      href: `https://omim.org/entry/${summary.mim_ids[0]}`,
    })
  }
  return links
}

function ucscUrl(feature: GenomicFeature): string {
  const position = `${feature.chrom}:${feature.start + 1}-${feature.end}`
  return `https://genome.ucsc.edu/cgi-bin/hgTracks?db=${encodeURIComponent(feature.assembly)}&position=${encodeURIComponent(position)}`
}

function identifier(value: unknown, prefix: string): string | null {
  const text = optionalText(value)
  return text?.startsWith(prefix) ? text : null
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  return String(value)
}

function numberValue(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function cleanIdentifier(value: string): string {
  return value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value
}

function readable(value: string): string {
  return value.replaceAll('_', ' ')
}

function formatRetrieved(value: string | undefined): string {
  if (!value) return 'Not loaded in this session'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
