import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Focus,
  Layers3,
  MapPin,
  SquarePen,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { AgentAnnotationTrack, AgentResponse, GenomicFeature, TrackDefinition } from '@/lib/api'
import { streamEvidenceAgent } from '@/lib/api'
import type { Region } from '@/lib/genome'
import { formatCoordinate, formatRegion as formatGenomeRegion, formatSpan } from '@/lib/genome'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

type EvidenceSelection = {
  feature: GenomicFeature
  track: TrackDefinition
}

type Message =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'agent'; response: AgentResponse; reasoning: string[] }
  | { id: number; role: 'error'; text: string; retryText: string }

type EvidenceAgentProps = {
  region: Region
  selectedRegions: Region[]
  selection: EvidenceSelection | null
  onNavigate: (region: Region, highlight?: Region) => void
  onAddTrack: (trackId: string) => void
  onAddAnnotationTrack: (annotation: AgentAnnotationTrack) => void
  onClearFeature: () => void
  onRemoveRegion: (index: number) => void
  onClearRegions: () => void
}

const DISEASE_EXAMPLE = 'Genes related to hypertrophic cardiomyopathy'

export function EvidenceAgent({
  region,
  selectedRegions,
  selection,
  onNavigate,
  onAddTrack,
  onAddAnnotationTrack,
  onClearFeature,
  onRemoveRegion,
  onClearRegions,
}: EvidenceAgentProps) {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [processSteps, setProcessSteps] = useState<string[]>([])
  const [reasoningSections, setReasoningSections] = useState<string[]>([])
  const [draftText, setDraftText] = useState('')
  const reasoningRef = useRef<string[]>([])
  const draftRef = useRef('')
  const followOutput = useRef(true)
  const nextId = useRef(1)
  const scrollArea = useRef<HTMLDivElement | null>(null)
  const controller = useRef<AbortController | null>(null)
  const contextRegions = selectedRegions.length > 0 ? selectedRegions : [region]
  const contextRegion = contextRegions[0]
  const selectionCount = selectedRegions.length

  useEffect(() => {
    if (followOutput.current && loading) {
      scrollArea.current?.scrollTo({ top: scrollArea.current.scrollHeight })
    }
  }, [draftText, loading, messages, processSteps, reasoningSections])

  useEffect(() => () => controller.current?.abort(), [])

  function startNewThread() {
    controller.current?.abort()
    controller.current = null
    setInput('')
    setMessages([])
    setThreadId(null)
    setLoading(false)
    setProcessSteps([])
    setReasoningSections([])
    setDraftText('')
    reasoningRef.current = []
    draftRef.current = ''
    followOutput.current = true
    nextId.current = 1
  }

  async function submit(message: string) {
    const text = message.trim()
    if (!text || loading) return
    followOutput.current = true
    const id = nextId.current++
    setMessages((current) => [...current, { id, role: 'user', text }])
    setInput('')
    setLoading(true)
    setProcessSteps([])
    setReasoningSections([])
    setDraftText('')
    reasoningRef.current = []
    draftRef.current = ''
    controller.current?.abort()
    const requestController = new AbortController()
    controller.current = requestController
    try {
      const response = await streamEvidenceAgent(
        {
          message: text,
          assembly: region.assembly,
          thread_id: threadId ?? undefined,
          region: contextRegion,
          regions: contextRegions,
          feature: selection
            ? {
                label: selection.feature.label,
                track_id: selection.track.id,
                kind: selection.track.kind,
                chrom: selection.feature.chrom,
                start: selection.feature.start,
                end: selection.feature.end,
              }
            : undefined,
        },
        (event) => {
          if (event.type === 'progress') {
            setProcessSteps((current) => current.at(-1) === event.message
              ? current
              : [...current, event.message].slice(-6))
          } else if (event.type === 'reasoning_part') {
            const next = [...reasoningRef.current]
            next[event.index] ??= ''
            reasoningRef.current = next
            setReasoningSections(next)
          } else if (event.type === 'reasoning_delta') {
            const next = [...reasoningRef.current]
            next[event.index] = `${next[event.index] ?? ''}${event.delta}`
            reasoningRef.current = next
            setReasoningSections(next)
          } else if (event.type === 'answer_delta') {
            draftRef.current += event.delta
            setDraftText(draftRef.current)
          }
        },
        requestController.signal,
      )
      setThreadId(response.thread_id)
      const finalReasoning = [...reasoningRef.current]
        .filter((section) => section.trim())
      setMessages((current) => [
        ...current,
        {
          id: nextId.current++,
          role: 'agent',
          response,
          reasoning: finalReasoning,
        },
      ])
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const thread = scrollArea.current
          const answer = thread?.querySelector<HTMLElement>('.agent-answer:last-of-type')
          if (thread && answer) {
            const target = thread.scrollTop
              + answer.getBoundingClientRect().top
              - thread.getBoundingClientRect().top
              - 14
            thread.scrollTo({ top: Math.max(0, target) })
          }
        })
      })
      setProcessSteps([])
      setReasoningSections([])
      setDraftText('')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setMessages((current) => [
        ...current,
        {
          id: nextId.current++,
          role: 'error',
          text: error instanceof Error ? error.message : 'The evidence agent could not respond.',
          retryText: text,
        },
      ])
    } finally {
      if (controller.current === requestController) {
        controller.current = null
        setLoading(false)
      }
    }
  }

  return (
    <aside className="agent-panel" aria-label="Evidence agent">
      <div className="agent-context-bar">
        <span className="agent-context-icon"><MapPin /></span>
        <div className="agent-context-copy">
          <span>Question context</span>
          <div className="agent-context-chips">
            {selection ? (
              <button type="button" onClick={onClearFeature} aria-label={`Remove ${selection.feature.label} from context`}>
                <strong>{selection.feature.label}</strong>
                <code>{formatFeatureRange(selection.feature)}</code>
                <X />
              </button>
            ) : null}
            {selectedRegions.length > 0 ? selectedRegions.map((selectedRegion, index) => (
              <button type="button" key={`${selectedRegion.chrom}-${selectedRegion.start}-${selectedRegion.end}-${index}`} onClick={() => onRemoveRegion(index)} aria-label={`Remove range ${formatRegion(selectedRegion)} from context`}>
                <strong>Range {index + 1}</strong>
                <code>{formatRegion(selectedRegion)}</code>
                <X />
              </button>
            )) : (
              <span className="agent-viewport-context">
                <strong>Viewport</strong>
                <code>{formatRegion(region)}</code>
              </span>
            )}
          </div>
        </div>
        <Button
          className="agent-new-thread"
          type="button"
          size="xs"
          variant="ghost"
          onClick={startNewThread}
          disabled={messages.length === 0 && !loading}
          title="Start a new thread"
        >
          <SquarePen />
          <span>New thread</span>
        </Button>
        {selectionCount > 1 ? (
          <Button size="icon-xs" variant="ghost" onClick={onClearRegions} aria-label="Clear selected regions">
            <X />
          </Button>
        ) : null}
      </div>

      <div
        ref={scrollArea}
        className="agent-thread"
        onScroll={(event) => {
          const element = event.currentTarget
          followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72
        }}
      >
        {messages.length === 0 ? (
          <AgentWelcome
            selectionCount={selectionCount}
            onPrompt={(prompt) => void submit(prompt)}
          />
        ) : null}
        {messages.map((message) => {
          if (message.role === 'user') {
            return <div key={message.id} className="agent-user-message">{message.text}</div>
          }
          if (message.role === 'error') {
            return (
              <div key={message.id} className="agent-error-message">
                <CircleAlert />
                <span><strong>Response failed</strong>{message.text}</span>
                <Button type="button" size="xs" variant="outline" onClick={() => void submit(message.retryText)}>Retry</Button>
              </div>
            )
          }
          return (
            <AgentAnswer
              key={message.id}
              response={message.response}
              reasoning={message.reasoning}
              onNavigate={onNavigate}
              onAddTrack={onAddTrack}
              onAddAnnotationTrack={onAddAnnotationTrack}
            />
          )
        })}
        {loading ? (
          <AgentProcess steps={processSteps} reasoning={reasoningSections} draft={draftText} />
        ) : null}
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {loading ? processSteps.at(-1) ?? 'Starting the evidence review' : messages.at(-1)?.role === 'agent' ? 'Answer ready' : ''}
        </div>
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          void submit(input)
        }}
      >
        <label className="composer-label" htmlFor="message">Ask about a disease, gene, or range</label>
        <div className="composer-field">
          <Textarea
            id="message"
            name="message"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              void submit(input)
            }}
            placeholder={selectionCount > 1 ? 'Compare these selected regions' : selectionCount === 1 ? 'What is the context for this region?' : 'Which genes are related to this disease?'}
            autoComplete="off"
            disabled={loading}
          />
          <Button type="submit" size="icon-sm" aria-label="Send message" disabled={!input.trim() || loading}>
            <ArrowUp />
          </Button>
        </div>
        <div className="composer-footer">
          <span>Enter to send · Shift Enter for a new line</span>
          <span>Research use only</span>
        </div>
      </form>
    </aside>
  )
}

function AgentWelcome({ selectionCount, onPrompt }: {
  selectionCount: number
  onPrompt: (prompt: string) => void
}) {
  return (
    <section className="agent-welcome">
      <span className="agent-welcome-kicker">Evidence assistant</span>
      <h2>Ask a focused question</h2>
      <p>
        Answers use the ranges in view and link back to the underlying genomic evidence.
      </p>
      <div className="agent-suggestions">
        {selectionCount > 0 ? (
          <button type="button" onClick={() => onPrompt(selectionCount > 1 ? 'Compare the selected regions' : 'Summarize the selected region')}>
            <i aria-hidden="true" />
            <span>
              <strong>{selectionCount > 1 ? 'Compare selected regions' : 'Summarize selected region'}</strong>
              <small>{selectionCount > 1 ? 'Find shared and distinct evidence' : 'Review genes, variants, and regulation'}</small>
            </span>
            <ChevronRight />
          </button>
        ) : null}
        <button type="button" onClick={() => onPrompt(DISEASE_EXAMPLE)}>
          <i aria-hidden="true" />
          <span>
            <strong>Find disease-associated genes</strong>
            <small>Ranked targets with linked loci</small>
          </span>
          <ChevronRight />
        </button>
        <button type="button" onClick={() => onPrompt('What is the context for this locus?')}>
          <i aria-hidden="true" />
          <span>
            <strong>Summarize this viewport</strong>
            <small>Explain what stands out here</small>
          </span>
          <ChevronRight />
        </button>
      </div>
      <div className="agent-selection-tip">
        <span>Need a narrower answer?</span>
        Drag across the ruler to attach one or more ranges.
      </div>
    </section>
  )
}

function AgentProcess({ steps, reasoning, draft }: {
  steps: string[]
  reasoning: string[]
  draft: string
}) {
  const visibleReasoning = reasoning.filter((section) => section.trim())
  return (
    <section className="agent-process" aria-label="Agent progress">
      <div className="agent-process-title">
        <span className="agent-avatar"><Sparkles /></span>
        <span className="agent-process-identity">
          <strong>Claude</strong>
          <small>Working</small>
        </span>
        <span className="agent-live-status"><i />Live</span>
      </div>
      {steps.length ? (
        <ol>
          {steps.map((step, index) => (
            <li key={`${index}-${step}`} data-current={index === steps.length - 1}>
              <span>{index === steps.length - 1 ? <i className="agent-stream-cursor" /> : <Check />}</span>
              {step}
            </li>
          ))}
        </ol>
      ) : <p className="agent-stream-starting">Starting the evidence review…</p>}
      {visibleReasoning.length ? (
        <div className="agent-live-reasoning">
          <span>Reasoning summary</span>
          {visibleReasoning.map((section, index) => <p key={index}>{section}</p>)}
        </div>
      ) : null}
      {draft ? (
        <div className="agent-live-draft">
          <span>Drafting answer</span>
          <p>{draft}<i className="agent-text-cursor" aria-hidden="true" /></p>
        </div>
      ) : null}
    </section>
  )
}

function AgentAnswer({ response, reasoning, onNavigate, onAddTrack, onAddAnnotationTrack }: {
  response: AgentResponse
  reasoning: string[]
  onNavigate: (region: Region, highlight?: Region) => void
  onAddTrack: (trackId: string) => void
  onAddAnnotationTrack: (annotation: AgentAnnotationTrack) => void
}) {
  const [annotationAdded, setAnnotationAdded] = useState(false)
  const primaryFeatures = response.features.slice(0, 8)
  const remainingFeatures = response.features.slice(8)
  const primaryVariants = response.variants.slice(0, 8)
  const remainingVariants = response.variants.slice(8)
  const genesArePrimary = response.kind === 'disease_genes'
  const navigationActions = response.actions.filter((action) => action.type !== 'add_track' && action.region)
  const trackActions = response.actions.filter((action) => action.type === 'add_track' && action.track_id)
  const anchorAction = navigationActions.find((action) => action.highlight_region && action.region && (
    action.highlight_region.start !== action.region.start
    || action.highlight_region.end !== action.region.end
  ))
  const hasEvidence = Boolean(
    response.variants.length
    || response.features.length
    || response.genes.length
    || response.regions.length
    || response.sources.length
    || response.metrics.length
    || response.assumptions.length
    || response.caveat,
  )
  const evidenceSummary = [
    response.variants.length ? `${response.variants.length}${response.result_complete ? '' : '+'} ${response.variants.length === 1 ? 'variant' : 'variants'}` : '',
    response.features.length ? `${response.features.length} ${response.features.length === 1 ? 'feature' : 'features'}` : '',
    response.genes.length ? `${response.genes.length} ${response.genes.length === 1 ? 'gene' : 'genes'}` : '',
  ].filter(Boolean).join(' · ') || `${response.sources.length} sources`

  return (
    <article className="agent-answer">
      <div className="agent-answer-heading">
        <span className="agent-avatar"><Sparkles /></span>
        <span className="agent-answer-identity">
          <strong>Claude</strong>
          <small>Anthropic agent</small>
        </span>
      </div>

      <h2 className="agent-answer-title">{response.title}</h2>

      {reasoning.length ? (
        <section className="agent-reasoning-preface" aria-label="Reasoning summary">
          <span>Reasoning summary</span>
          <div>
            {reasoning.map((section, index) => <p key={index}>{section}</p>)}
          </div>
        </section>
      ) : null}

      {anchorAction?.region && anchorAction.highlight_region ? (
        <button
          type="button"
          className="agent-query-anchor"
          onClick={() => onNavigate(anchorAction.region!, anchorAction.highlight_region!)}
        >
          <MapPin />
          <span>
            <small>Query anchor</small>
            <strong>{formatRegion(anchorAction.highlight_region)}</strong>
            <span>Open in {formatSpan(anchorAction.region.end - anchorAction.region.start)} of surrounding context</span>
          </span>
          <ChevronRight />
        </button>
      ) : null}

      <div className="agent-response-copy">
        <p className="agent-answer-summary">{response.summary}</p>
      </div>

      {navigationActions.length ? (
        <div className="agent-answer-actions">
          {navigationActions.map((action, index) => (
            <Button
              type="button"
              size="xs"
              variant={index === 0 ? 'default' : 'outline'}
              key={`${action.type}-${action.label}`}
              onClick={() => {
                if ((action.type === 'focus' || action.type === 'add_range') && action.region) {
                  onNavigate(action.region, action.highlight_region ?? action.region)
                }
              }}
            >
              <Focus />
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}

      {trackActions.length ? (
        <details className="agent-track-actions">
          <summary><Layers3 /><span>Show evidence tracks</span><small>{trackActions.length}</small><ChevronDown /></summary>
          <div>
            {trackActions.map((action) => (
              <Button type="button" size="xs" variant="outline" key={`${action.type}-${action.label}`} onClick={() => onAddTrack(action.track_id!)}>
                <Layers3 />{action.label}
              </Button>
            ))}
          </div>
        </details>
      ) : null}

      {response.genes.length || response.variants.length || response.features.length ? (
        <div className="agent-annotation-action">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={annotationAdded}
            onClick={() => {
              onAddAnnotationTrack(buildAnnotationTrack(response))
              setAnnotationAdded(true)
            }}
          >
            {annotationAdded ? <Check /> : <Layers3 />}
            {annotationAdded ? 'Added to browser' : 'Add annotations as track'}
          </Button>
          <span>{response.genes.length + response.variants.length + response.features.length} grounded items</span>
        </div>
      ) : null}

      {genesArePrimary && response.genes.length ? (
        <AgentGeneList
          className="agent-key-genes"
          genes={response.genes.slice(0, 5)}
          label="Top gene loci"
          meta="Select to open"
          onNavigate={onNavigate}
        />
      ) : null}

      {hasEvidence ? (
        <details className="agent-results-disclosure">
          <summary>
            <span>
              <strong>Explore evidence</strong>
              <small>{evidenceSummary}</small>
            </span>
            <ChevronDown />
          </summary>
          <div className="agent-results-body">
      {response.variants.length ? (
        <section className="agent-result-section">
          <div className="agent-section-label">
            <span>Matching variants</span>
            <span>{response.variants.length}{response.result_complete ? '' : '+'}</span>
          </div>
          <div className="agent-variant-table" role="table" aria-label="Matching variants">
            <AgentVariantRows variants={primaryVariants} onNavigate={onNavigate} />
          </div>
          {remainingVariants.length ? (
            <details className="agent-more-results">
              <summary>
                <span>Show {remainingVariants.length} more variants</span>
                <ChevronDown />
              </summary>
              <div className="agent-variant-table" role="table" aria-label="Additional matching variants">
                <AgentVariantRows variants={remainingVariants} onNavigate={onNavigate} />
              </div>
            </details>
          ) : null}
        </section>
      ) : null}

      {response.features.length ? (
        <section className="agent-result-section">
          <div className="agent-section-label">
            <span>Evidence features</span>
            <span>{response.features.length}</span>
          </div>
          <div className="agent-feature-list">
            <AgentFeatureRows features={primaryFeatures} onNavigate={onNavigate} />
          </div>
          {remainingFeatures.length ? (
            <details className="agent-more-results">
              <summary>
                <span>Show {remainingFeatures.length} more features</span>
                <ChevronDown />
              </summary>
              <div className="agent-feature-list">
                <AgentFeatureRows features={remainingFeatures} onNavigate={onNavigate} />
              </div>
            </details>
          ) : null}
        </section>
      ) : null}

      {genesArePrimary && response.genes.length > 5 ? (
        <AgentGeneList
          genes={response.genes.slice(5)}
          label="More genes"
          meta={`${response.genes.length - 5} additional`}
          rankOffset={5}
          onNavigate={onNavigate}
        />
      ) : null}

      <details className="agent-evidence-details">
        <summary>
          <span>Methods &amp; sources</span>
          <small>{response.sources.length} sources · {response.metrics.length} measures</small>
          <ChevronDown />
        </summary>
        <div>
          {!response.result_complete ? (
            <div className="agent-incomplete-note">
              <TriangleAlert />
              <span>This result includes source or context limitations.</span>
            </div>
          ) : null}

          {response.assumptions.length ? (
            <section className="agent-assumptions" aria-label="Analysis assumptions">
              {response.assumptions.map((assumption) => (
                <div key={`${assumption.label}-${assumption.value}`}>
                  <span>{assumption.label}</span>
                  <strong>{assumption.value}</strong>
                </div>
              ))}
            </section>
          ) : null}

          {response.metrics.length ? (
            <dl className="agent-metrics">
              {response.metrics.map((metric) => (
                <div key={metric.label} data-tone={metric.tone}>
                  <dt>{metric.label}</dt>
                  <dd>{metric.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {response.regions.length ? (
            <section className="agent-region-list">
              <div className="agent-section-label"><span>Analysis ranges</span></div>
              {response.regions.map((resultRegion) => (
                <button
                  type="button"
                  key={resultRegion.id}
                  onClick={() => onNavigate(resultRegion, resultRegion)}
                >
                  <Focus />
                  <span>
                    <strong>{resultRegion.label}</strong>
                    <small>{resultRegion.description}</small>
                    <code>{formatFeatureRange(resultRegion)}</code>
                  </span>
                  <ChevronRight />
                </button>
              ))}
            </section>
          ) : null}

          {!genesArePrimary && response.genes.length ? (
            <AgentGeneList genes={response.genes} onNavigate={onNavigate} />
          ) : null}

          {response.sources.length ? (
            <div className="agent-sources">
              <span>Sources</span>
              {response.sources.map((source, index) => (
                <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer">
                  {source.label}<ExternalLink />
                </a>
              ))}
            </div>
          ) : null}
          {response.caveat ? <p className="agent-caveat">{response.caveat}</p> : null}
        </div>
      </details>
          </div>
        </details>
      ) : null}
    </article>
  )
}

function AgentVariantRows({ variants, onNavigate }: {
  variants: AgentResponse['variants']
  onNavigate: (region: Region, highlight?: Region) => void
}) {
  return variants.map((variant, index) => (
    <button
      type="button"
      role="row"
      key={`${variant.id}-${variant.start}-${variant.ref ?? ''}-${variant.alt ?? ''}-${index}`}
      onClick={() => onNavigate(
        paddedFeatureRegion(variant, 500),
        exactFeatureRegion(variant),
      )}
    >
      <span className="agent-result-primary">
        <strong>{formatVariantIdentity(variant)}</strong>
        <code>{variant.label}{variant.label.includes(':') ? '' : ` · ${formatFeatureRange(variant)}`}</code>
        {variant.hgvs ? <small>{variant.hgvs}</small> : null}
      </span>
      <span className="agent-result-detail">
        <strong>{variant.significance ?? 'Unspecified'}</strong>
        <small>{variant.consequence ?? variant.review_status ?? 'ClinVar record'}</small>
      </span>
      <ChevronRight />
    </button>
  ))
}

function AgentFeatureRows({ features, onNavigate }: {
  features: AgentResponse['features']
  onNavigate: (region: Region, highlight?: Region) => void
}) {
  return features.map((feature, index) => (
    <button
      type="button"
      key={`${feature.kind}-${feature.id}-${feature.start}-${feature.end}-${index}`}
      onClick={() => onNavigate(
        paddedFeatureRegion(feature, 2_000),
        exactFeatureRegion(feature),
      )}
    >
      <span data-kind={feature.kind}>{feature.kind}</span>
      <span>
        <strong>{feature.label}</strong>
        <small>
          {[feature.category, feature.context, feature.distance !== null ? formatDistance(feature.distance) : null]
            .filter(Boolean)
            .join(' · ')}
        </small>
        <code>{formatFeatureRange(feature)}</code>
      </span>
      <ChevronRight />
    </button>
  ))
}

function AgentGeneList({
  genes,
  onNavigate,
  className = '',
  label = 'Linked ranges',
  meta = `${genes.length} genes`,
  rankOffset = 0,
}: {
  genes: AgentResponse['genes']
  onNavigate: (region: Region, highlight?: Region) => void
  className?: string
  label?: string
  meta?: string
  rankOffset?: number
}) {
  return (
    <section className={`agent-gene-list ${className}`.trim()}>
      <div className="agent-section-label">
        <span>{label}</span>
        <span>{meta}</span>
      </div>
      {genes.map((gene, index) => (
        <button
          type="button"
          key={`${gene.id}-${gene.chrom}-${gene.start}-${gene.end}-${index}`}
          onClick={() => onNavigate(paddedGeneRegion(gene), exactFeatureRegion(gene))}
          aria-label={`Open ${gene.symbol} at ${formatGeneRange(gene)}`}
        >
          <span className="agent-gene-rank">{rankOffset + index + 1}</span>
          <span className="agent-gene-copy">
            <strong>{gene.symbol}</strong>
            <span>{gene.name ?? formatGeneRange(gene)}</span>
            <code>{formatGeneRange(gene)}</code>
          </span>
          {gene.score !== null ? (
            <span className="agent-gene-score">{Math.round(gene.score * 100)}</span>
          ) : null}
          <ChevronRight />
        </button>
      ))}
    </section>
  )
}

function paddedGeneRegion(gene: AgentResponse['genes'][number]): Region {
  const span = Math.max(1, gene.end - gene.start)
  const padding = Math.max(5_000, Math.round(span * 0.15))
  return {
    assembly: gene.assembly,
    chrom: gene.chrom,
    start: Math.max(0, gene.start - padding),
    end: gene.end + padding,
  }
}

function buildAnnotationTrack(response: AgentResponse): AgentAnnotationTrack {
  const trackId = `agent-${crypto.randomUUID()}`
  const assembly = response.genes[0]?.assembly
    ?? response.variants[0]?.assembly
    ?? response.features[0]?.assembly
    ?? 'hg38'
  const subject = response.title
    .replace(/^Genes associated with\s+/i, '')
    .replace(/^Evidence (?:for|around)\s+/i, '')
  const trackKind = response.genes.length > 0 && response.variants.length === 0 && response.features.length === 0
    ? 'gene'
    : response.variants.length > 0 && response.genes.length === 0 && response.features.length === 0
      ? 'variant'
      : 'feature'

  const candidates: GenomicFeature[] = [
    ...response.genes.map((gene) => ({
      id: `${trackId}:gene:${gene.id}`,
      track_id: trackId,
      assembly: gene.assembly,
      chrom: gene.chrom,
      start: gene.start,
      end: gene.end,
      label: gene.symbol,
      strand: null,
      score: gene.score,
      value: null,
      source_url: gene.source_url,
      attributes: { annotation_kind: 'gene', name: gene.name },
    })),
    ...response.variants.map((variant) => ({
      id: `${trackId}:variant:${variant.id}`,
      track_id: trackId,
      assembly: variant.assembly,
      chrom: variant.chrom,
      start: variant.start,
      end: Math.max(variant.start + 1, variant.end),
      label: variant.label,
      strand: null,
      score: null,
      value: null,
      source_url: variant.source_url,
      attributes: {
        annotation_kind: 'variant',
        significance: variant.significance,
        review_status: variant.review_status,
        consequence: variant.consequence,
        hgvs: variant.hgvs,
        ref: variant.ref,
        alt: variant.alt,
        conditions: variant.conditions,
      },
    })),
    ...response.features.map((feature) => ({
      id: `${trackId}:feature:${feature.id}`,
      track_id: trackId,
      assembly: feature.assembly,
      chrom: feature.chrom,
      start: feature.start,
      end: Math.max(feature.start + 1, feature.end),
      label: feature.label,
      strand: null,
      score: feature.score,
      value: feature.value,
      source_url: feature.source_url,
      attributes: {
        annotation_kind: feature.kind,
        category: feature.category,
        context: feature.context,
        distance: feature.distance,
      },
    })),
  ]
  const seen = new Set<string>()
  const features = candidates.filter((feature) => {
    const key = `${feature.assembly}:${feature.chrom}:${feature.start}:${feature.end}:${feature.label}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return {
    track: {
      id: trackId,
      assembly,
      label: `Agent · ${subject}`,
      description: `Grounded annotations created from the agent response “${response.title}”.`,
      category: 'Agent annotations',
      kind: trackKind,
      source_type: 'agent_annotation',
      source_url: null,
      data_version: null,
      default_visible: false,
      default_rank: null,
    },
    features,
  }
}

function formatRegion(region: Region): string {
  return `${formatGenomeRegion(region).replace('-', '–')} · ${formatSpan(region.end - region.start)}`
}

function formatGeneRange(gene: AgentResponse['genes'][number]): string {
  return `${gene.chrom}:${formatCoordinate(gene.start)}–${formatCoordinate(gene.end - 1)}`
}

function formatFeatureRange(feature: { chrom: string; start: number; end: number }): string {
  return `${feature.chrom}:${formatCoordinate(feature.start + 1)}–${formatCoordinate(feature.end)}`
}

function formatVariantIdentity(variant: AgentResponse['variants'][number]): string {
  const coordinate = `${variant.chrom}:${formatCoordinate(variant.start + 1)}`
  return variant.ref && variant.alt ? `${coordinate} ${variant.ref}>${variant.alt}` : variant.label
}

function paddedFeatureRegion(
  feature: { assembly: string; chrom: string; start: number; end: number },
  padding: number,
): Region {
  return {
    assembly: feature.assembly,
    chrom: feature.chrom,
    start: Math.max(0, feature.start - padding),
    end: feature.end + padding,
  }
}

function exactFeatureRegion(
  feature: { assembly: string; chrom: string; start: number; end: number },
): Region {
  return {
    assembly: feature.assembly,
    chrom: feature.chrom,
    start: feature.start,
    end: feature.end,
  }
}

function formatDistance(distance: number): string {
  if (distance === 0) return 'overlaps anchor'
  return `${formatSpan(distance)} away`
}
