import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Check, Copy, ExternalLink, MoreHorizontal, Trash2 } from 'lucide-react'
import type { GenomicFeature, TrackDefinition, TrackFeatures } from '@/lib/api'
import { fetchTrackFeatures } from '@/lib/api'
import type { Region } from '@/lib/genome'
import { bufferCoversViewport, bufferRegion, formatCoordinate, formatSpan } from '@/lib/genome'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

const VIEWBOX_WIDTH = 1000
const HIDE_WHEN_EMPTY_TRACK_IDS = new Set([
  'altSeqLiftOverPsl',
  'fixSeqLiftOverPsl',
  'comments',
])

type GenomeTrackProps = {
  track: TrackDefinition
  region: Region
  annotationFeatures?: GenomicFeature[]
  onRemove: () => void
  onSelect: (feature: GenomicFeature, track: TrackDefinition) => void
  onLoadingChange: (trackId: string, loading: boolean) => void
}

export function GenomeTrack({
  track,
  region,
  annotationFeatures,
  onRemove,
  onSelect,
  onLoadingChange,
}: GenomeTrackProps) {
  const [data, setData] = useState<TrackFeatures | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)
  const [copiedTrackId, setCopiedTrackId] = useState(false)
  const [hoveredFeature, setHoveredFeature] = useState<GenomicFeature | null>(null)
  const hoverCard = useRef<HTMLDivElement | null>(null)
  const hoverPosition = useRef({ x: 0, y: 0 })
  const pendingRegion = useRef<Region | null>(null)
  const requestController = useRef<AbortController | null>(null)
  const threshold = track.kind === 'signal'
    ? 100_000
    : track.id === 'gnomadV4'
      ? 250_000
      : 5_000_000
  const maxItems = track.kind === 'signal'
    ? 100_000
    : track.id === 'gnomadV4'
      ? 1_000
      : track.id === 'clinvarMain'
        ? 1_000
        : track.id === 'sequenceContext'
          ? 3000
    : track.kind === 'variant' || track.kind === 'regulatory'
      ? 1000
      : 500
  const span = region.end - region.start
  const paused = annotationFeatures === undefined && span > threshold

  useEffect(() => {
    if (annotationFeatures !== undefined) {
      if (data?.features === annotationFeatures) {
        onLoadingChange(track.id, false)
        return
      }
      requestController.current?.abort()
      requestController.current = null
      pendingRegion.current = null
      setError(null)
      setLoading(false)
      setData({
        assembly: region.assembly,
        track_id: track.id,
        chrom: region.chrom,
        start: region.start,
        end: region.end,
        source: 'ucsc',
        source_data_timestamp: null,
        retrieved_at: new Date().toISOString(),
        truncated: false,
        features: annotationFeatures,
      })
      onLoadingChange(track.id, false)
      return
    }

    if (paused) {
      requestController.current?.abort()
      requestController.current = null
      pendingRegion.current = null
      setError(null)
      setLoading(false)
      onLoadingChange(track.id, false)
      return
    }

    if (data && bufferCoversViewport(data, region)) return
    if (pendingRegion.current && bufferCoversViewport(pendingRegion.current, region)) return

    requestController.current?.abort()
    const controller = new AbortController()
    const factor = track.kind === 'gene' || track.kind === 'feature'
      ? 3
      : 1
    const requestRegion = bufferRegion(region, factor)
    requestController.current = controller
    pendingRegion.current = requestRegion
    setError(null)
    setLoading(true)
    onLoadingChange(track.id, true)
    fetchTrackFeatures(track.id, requestRegion, maxItems, controller.signal)
      .then(setData)
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return
        setError(requestError instanceof Error ? requestError.message : 'Track failed to load')
      })
      .finally(() => {
        if (requestController.current !== controller) return
        requestController.current = null
        pendingRegion.current = null
        setLoading(false)
        onLoadingChange(track.id, false)
      })
  }, [annotationFeatures, data, maxItems, onLoadingChange, paused, region, retryNonce, track.id, track.kind])

  useEffect(
    () => () => {
      requestController.current?.abort()
      requestController.current = null
      pendingRegion.current = null
      onLoadingChange(track.id, false)
    },
    [onLoadingChange, track.id],
  )

  function positionHoverCard(clientX: number, clientY: number) {
    const cardWidth = 280
    const cardHeight = 180
    const x = Math.max(12, Math.min(clientX + 14, window.innerWidth - cardWidth - 12))
    const y = clientY + cardHeight + 24 > window.innerHeight
      ? Math.max(12, clientY - cardHeight - 12)
      : clientY + 14
    hoverPosition.current = { x, y }
    if (hoverCard.current) {
      hoverCard.current.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }
  }

  function showFeatureTooltip(feature: GenomicFeature, clientX: number, clientY: number) {
    positionHoverCard(clientX, clientY)
    setHoveredFeature(feature)
  }

  const visibleFeatureCount = data?.features.filter(
    (feature) => feature.end > region.start && feature.start < region.end,
  ).length ?? 0
  if (data && !loading && HIDE_WHEN_EMPTY_TRACK_IDS.has(track.id) && visibleFeatureCount === 0) {
    return null
  }

  return (
    <section
      className={`genome-track genome-track-${track.kind}${track.source_type === 'agent_annotation' ? ' genome-track-annotation' : ''}`}
      aria-label={`${track.label} track`}
      aria-busy={loading}
    >
      <div className="track-label">
        <div>
          <Tooltip>
            <TooltipTrigger asChild>
              <strong tabIndex={0}>{track.label}</strong>
            </TooltipTrigger>
            <TooltipContent className="genome-tooltip track-tooltip" side="right" sideOffset={8}>
              <strong>{track.label}</strong>
              <p>{track.description}</p>
              <div>
                <code>{track.id}</code>
                <span>{track.source_type}</span>
              </div>
            </TooltipContent>
          </Tooltip>
          <div className="track-meta">
            <span className="track-kind">{track.kind}</span>
            {data?.truncated ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="track-limit-badge" tabIndex={0}>
                    {data.features.length}+
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Showing the first {data.features.length.toLocaleString()} items. Zoom in to see the full set.
                </TooltipContent>
              </Tooltip>
            ) : null}
            {track.id === 'sequenceContext' ? (
              <span className="context-legend" aria-label="Repeats, segmental duplications, and blacklist regions">
                <i className="context-repeat" />
                <i className="context-duplication" />
                <i className="context-blacklist" />
              </span>
            ) : null}
          </div>
        </div>
        <div className="track-actions">
          <DropdownMenu onOpenChange={(isOpen) => {
            if (!isOpen) setCopiedTrackId(false)
          }}>
            <DropdownMenuTrigger asChild>
              <Button size="icon-xs" variant="ghost" aria-label={`Options for ${track.label}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64" side="right" align="start" sideOffset={7}>
              <DropdownMenuLabel className="space-y-0.5 px-2 py-2">
                <span className="block truncate text-xs font-semibold">{track.label}</span>
                <span className="block truncate font-mono text-[10px] font-normal text-muted-foreground">
                  {track.id} · {track.kind}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault()
                  void navigator.clipboard.writeText(track.id).then(() => setCopiedTrackId(true))
                }}
              >
                {copiedTrackId ? <Check /> : <Copy />}
                {copiedTrackId ? 'Copied track ID' : 'Copy track ID'}
              </DropdownMenuItem>
              {track.source_url ? (
                <DropdownMenuItem asChild>
                  <a href={track.source_url} target="_blank" rel="noreferrer">
                    <ExternalLink />
                    Open source data
                  </a>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                <Trash2 />
                Remove track
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className={`track-canvas track-${track.kind}`}>
        {loading && !data && !paused ? (
          <div className={`track-initial-placeholder placeholder-${track.kind}`} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : null}
        {paused ? (
          <div className="track-message">
            Zoom to {formatSpan(threshold)} or less to load this {track.kind === 'signal' ? 'signal' : 'track'}.
          </div>
        ) : null}
        {error ? (
          <div className="track-message track-error">
            <AlertCircle />
            <span>{error}</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                setData(null)
                setRetryNonce((current) => current + 1)
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {data && !paused ? (
          <TrackGraphic
            track={track}
            region={region}
            features={data.features}
            onSelect={onSelect}
            onHoverStart={showFeatureTooltip}
            onHoverMove={positionHoverCard}
            onHoverEnd={() => setHoveredFeature(null)}
          />
        ) : null}
        {!paused && data?.truncated && (track.id === 'clinvarMain' || track.id === 'gnomadV4') ? (
          <span className="track-density-note">Sampled density · zoom for records</span>
        ) : null}
      </div>
      {hoveredFeature && typeof document !== 'undefined'
        ? createPortal(
            <FeatureHoverCard
              ref={hoverCard}
              feature={hoveredFeature}
              kind={track.kind}
              x={hoverPosition.current.x}
              y={hoverPosition.current.y}
            />,
            document.body,
          )
        : null}
    </section>
  )
}

type TrackGraphicProps = {
  track: TrackDefinition
  region: Region
  features: GenomicFeature[]
  onSelect: (feature: GenomicFeature, track: TrackDefinition) => void
  onHoverStart: (feature: GenomicFeature, clientX: number, clientY: number) => void
  onHoverMove: (clientX: number, clientY: number) => void
  onHoverEnd: () => void
}

function TrackGraphic({
  track,
  region,
  features,
  onSelect,
  onHoverStart,
  onHoverMove,
  onHoverEnd,
}: TrackGraphicProps) {
  const visible = features.filter((feature) => feature.end > region.start && feature.start < region.end)
  if (visible.length === 0) return <div className="track-message">No items in this region.</div>

  if (track.kind === 'signal') {
    return <SignalGraphic region={region} features={visible} />
  }

  if (track.id === 'cytoBandIdeo') {
    return (
      <CytobandGraphic
        track={track}
        region={region}
        features={visible}
        onSelect={onSelect}
        onHoverStart={onHoverStart}
        onHoverMove={onHoverMove}
        onHoverEnd={onHoverEnd}
      />
    )
  }

  if (track.kind === 'gene') {
    return (
      <GeneGraphic
        track={track}
        region={region}
        features={visible}
        onSelect={onSelect}
        onHoverStart={onHoverStart}
        onHoverMove={onHoverMove}
        onHoverEnd={onHoverEnd}
      />
    )
  }

  if (track.id === 'gnomadV4') {
    return (
      <PopulationVariantGraphic
        track={track}
        region={region}
        features={visible}
        onSelect={onSelect}
        onHoverStart={onHoverStart}
        onHoverMove={onHoverMove}
        onHoverEnd={onHoverEnd}
      />
    )
  }

  if (track.id === 'sequenceContext') {
    return (
      <SequenceContextGraphic
        track={track}
        region={region}
        features={visible}
        onSelect={onSelect}
        onHoverStart={onHoverStart}
        onHoverMove={onHoverMove}
        onHoverEnd={onHoverEnd}
      />
    )
  }

  if (track.kind === 'variant') {
    return (
      <VariantGraphic
        track={track}
        region={region}
        features={visible}
        onSelect={onSelect}
        onHoverStart={onHoverStart}
        onHoverMove={onHoverMove}
        onHoverEnd={onHoverEnd}
      />
    )
  }

  const height = 42
  return (
    <svg viewBox={`0 0 ${VIEWBOX_WIDTH} ${height}`} preserveAspectRatio="none" role="img">
      {visible.slice(0, 180).map((feature, index) => {
        return (
          <FeatureGlyph
            key={`${feature.id}-${index}`}
            feature={feature}
            kind={track.kind}
            region={region}
            y={21}
            onClick={() => onSelect(feature, track)}
            onHoverStart={(clientX, clientY) => onHoverStart(feature, clientX, clientY)}
            onHoverMove={onHoverMove}
            onHoverEnd={onHoverEnd}
          />
        )
      })}
    </svg>
  )
}

function CytobandGraphic({
  track,
  region,
  features,
  onSelect,
  onHoverStart,
  onHoverMove,
  onHoverEnd,
}: TrackGraphicProps) {
  return (
    <div className="cytoband-graphic" role="img" aria-label="Chromosome cytobands">
      {features.map((feature, index) => {
        const left = coordinateToX(feature.start, region) / 10
        const right = coordinateToX(feature.end, region) / 10
        const stain = String(feature.attributes.gieStain ?? 'gneg')
        return (
          <button
            type="button"
            key={`${feature.id}-${index}`}
            className="cytoband-segment"
            style={{
              left: `${left}%`,
              width: `${Math.max(0.4, right - left)}%`,
              background: cytobandColor(stain),
              color: stain === 'gpos100' ? '#fff' : '#283246',
            }}
            onClick={() => onSelect(feature, track)}
            onPointerEnter={(event) => onHoverStart(feature, event.clientX, event.clientY)}
            onPointerMove={(event) => onHoverMove(event.clientX, event.clientY)}
            onPointerLeave={onHoverEnd}
            aria-label={`Cytoband ${feature.label}`}
          >
            {feature.label}
          </button>
        )
      })}
    </div>
  )
}

function cytobandColor(stain: string): string {
  const colors: Record<string, string> = {
    gneg: '#f4f5f7',
    gpos25: '#d9dde3',
    gpos50: '#aeb5bf',
    gpos75: '#737d8b',
    gpos100: '#303846',
    acen: '#d98686',
    stalk: '#8ca5c8',
    gvar: '#d9caa8',
  }
  return colors[stain] ?? '#e5e7eb'
}

function PopulationVariantGraphic({
  track,
  region,
  features,
  onSelect,
  onHoverStart,
  onHoverMove,
  onHoverEnd,
}: TrackGraphicProps) {
  const densityMode = region.end - region.start > 12_000
  if (densityMode) {
    const binCount = 120
    const bins = Array.from({ length: binCount }, () => ({ count: 0, maxAf: 0 }))
    for (const feature of features) {
      const ratio = (feature.start - region.start) / (region.end - region.start)
      const index = Math.max(0, Math.min(binCount - 1, Math.floor(ratio * binCount)))
      bins[index].count += Number(feature.attributes.density_count ?? 1)
      bins[index].maxAf = Math.max(
        bins[index].maxAf,
        Number(feature.attributes.max_af ?? populationAlleleFrequency(feature)),
      )
    }
    const maxCount = Math.max(1, ...bins.map((bin) => bin.count))
    const binWidth = VIEWBOX_WIDTH / binCount
    return (
      <svg
        className="population-graphic"
        viewBox={`0 0 ${VIEWBOX_WIDTH} 46`}
        preserveAspectRatio="none"
        role="img"
        aria-label="gnomAD variant density"
      >
        <line x1="0" x2={VIEWBOX_WIDTH} y1="42" y2="42" className="population-baseline" />
        {bins.map((bin, index) => {
          if (bin.count === 0) return null
          const height = Math.max(2, Math.sqrt(bin.count / maxCount) * 34)
          return (
            <rect
              key={index}
              x={index * binWidth + 0.75}
              y={42 - height}
              width={Math.max(1.5, binWidth - 1.5)}
              height={height}
              rx="1.5"
              className={bin.maxAf >= 0.01 ? 'population-bin-common' : 'population-bin'}
            />
          )
        })}
      </svg>
    )
  }

  return (
    <svg
      className="population-graphic"
      viewBox={`0 0 ${VIEWBOX_WIDTH} 46`}
      preserveAspectRatio="none"
      role="img"
      aria-label="gnomAD population allele frequencies"
    >
      <line x1="0" x2={VIEWBOX_WIDTH} y1="42" y2="42" className="population-baseline" />
      {features.slice(0, 400).map((feature, index) => {
        const x = coordinateToX(feature.start, region)
        const frequency = populationAlleleFrequency(feature)
        const y = frequency <= 0
          ? 38
          : 8 + Math.min(30, Math.max(0, (-Math.log10(frequency) - 2) * 7.5))
        const common = frequency >= 0.01
        return (
          <g
            key={`${feature.id}-${index}`}
            className="feature-glyph population-variant"
            onClick={() => onSelect(feature, track)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onSelect(feature, track)
            }}
            onPointerEnter={(event) => onHoverStart(feature, event.clientX, event.clientY)}
            onPointerMove={(event) => onHoverMove(event.clientX, event.clientY)}
            onPointerLeave={onHoverEnd}
            role="button"
            tabIndex={0}
            aria-label={`${feature.label}, allele frequency ${formatAlleleFrequency(frequency)}`}
          >
            <line x1={x} x2={x} y1={y + 3} y2="42" />
            <circle cx={x} cy={y} r={common ? 4 : 2.75} className={common ? 'population-common' : 'population-rare'} />
          </g>
        )
      })}
    </svg>
  )
}

function SequenceContextGraphic({
  track,
  region,
  features,
  onSelect,
  onHoverStart,
  onHoverMove,
  onHoverEnd,
}: TrackGraphicProps) {
  const lanes = {
    repeat: { y: 9, className: 'context-feature-repeat' },
    segmental_duplication: { y: 22, className: 'context-feature-duplication' },
    blacklist: { y: 35, className: 'context-feature-blacklist' },
  }
  return (
    <svg
      className="context-graphic"
      viewBox={`0 0 ${VIEWBOX_WIDTH} 44`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Sequence context annotations"
    >
      {[9, 22, 35].map((y) => (
        <line key={y} x1="0" x2={VIEWBOX_WIDTH} y1={y} y2={y} className="context-baseline" />
      ))}
      {features.slice(0, 300).map((feature, index) => {
        const dataset = String(feature.attributes.dataset ?? 'repeat') as keyof typeof lanes
        const lane = lanes[dataset] ?? lanes.repeat
        const start = coordinateToX(feature.start, region)
        const end = coordinateToX(feature.end, region)
        return (
          <rect
            key={`${feature.id}-${index}`}
            x={start}
            y={lane.y - 3}
            width={Math.max(3, end - start)}
            height="6"
            rx="3"
            className={`feature-glyph ${lane.className}`}
            onClick={() => onSelect(feature, track)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onSelect(feature, track)
            }}
            onPointerEnter={(event) => onHoverStart(feature, event.clientX, event.clientY)}
            onPointerMove={(event) => onHoverMove(event.clientX, event.clientY)}
            onPointerLeave={onHoverEnd}
            role="button"
            tabIndex={0}
            aria-label={`${feature.label}, ${dataset.replaceAll('_', ' ')}`}
          />
        )
      })}
    </svg>
  )
}

function VariantGraphic({
  track,
  region,
  features,
  onSelect,
  onHoverStart,
  onHoverMove,
  onHoverEnd,
}: TrackGraphicProps) {
  const densityMode = region.end - region.start > 12_000 || features.length > 300
  if (densityMode) {
    const binCount = 160
    const bins = Array.from({ length: binCount }, () => ({
      count: 0,
      category: 'other' as ReturnType<typeof variantCategory>,
    }))
    const priority: Record<ReturnType<typeof variantCategory>, number> = {
      other: 0,
      benign: 1,
      uncertain: 2,
      conflicting: 3,
      pathogenic: 4,
    }
    for (const feature of features) {
      const ratio = (feature.start - region.start) / (region.end - region.start)
      const index = Math.max(0, Math.min(binCount - 1, Math.floor(ratio * binCount)))
      const category = variantCategory(feature)
      bins[index].count += 1
      if (priority[category] > priority[bins[index].category]) bins[index].category = category
    }
    const maxCount = Math.max(1, ...bins.map((bin) => bin.count))
    const binWidth = VIEWBOX_WIDTH / binCount
    return (
      <svg
        className="variant-graphic variant-density"
        viewBox={`0 0 ${VIEWBOX_WIDTH} 46`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${track.label} density across ${features.length.toLocaleString()} variants`}
      >
        <line x1="0" x2={VIEWBOX_WIDTH} y1="42" y2="42" className="variant-baseline" />
        {bins.map((bin, index) => {
          if (bin.count === 0) return null
          const height = Math.max(2, Math.sqrt(bin.count / maxCount) * 34)
          return (
            <rect
              key={index}
              x={index * binWidth + 0.6}
              y={42 - height}
              width={Math.max(1.5, binWidth - 1.2)}
              height={height}
              rx="1"
              className={`variant-density-${bin.category}`}
            />
          )
        })}
      </svg>
    )
  }

  const laneY = [8, 17, 26, 35]
  const laneEnds = laneY.map(() => Number.NEGATIVE_INFINITY)
  const laidOut = [...features]
    .sort((a, b) => a.start - b.start)
    .map((feature) => {
      const x = coordinateToX(feature.start, region)
      let lane = laneEnds.findIndex((lastX) => x - lastX >= 13)
      if (lane < 0) {
        lane = laneEnds.indexOf(Math.min(...laneEnds))
      }
      laneEnds[lane] = x
      return { feature, y: laneY[lane] }
    })

  return (
    <div className="variant-detail-graphic" role="group" aria-label={`${track.label} variants`}>
      <svg viewBox={`0 0 ${VIEWBOX_WIDTH} 46`} preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2={VIEWBOX_WIDTH} y1="42" y2="42" className="variant-baseline" />
        {laidOut.map(({ feature, y }, index) => {
          const x = coordinateToX(feature.start, region)
          return (
            <line
              key={`${feature.id}-${feature.start}-${index}`}
              x1={x}
              x2={x}
              y1={y + 4}
              y2="42"
              stroke={featureColor(feature, 'variant')}
              className={`variant-stem variant-stem-${variantCategory(feature)}`}
            />
          )
        })}
      </svg>
      {laidOut.map(({ feature, y }, index) => {
        const category = variantCategory(feature)
        const significance = String(feature.attributes.clinSign ?? 'Unclassified')
        return (
          <button
            key={`${feature.id}-${feature.start}-${index}`}
            type="button"
            className={`variant-marker variant-marker-${category}`}
            style={{
              left: `${coordinateToX(feature.start, region) / 10}%`,
              top: `${y}px`,
              color: featureColor(feature, 'variant'),
            }}
            onClick={() => onSelect(feature, track)}
            onPointerEnter={(event) => onHoverStart(feature, event.clientX, event.clientY)}
            onPointerMove={(event) => onHoverMove(event.clientX, event.clientY)}
            onPointerLeave={onHoverEnd}
            aria-label={`${feature.label}, ${significance}`}
          />
        )
      })}
    </div>
  )
}

function GeneGraphic({
  track,
  region,
  features,
  onSelect,
  onHoverStart,
  onHoverMove,
  onHoverEnd,
}: TrackGraphicProps) {
  const overview = region.end - region.start >= 12_000
  const entries = overview
    ? overviewGeneEntries(features, region)
    : detailGeneEntries(features)
  const laneCount = Math.max(1, ...entries.map((entry) => entry.lane + 1))
  const laneHeight = overview ? 28 : 22
  const height = Math.max(42, laneCount * laneHeight + 6)
  const labelled = new Set<string>()

  return (
    <div className="gene-graphic" style={{ height }}>
      <svg viewBox={`0 0 ${VIEWBOX_WIDTH} ${height}`} preserveAspectRatio="none" role="img">
        {entries.map(({ feature, lane }, entryIndex) => {
          const y = (overview ? 21 : 14) + lane * laneHeight
          return (
            <FeatureGlyph
              key={`${track.id}-${feature.id}-${feature.start}-${feature.end}-${lane}-${entryIndex}`}
              feature={feature}
              kind="gene"
              region={region}
              y={y}
              onClick={() => onSelect(feature, track)}
              onHoverStart={(clientX, clientY) => onHoverStart(feature, clientX, clientY)}
              onHoverMove={onHoverMove}
              onHoverEnd={onHoverEnd}
            />
          )
        })}
      </svg>
      {entries.map(({ feature, lane, symbol, groupStart, groupEnd }, entryIndex) => {
        const left = coordinateToX(groupStart, region) / 10
        const right = coordinateToX(groupEnd, region) / 10
        return (
          <button
            type="button"
            key={`target-${track.id}-${feature.id}-${feature.start}-${feature.end}-${lane}-${entryIndex}`}
            className="gene-row-target"
            style={{
              left: `${left}%`,
              width: `${Math.max(0, right - left)}%`,
              minWidth: '16px',
              top: `${lane * laneHeight + 5}px`,
              height: `${laneHeight - 4}px`,
            }}
            onClick={() => onSelect(feature, track)}
            onPointerEnter={(event) => onHoverStart(feature, event.clientX, event.clientY)}
            onPointerMove={(event) => onHoverMove(event.clientX, event.clientY)}
            onPointerLeave={onHoverEnd}
            aria-label={`Open ${symbol} transcript details`}
          />
        )
      })}
      {entries.flatMap(({ feature, lane, symbol, groupStart, groupEnd }, entryIndex) => {
        if (!overview && labelled.has(symbol)) return []
        labelled.add(symbol)
        const startX = coordinateToX(groupStart, region) / 10
        const midpointX = coordinateToX(groupStart + (groupEnd - groupStart) / 2, region) / 10
        const pinned = !overview && startX < 8
        return [
          <button
            type="button"
            key={`label-${track.id}-${feature.id}-${feature.start}-${feature.end}-${lane}-${entryIndex}`}
            className={`gene-name ${overview ? 'gene-name-overview' : pinned ? 'gene-name-pinned' : 'gene-name-detail'}`}
            style={{
              left: `${overview ? midpointX : startX}%`,
              top: `${overview ? lane * laneHeight + 2 : lane * laneHeight + 6}px`,
            }}
            onClick={() => onSelect(feature, track)}
            onPointerEnter={(event) => onHoverStart(feature, event.clientX, event.clientY)}
            onPointerMove={(event) => onHoverMove(event.clientX, event.clientY)}
            onPointerLeave={onHoverEnd}
            aria-label={`Open ${symbol} gene details`}
          >
            {symbol}
          </button>,
        ]
      })}
    </div>
  )
}

type GeneEntry = {
  feature: GenomicFeature
  symbol: string
  groupStart: number
  groupEnd: number
  lane: number
}

function overviewGeneEntries(features: GenomicFeature[], region: Region): GeneEntry[] {
  const groups = new Map<string, GenomicFeature[]>()
  for (const feature of features) {
    const symbol = geneSymbol(feature)
    groups.set(symbol, [...(groups.get(symbol) ?? []), feature])
  }

  const span = region.end - region.start
  const laneEnds: number[] = []
  return [...groups.entries()]
    .map(([symbol, members]) => {
      const sorted = [...members].sort(
        (a, b) => transcriptRank(a) - transcriptRank(b) || (b.end - b.start) - (a.end - a.start),
      )
      return {
        symbol,
        feature: sorted[0],
        groupStart: Math.min(...members.map((feature) => feature.start)),
        groupEnd: Math.max(...members.map((feature) => feature.end)),
      }
    })
    .sort((a, b) => a.groupStart - b.groupStart)
    .slice(0, 12)
    .map((entry) => {
      const labelGap = span * 0.035
      let lane = laneEnds.findIndex((end) => entry.groupStart > end + labelGap)
      if (lane < 0) lane = laneEnds.length
      laneEnds[lane] = entry.groupEnd
      return { ...entry, lane }
    })
}

function detailGeneEntries(features: GenomicFeature[]): GeneEntry[] {
  return features.slice(0, 8).map((feature, lane) => ({
    feature,
    symbol: geneSymbol(feature),
    groupStart: feature.start,
    groupEnd: feature.end,
    lane,
  }))
}

function geneSymbol(feature: GenomicFeature): string {
  const candidates = [
    feature.attributes.geneSymbol,
    feature.attributes.hgncSymbol,
    feature.attributes.gene_name,
    feature.attributes.geneName,
  ]
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim()
    if (value && value.toLowerCase() !== 'none' && !value.startsWith('ENSG')) return value
  }
  const label = feature.label.trim()
  return label && label.toLowerCase() !== 'none' ? label : feature.id
}

function transcriptRank(feature: GenomicFeature): number {
  const rank = Number(feature.attributes.rank)
  return Number.isFinite(rank) ? rank : Number.MAX_SAFE_INTEGER
}

function FeatureGlyph({
  feature,
  kind,
  region,
  y,
  onClick,
  onHoverStart,
  onHoverMove,
  onHoverEnd,
}: {
  feature: GenomicFeature
  kind: TrackDefinition['kind']
  region: Region
  y: number
  onClick: () => void
  onHoverStart: (clientX: number, clientY: number) => void
  onHoverMove: (clientX: number, clientY: number) => void
  onHoverEnd: () => void
}) {
  const start = coordinateToX(feature.start, region)
  const end = coordinateToX(feature.end, region)
  const width = Math.max(2.5, end - start)
  const color = featureColor(feature, kind)
  const blocks = kind === 'gene' ? exonBlocks(feature) : []

  if (kind === 'variant') {
    const category = variantCategory(feature)
    const significance = String(feature.attributes.clinSign ?? 'Unclassified')
    return (
      <g
        className={`feature-glyph variant-glyph variant-${category}`}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onClick()
        }}
        onPointerEnter={(event) => onHoverStart(event.clientX, event.clientY)}
        onPointerMove={(event) => onHoverMove(event.clientX, event.clientY)}
        onPointerLeave={onHoverEnd}
        role="button"
        tabIndex={0}
        aria-label={`${feature.label}, ${significance}`}
      >
        <line x1={start} x2={start} y1={y + 4} y2={42} stroke={color} strokeWidth="1" />
        {category === 'pathogenic' ? (
          <path
            d={`M ${start} ${y - 5} L ${start + 5} ${y} L ${start} ${y + 5} L ${start - 5} ${y} Z`}
            fill={color}
          />
        ) : category === 'conflicting' ? (
          <rect x={start - 4} y={y - 4} width="8" height="8" rx="1.5" fill={color} />
        ) : category === 'benign' ? (
          <circle cx={start} cy={y} r="3.5" fill="#fff" stroke={color} strokeWidth="2" />
        ) : (
          <circle cx={start} cy={y} r={category === 'uncertain' ? 4 : 3.5} fill={color} />
        )}
      </g>
    )
  }

  if (blocks.length > 0) {
    return (
      <g
        className="feature-glyph gene-feature-glyph"
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onClick()
        }}
        onPointerEnter={(event) => onHoverStart(event.clientX, event.clientY)}
        onPointerMove={(event) => onHoverMove(event.clientX, event.clientY)}
        onPointerLeave={onHoverEnd}
        role="button"
        tabIndex={0}
        aria-label={feature.label}
      >
        <rect
          className="gene-hit-area"
          x={start}
          y={y - 9}
          width={Math.max(14, end - start)}
          height="18"
          fill="transparent"
        />
        <line x1={start} x2={end} y1={y} y2={y} stroke={color} strokeWidth="1.5" />
        {blocks.map((block, index) => {
          const blockX = coordinateToX(block.start, region)
          const blockEnd = coordinateToX(block.end, region)
          return <rect key={index} x={blockX} y={y - 4} width={Math.max(2, blockEnd - blockX)} height="8" rx="1" fill={color} />
        })}
      </g>
    )
  }

  return (
    <g
      className="feature-glyph"
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onClick()
      }}
      onPointerEnter={(event) => onHoverStart(event.clientX, event.clientY)}
      onPointerMove={(event) => onHoverMove(event.clientX, event.clientY)}
      onPointerLeave={onHoverEnd}
      role="button"
      tabIndex={0}
      aria-label={feature.label}
    >
      <rect
        x={start}
        y={kind === 'regulatory' ? y - 3 : y - 5}
        width={width}
        height={kind === 'regulatory' ? 6 : 10}
        rx={kind === 'regulatory' ? 3 : 2}
        fill={color}
      />
    </g>
  )
}

function FeatureHoverCard({
  ref,
  feature,
  kind,
  x,
  y,
}: {
  ref: React.RefObject<HTMLDivElement | null>
  feature: GenomicFeature
  kind: TrackDefinition['kind']
  x: number
  y: number
}) {
  const rows = featureTooltipRows(feature, kind)
  return (
    <div
      ref={ref}
      className="genome-tooltip feature-tooltip feature-hover-card"
      style={{ transform: `translate3d(${x}px, ${y}px, 0)` }}
      role="tooltip"
    >
      <strong>{feature.label}</strong>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function featureTooltipRows(
  feature: GenomicFeature,
  kind: TrackDefinition['kind'],
): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    [
      'Position',
      `${feature.chrom}:${formatCoordinate(feature.start)}-${formatCoordinate(feature.end - 1)}`,
    ],
  ]
  if (kind === 'gene') {
    rows.push(['Transcript', feature.id])
    if (feature.strand) rows.push(['Strand', feature.strand])
    const geneType = tooltipValue(feature.attributes.geneType ?? feature.attributes.transcriptType)
    if (geneType) rows.push(['Type', geneType])
    const maneStatus = tooltipValue(feature.attributes.maneStat)
    if (maneStatus) rows.push(['MANE', maneStatus])
  } else if (kind === 'variant') {
    const exomeFrequency = optionalFrequency(feature.attributes.exomes_AF)
    const genomeFrequency = optionalFrequency(feature.attributes.genomes_AF)
    if (exomeFrequency !== null || genomeFrequency !== null) {
      if (exomeFrequency !== null) rows.push(['Exome AF', formatAlleleFrequency(exomeFrequency)])
      if (genomeFrequency !== null) rows.push(['Genome AF', formatAlleleFrequency(genomeFrequency)])
      const filter = tooltipValue(feature.attributes.FILTER)
      if (filter) rows.push(['Filter', filter])
    } else {
      const significance = tooltipValue(feature.attributes.clinSign)
      if (significance) rows.push(['Significance', significance])
    }
    const consequence = tooltipValue(feature.attributes.molConseq)
      ?? tooltipValue(feature.attributes.variation_type)
    if (consequence) rows.push(['Consequence', consequence])
    rows.push(['Record', feature.id])
  } else if (kind === 'repeat' && feature.attributes.dataset) {
    rows.push(['Layer', String(feature.attributes.dataset).replaceAll('_', ' ')])
    rows.push(['Record', feature.label])
  } else if (kind === 'regulatory') {
    const category = tooltipValue(feature.attributes.cCRE_class)
    if (category) rows.push(['Class', category])
    const dnase = tooltipValue(feature.attributes.DNase_maxZ)
    if (dnase) rows.push(['DNase max Z', dnase])
    rows.push(['Record', feature.id])
  } else {
    rows.push(['Record', feature.id])
  }
  return rows
}

function tooltipValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

function populationAlleleFrequency(feature: GenomicFeature): number {
  return Math.max(
    optionalFrequency(feature.attributes.exomes_AF) ?? 0,
    optionalFrequency(feature.attributes.genomes_AF) ?? 0,
    optionalFrequency(feature.attributes.AF) ?? 0,
  )
}

function optionalFrequency(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const frequency = Number(value)
  return Number.isFinite(frequency) ? frequency : null
}

function formatAlleleFrequency(frequency: number): string {
  if (frequency === 0) return '0'
  if (frequency < 0.0001) return frequency.toExponential(2)
  return `${(frequency * 100).toLocaleString(undefined, { maximumFractionDigits: 3 })}%`
}

function SignalGraphic({ region, features }: { region: Region; features: GenomicFeature[] }) {
  const points = useMemo(() => {
    const values = features.map((feature) => feature.value ?? 0)
    const min = Math.min(...values, 0)
    const max = Math.max(...values, 1)
    const range = max - min || 1
    return features
      .sort((a, b) => a.start - b.start)
      .map((feature) => {
        const x = coordinateToX(feature.start, region)
        const y = 40 - (((feature.value ?? 0) - min) / range) * 32
        return `${x},${y}`
      })
      .join(' ')
  }, [features, region])

  return (
    <svg viewBox={`0 0 ${VIEWBOX_WIDTH} 46`} preserveAspectRatio="none" role="img">
      <line x1="0" x2={VIEWBOX_WIDTH} y1="40" y2="40" className="signal-baseline" />
      <polygon points={`0,40 ${points} ${VIEWBOX_WIDTH},40`} className="signal-area" />
      <polyline points={points} className="signal-line" />
    </svg>
  )
}

function coordinateToX(coordinate: number, region: Region): number {
  return Math.max(0, Math.min(VIEWBOX_WIDTH, ((coordinate - region.start) / (region.end - region.start)) * VIEWBOX_WIDTH))
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
  const offsets = String(feature.attributes.chromStarts ?? '').split(',').filter(Boolean).map(Number)
  return sizes.flatMap((size, index) => {
    const offset = offsets[index]
    return Number.isFinite(size) && Number.isFinite(offset)
      ? [{ start: feature.start + offset, end: feature.start + offset + size }]
      : []
  })
}

function featureColor(feature: GenomicFeature, kind: TrackDefinition['kind']): string {
  if (kind === 'variant') {
    const category = variantCategory(feature)
    if (category === 'pathogenic') return '#c94747'
    if (category === 'conflicting') return '#cf7b30'
    if (category === 'uncertain') return '#7d68ad'
    if (category === 'benign') return '#43836e'
    return '#738095'
  }
  if (kind === 'regulatory') {
    const category = String(feature.attributes.cCRE_class ?? '').toLowerCase()
    if (category.includes('promoter')) return '#d44b73'
    if (category.includes('enhancer')) return '#dd9b2c'
    return '#3e9f8c'
  }
  if (kind === 'repeat') return '#8c7a66'
  return '#5068b1'
}

function variantCategory(
  feature: GenomicFeature,
): 'pathogenic' | 'conflicting' | 'uncertain' | 'benign' | 'other' {
  const significance = String(feature.attributes.clinSign ?? '').toLowerCase()
  if (significance.includes('pathogenic')) return 'pathogenic'
  if (significance.includes('conflict')) return 'conflicting'
  if (significance.includes('uncertain')) return 'uncertain'
  if (significance.includes('benign')) return 'benign'
  return 'other'
}
