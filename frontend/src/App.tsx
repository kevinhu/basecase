import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Focus,
  Minus,
  Plus,
  ScanLine,
  X,
} from 'lucide-react'
import type { AgentAnnotationTrack, GenomicFeature, TrackDefinition } from '@/lib/api'
import { fetchTrackCatalog } from '@/lib/api'
import {
  BRCA1_REGION,
  formatCoordinate,
  formatSpan,
  panRegion,
  scaleBar,
  ticks,
  zoomRegion,
} from '@/lib/genome'
import type { Region } from '@/lib/genome'
import { GenomeTrack } from '@/components/genome-track'
import { EvidenceAgent } from '@/components/evidence-agent'
import { GeneDetailDialog } from '@/components/gene-detail-dialog'
import { LocusSearch } from '@/components/locus-search'
import { TrackPicker } from '@/components/track-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { TooltipProvider } from '@/components/ui/tooltip'
import './App.css'
import './variants/01-precision.css'

const DEFAULT_TRACK_IDS = [
  'cytoBandIdeo',
  'altSeqLiftOverPsl',
  'fixSeqLiftOverPsl',
  'mane',
  'knownGene',
  'ncbiRefSeqCurated',
  'omimAvSnp',
  'omimGene2',
  'gtexGeneV8',
  'clinvarMain',
  'dbSnp155Common',
  'gnomadV4',
  'cCREregistry',
  'comments',
  'multiz100way',
  'phyloP100way',
  'rmsk',
]

const ANNOTATION_STORAGE_KEY = 'basecase-agent-annotations-v1'

type StoredAnnotation = AgentAnnotationTrack & { active: boolean }

function loadStoredAnnotations(): StoredAnnotation[] {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(window.localStorage.getItem(ANNOTATION_STORAGE_KEY) ?? '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

type DragState = {
  pointerId: number
  startX: number
  width: number
  region: Region
}

type SelectionDragState = {
  pointerId: number
  startX: number
  plotLeft: number
  plotRight: number
  plotWidth: number
  region: Region
}

function App() {
  const storedAnnotations = useMemo(loadStoredAnnotations, [])
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [catalogError, setCatalogError] = useState(false)
  const [catalogRetry, setCatalogRetry] = useState(0)
  const [region, setRegion] = useState<Region>(BRCA1_REGION)
  const [tracks, setTracks] = useState<TrackDefinition[]>(() => storedAnnotations.map((item) => item.track))
  const [activeTrackIds, setActiveTrackIds] = useState<string[]>(() => [
    ...DEFAULT_TRACK_IDS,
    ...storedAnnotations.filter((item) => item.active).map((item) => item.track.id),
  ])
  const [annotationFeatures, setAnnotationFeatures] = useState<Record<string, GenomicFeature[]>>(() =>
    Object.fromEntries(storedAnnotations.map((item) => [item.track.id, item.features])),
  )
  const [loadingTrackIds, setLoadingTrackIds] = useState<Set<string>>(() => new Set())
  const [initialLoadComplete, setInitialLoadComplete] = useState(false)
  const initialLoadStarted = useRef(false)
  const [dragOffset, setDragOffset] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const dragState = useRef<DragState | null>(null)
  const selectionDragState = useRef<SelectionDragState | null>(null)
  const suppressClick = useRef(false)
  const pointerGuide = useRef<HTMLDivElement | null>(null)
  const pointerCoordinate = useRef<HTMLSpanElement | null>(null)
  const selectionOverlay = useRef<HTMLDivElement | null>(null)
  const [selectedRegions, setSelectedRegions] = useState<Region[]>([])
  const [selection, setSelection] = useState<{
    feature: GenomicFeature
    track: TrackDefinition
  } | null>(null)
  const [geneDialogSelection, setGeneDialogSelection] = useState<{
    feature: GenomicFeature
    track: TrackDefinition
  } | null>(null)
  const [geneDialogOpen, setGeneDialogOpen] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.uiVariant = 'precision'
    window.localStorage.removeItem('basecase-ui-variant')
    const url = new URL(window.location.href)
    if (url.searchParams.has('ui')) {
      url.searchParams.delete('ui')
      window.history.replaceState({}, '', url)
    }
    return () => {
      delete document.documentElement.dataset.uiVariant
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setCatalogError(false)
    fetchTrackCatalog(region.assembly, { limit: 100 }, controller.signal)
      .then((catalog) => {
        setTracks((current) => [
          ...catalog.tracks,
          ...current.filter((track) => track.source_type === 'agent_annotation'),
        ])
        setCatalogLoaded(true)
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setCatalogLoaded(false)
        setCatalogError(true)
      })
    return () => controller.abort()
  }, [catalogRetry, region.assembly])

  useEffect(() => {
    const annotations = tracks
      .filter((track) => track.source_type === 'agent_annotation')
      .map((track) => ({
        track,
        features: annotationFeatures[track.id] ?? [],
        active: activeTrackIds.includes(track.id),
      }))
    window.localStorage.setItem(ANNOTATION_STORAGE_KEY, JSON.stringify(annotations))
  }, [activeTrackIds, annotationFeatures, tracks])

  const trackMap = useMemo(
    () => new Map(tracks.map((track) => [track.id, track])),
    [tracks],
  )
  const visibleTracks = activeTrackIds.flatMap((trackId) => {
    const track = trackMap.get(trackId)
    return track ? [track] : []
  })
  const activeSet = useMemo(() => new Set(activeTrackIds), [activeTrackIds])
  const agentTracks = useMemo(
    () => tracks.filter((track) => track.source_type === 'agent_annotation'),
    [tracks],
  )
  const regionTicks = ticks(region)
  const regionMinorTicks = ticks(region, 11)
  const rulerScaleBar = scaleBar(region.end - region.start)
  const isRefreshing = initialLoadComplete && loadingTrackIds.size > 0

  useEffect(() => {
    if (!catalogLoaded || visibleTracks.length === 0 || initialLoadComplete) return
    if (loadingTrackIds.size > 0) {
      initialLoadStarted.current = true
    } else if (initialLoadStarted.current) {
      setInitialLoadComplete(true)
    }
  }, [catalogLoaded, initialLoadComplete, loadingTrackIds, visibleTracks.length])

  const handleTrackLoading = useCallback((trackId: string, loading: boolean) => {
    setLoadingTrackIds((current) => {
      const next = new Set(current)
      if (loading) next.add(trackId)
      else next.delete(trackId)
      return next
    })
  }, [])

  function updateRegion(nextRegion: Region) {
    setRegion(nextRegion)
    setSelection(null)
    setSelectedRegions([])
    if (selectionOverlay.current) selectionOverlay.current.style.opacity = '0'
    if (pointerGuide.current) pointerGuide.current.style.opacity = '0'
  }

  function toggleTrack(track: TrackDefinition) {
    setTracks((current) =>
      current.some((candidate) => candidate.id === track.id) ? current : [...current, track],
    )
    setActiveTrackIds((current) =>
      current.includes(track.id)
        ? current.filter((trackId) => trackId !== track.id)
        : [...current, track.id],
    )
  }

  function selectFeature(feature: GenomicFeature, track: TrackDefinition) {
    setSelection({ feature, track })
    if (track.kind === 'gene') {
      setGeneDialogSelection({ feature, track })
      setGeneDialogOpen(true)
    }
  }

  function startInteraction(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button, a, input, .track-label, .feature-glyph')) return
    const plot = target.closest<HTMLElement>('.track-canvas, .ruler-scale')
    if (!plot) return

    if (plot.classList.contains('ruler-scale') || event.shiftKey) {
      const plotBounds = event.currentTarget
        .querySelector<HTMLElement>('.ruler-scale')
        ?.getBoundingClientRect()
      if (!plotBounds) return
      selectionDragState.current = {
        pointerId: event.pointerId,
        startX: Math.max(plotBounds.left, Math.min(event.clientX, plotBounds.right)),
        plotLeft: plotBounds.left,
        plotRight: plotBounds.right,
        plotWidth: plotBounds.width,
        region,
      }
      if (selectionOverlay.current) selectionOverlay.current.style.opacity = '0'
      suppressClick.current = false
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    dragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      width: plot.getBoundingClientRect().width,
      region,
    }
    suppressClick.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveInteraction(event: ReactPointerEvent<HTMLDivElement>) {
    const selectionDrag = selectionDragState.current
    if (selectionDrag?.pointerId === event.pointerId) {
      const currentX = Math.max(
        selectionDrag.plotLeft,
        Math.min(event.clientX, selectionDrag.plotRight),
      )
      const distance = currentX - selectionDrag.startX
      if (Math.abs(distance) < 3) return
      suppressClick.current = true
      const overlay = selectionOverlay.current
      if (overlay) {
        const left = Math.min(selectionDrag.startX, currentX) - selectionDrag.plotLeft
        overlay.style.transform = `translate3d(${left}px, 0, 0)`
        overlay.style.width = `${Math.abs(distance)}px`
        overlay.style.opacity = '1'
      }
      return
    }

    const drag = dragState.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const offset = event.clientX - drag.startX
    if (Math.abs(offset) < 3 && !isDragging) return
    suppressClick.current = true
    setIsDragging(true)
    setDragOffset(offset)
  }

  function movePointerGuide(event: ReactPointerEvent<HTMLDivElement>) {
    const guide = pointerGuide.current
    const plot = event.currentTarget.querySelector<HTMLElement>('.ruler-scale')
    if (!guide || !plot) return
    const plotBounds = plot.getBoundingClientRect()
    if (event.clientX < plotBounds.left || event.clientX > plotBounds.right) {
      guide.style.opacity = '0'
      return
    }
    const browserBounds = event.currentTarget.getBoundingClientRect()
    const lastTrack = event.currentTarget.querySelector<HTMLElement>('.genome-track:last-of-type')
    const ratio = (event.clientX - plotBounds.left) / plotBounds.width
    const coordinate = Math.round(region.start + ratio * (region.end - region.start))
    guide.style.transform = `translate3d(${event.clientX - browserBounds.left}px, 0, 0)`
    guide.style.height = `${Math.max(40, (lastTrack?.getBoundingClientRect().bottom ?? plotBounds.bottom) - browserBounds.top)}px`
    guide.style.opacity = '1'
    if (pointerCoordinate.current) {
      pointerCoordinate.current.textContent = `${region.chrom}:${formatCoordinate(coordinate)}`
      pointerCoordinate.current.style.transform = event.clientX > plotBounds.right - 110
        ? 'translateX(calc(-100% - 7px))'
        : 'translateX(7px)'
    }
  }

  function hidePointerGuide() {
    if (pointerGuide.current) pointerGuide.current.style.opacity = '0'
  }

  function finishInteraction(event: ReactPointerEvent<HTMLDivElement>, commit: boolean) {
    const selectionDrag = selectionDragState.current
    if (selectionDrag?.pointerId === event.pointerId) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      const currentX = Math.max(
        selectionDrag.plotLeft,
        Math.min(event.clientX, selectionDrag.plotRight),
      )
      const distance = currentX - selectionDrag.startX
      if (commit && Math.abs(distance) >= 3) {
        const span = selectionDrag.region.end - selectionDrag.region.start
        const startRatio =
          (Math.min(selectionDrag.startX, currentX) - selectionDrag.plotLeft) /
          selectionDrag.plotWidth
        const endRatio =
          (Math.max(selectionDrag.startX, currentX) - selectionDrag.plotLeft) /
          selectionDrag.plotWidth
        const start = Math.round(selectionDrag.region.start + startRatio * span)
        const end = Math.max(start + 1, Math.round(selectionDrag.region.start + endRatio * span))
        const nextRegion = { ...selectionDrag.region, start, end }
        setSelectedRegions((current) => current.some((candidate) =>
          candidate.assembly === nextRegion.assembly &&
          candidate.chrom === nextRegion.chrom &&
          candidate.start === nextRegion.start &&
          candidate.end === nextRegion.end
        ) ? current : [...current, nextRegion])
        if (selectionOverlay.current) selectionOverlay.current.style.opacity = '0'
      } else if (selectionOverlay.current) {
        selectionOverlay.current.style.opacity = '0'
      }
      selectionDragState.current = null
      suppressClick.current = false
      return
    }

    const drag = dragState.current
    if (!drag || drag.pointerId !== event.pointerId) return

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (commit && suppressClick.current) {
      const span = drag.region.end - drag.region.start
      const finalOffset = event.clientX - drag.startX
      const shift = Math.round((-finalOffset / drag.width) * span)
      const start = Math.max(0, drag.region.start + shift)
      updateRegion({ ...drag.region, start, end: start + span })
    }
    dragState.current = null
    setDragOffset(0)
    setIsDragging(false)
  }

  function preventClickAfterDrag(event: ReactMouseEvent<HTMLDivElement>) {
    if (!suppressClick.current) return
    event.preventDefault()
    event.stopPropagation()
    suppressClick.current = false
  }

  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={300}>
      <main className="app-shell" data-ui-variant="precision">
        <header className="topbar">
          <div className="topbar-identity">
            <span className="brand">Basecase</span>
            <Separator orientation="vertical" />
            <Badge variant="secondary">{region.assembly}</Badge>
          </div>
          <LocusSearch region={region} onNavigate={updateRegion} />
          <div className="browser-actions">
            <div className="navigation-controls" aria-label="Navigate region">
              <Button size="icon-sm" variant="ghost" onClick={() => updateRegion(panRegion(region, -0.45))} aria-label="Pan left">
                <ArrowLeft />
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={() => updateRegion(zoomRegion(region, 0.5))} aria-label="Zoom in">
                <Plus />
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={() => updateRegion(zoomRegion(region, 2))} aria-label="Zoom out">
                <Minus />
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={() => updateRegion(panRegion(region, 0.45))} aria-label="Pan right">
                <ArrowRight />
              </Button>
            </div>
          </div>
        </header>

        <section className="workspace">
          <section className="browser-panel" aria-label="Genome browser">
            <div
              className={`genome-browser ${isDragging ? 'is-dragging' : ''}`}
              style={{ '--drag-offset': `${dragOffset}px` } as CSSProperties}
              onPointerDown={startInteraction}
              onPointerMove={(event) => {
                moveInteraction(event)
                movePointerGuide(event)
              }}
              onPointerUp={(event) => finishInteraction(event, true)}
              onPointerCancel={(event) => finishInteraction(event, false)}
              onPointerLeave={hidePointerGuide}
              onClickCapture={preventClickAfterDrag}
            >
              <div className="genome-ruler">
                <div className="ruler-label">
                  <span>{region.chrom}</span>
                  <TrackPicker
                    assembly={region.assembly}
                    activeTrackIds={activeSet}
                    customTracks={agentTracks}
                    onToggle={toggleTrack}
                    compact
                  />
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Select current viewport"
                    title="Attach current viewport"
                    onClick={() => setSelectedRegions((current) => current.some((candidate) =>
                      candidate.assembly === region.assembly
                      && candidate.chrom === region.chrom
                      && candidate.start === region.start
                      && candidate.end === region.end
                    ) ? current : [...current, region])}
                  >
                    <ScanLine />
                  </Button>
                </div>
                <div className="ruler-scale">
                  <div className="ruler-axis" />
                  {regionMinorTicks.map((tick) => (
                    <i
                      key={`minor-${tick}`}
                      className="ruler-minor-tick"
                      style={{ left: `${((tick - region.start) / (region.end - region.start)) * 100}%` }}
                    />
                  ))}
                  {regionTicks.map((tick) => (
                    <span className="ruler-tick" key={tick} style={{ left: `${((tick - region.start) / (region.end - region.start)) * 100}%` }}>
                      {formatCoordinate(tick)}
                    </span>
                  ))}
                  <div
                    className="scale-bar"
                    style={{ width: `${rulerScaleBar.widthPercent}%` }}
                  >
                    <span>{formatSpan(rulerScaleBar.bases)}</span>
                  </div>
                </div>
              </div>

              {visibleTracks.map((track) => (
                <GenomeTrack
                  key={track.id}
                  track={track}
                  region={region}
                  annotationFeatures={annotationFeatures[track.id]}
                  onRemove={() => setActiveTrackIds((current) => current.filter((trackId) => trackId !== track.id))}
                  onSelect={selectFeature}
                  onLoadingChange={handleTrackLoading}
                />
              ))}

              {catalogError ? (
                <div className="browser-empty browser-error" role="alert">
                  <p>The UCSC track catalog could not be loaded.</p>
                  <Button type="button" size="sm" variant="outline" onClick={() => setCatalogRetry((current) => current + 1)}>
                    Retry catalog
                  </Button>
                </div>
              ) : catalogLoaded && visibleTracks.length === 0 ? (
                <div className="browser-empty">
                  <p>No tracks are visible.</p>
                  <TrackPicker assembly={region.assembly} activeTrackIds={activeSet} customTracks={agentTracks} onToggle={toggleTrack} />
                </div>
              ) : null}
              <div className="selection-layer" aria-label="Selected genomic regions">
                <div aria-hidden="true" />
                <div className="selection-plot">
                  {selectedRegions.map((selectedRegion, index) => {
                    const viewportSpan = region.end - region.start
                    const left = ((selectedRegion.start - region.start) / viewportSpan) * 100
                    const width = ((selectedRegion.end - selectedRegion.start) / viewportSpan) * 100
                    return (
                      <div
                        className="region-selection region-selection-persisted"
                        key={`${selectedRegion.chrom}:${selectedRegion.start}-${selectedRegion.end}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      >
                        <div className="selection-range-card">
                          <span>
                            <i aria-hidden="true" />
                            {selectedRegions.length > 1 ? `Range ${index + 1}` : 'Selected range'}
                          </span>
                          <code>{formatSpan(selectedRegion.end - selectedRegion.start)}</code>
                          <div>
                            <Button size="icon-xs" variant="outline" onClick={() => updateRegion(selectedRegion)} aria-label={`Focus range ${index + 1}`}>
                              <Focus />
                            </Button>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              onClick={() => setSelectedRegions((current) => current.filter((_, candidateIndex) => candidateIndex !== index))}
                              aria-label={`Remove range ${index + 1}`}
                            >
                              <X />
                            </Button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  <div ref={selectionOverlay} className="region-selection region-selection-draft" aria-hidden="true" />
                </div>
              </div>
              <div ref={pointerGuide} className="pointer-guide" aria-hidden="true">
                <span ref={pointerCoordinate} />
              </div>
              <div
                className={`browser-loading-veil ${isRefreshing ? 'is-visible' : ''}`}
                aria-hidden="true"
              />
            </div>
          </section>

          <EvidenceAgent
            region={region}
            selectedRegions={selectedRegions}
            selection={selection}
            onNavigate={(nextRegion, highlight) => {
              updateRegion(nextRegion)
              if (highlight) setSelectedRegions([highlight])
            }}
            onAddTrack={(trackId) => {
              const track = trackMap.get(trackId)
              if (track) {
                setTracks((current) => current.some((item) => item.id === track.id) ? current : [...current, track])
                setActiveTrackIds((current) => current.includes(trackId) ? current : [...current, trackId])
              }
            }}
            onAddAnnotationTrack={(annotation: AgentAnnotationTrack) => {
              setTracks((current) => current.some((track) => track.id === annotation.track.id)
                ? current
                : [...current, annotation.track])
              setAnnotationFeatures((current) => ({
                ...current,
                [annotation.track.id]: annotation.features,
              }))
              setActiveTrackIds((current) => current.includes(annotation.track.id)
                ? current
                : [...current, annotation.track.id])
            }}
            onClearFeature={() => setSelection(null)}
            onRemoveRegion={(index) => setSelectedRegions((current) => current.filter((_, candidateIndex) => candidateIndex !== index))}
            onClearRegions={() => setSelectedRegions([])}
          />
        </section>
        <GeneDetailDialog
          selection={geneDialogSelection}
          open={geneDialogOpen}
          onOpenChange={setGeneDialogOpen}
          onFocus={(nextRegion, highlight) => {
            updateRegion(nextRegion)
            if (highlight) setSelectedRegions([highlight])
          }}
        />
      </main>
    </TooltipProvider>
  )
}

export default App
