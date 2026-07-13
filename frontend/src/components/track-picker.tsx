import { useEffect, useState } from 'react'
import { Activity, CircleDot, Database, Dna, Layers3, ListPlus, LoaderCircle, Plus } from 'lucide-react'
import type { TrackDefinition, TrackKind } from '@/lib/api'
import { fetchTrackCatalog } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const PAGE_SIZE = 60
const KIND_FILTERS: Array<{ label: string; value: TrackKind | 'all' }> = [
  { label: 'All', value: 'all' },
  { label: 'Genes', value: 'gene' },
  { label: 'Variants', value: 'variant' },
  { label: 'Signals', value: 'signal' },
  { label: 'Regulatory', value: 'regulatory' },
  { label: 'Repeats', value: 'repeat' },
  { label: 'Other', value: 'feature' },
]

type TrackPickerProps = {
  assembly: string
  activeTrackIds: Set<string>
  onToggle: (track: TrackDefinition) => void
  customTracks?: TrackDefinition[]
  compact?: boolean
}

export function TrackPicker({ assembly, activeTrackIds, onToggle, customTracks = [], compact = false }: TrackPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [tracks, setTracks] = useState<TrackDefinition[]>([])
  const [total, setTotal] = useState(0)
  const [kind, setKind] = useState<TrackKind | 'all'>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError(false)
      fetchTrackCatalog(
        assembly,
        {
          query,
          kind: kind === 'all' ? undefined : kind,
          limit: PAGE_SIZE,
        },
        controller.signal,
      )
        .then((catalog) => {
          setTracks(catalog.tracks)
          setTotal(catalog.total)
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return
          setTracks([])
          setTotal(0)
          setError(true)
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, query ? 140 : 0)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [assembly, kind, open, query, retryNonce])

  async function loadMore() {
    if (loading || tracks.length >= total) return
    setLoading(true)
    try {
      const catalog = await fetchTrackCatalog(assembly, {
        query,
        kind: kind === 'all' ? undefined : kind,
        limit: PAGE_SIZE,
        offset: tracks.length,
      })
      setTracks((current) => [
        ...current,
        ...catalog.tracks.filter(
          (track) => !current.some((candidate) => candidate.id === track.id),
        ),
      ])
      setTotal(catalog.total)
    } catch {
      // Keep the current page visible if the next page fails.
    } finally {
      setLoading(false)
    }
  }

  const activeFilter = KIND_FILTERS.find((filter) => filter.value === kind)
  const customMatches = customTracks.filter((track) =>
    (kind === 'all' || track.kind === kind)
    && (!query.trim() || `${track.label} ${track.id} ${track.description} ${track.category}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
  )
  const resultTotal = total + customMatches.length
  const displayedTracks = [
    ...customMatches,
    ...tracks.filter((track) => !customMatches.some((candidate) => candidate.id === track.id)),
  ]
  const resultLabel = loading && displayedTracks.length === 0
    ? 'Searching…'
    : `${resultTotal.toLocaleString()} ${resultTotal === 1 ? 'track' : kind === 'all' ? 'tracks' : `${activeFilter?.label.toLowerCase()} tracks`}`

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            {compact ? (
              <Button type="button" size="icon-sm" variant="ghost" aria-label="Add track">
                <ListPlus />
              </Button>
            ) : (
              <Button type="button" variant="outline">
                <Plus data-icon="inline-start" />
                Add track
              </Button>
            )}
          </DialogTrigger>
        </TooltipTrigger>
        {compact ? <TooltipContent>Add track</TooltipContent> : null}
      </Tooltip>
      <DialogContent className="track-picker-dialog">
        <DialogHeader className="track-picker-header">
          <div className="track-picker-heading">
            <div>
              <DialogTitle>Track catalog</DialogTitle>
              <DialogDescription>UCSC catalog · {assembly}</DialogDescription>
            </div>
            <Badge variant="secondary">{activeTrackIds.size} selected</Badge>
          </div>
        </DialogHeader>
        <Command className="track-picker-command" shouldFilter={false}>
          <div className="track-picker-controls">
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search name, ID, description, or category…"
            />
            <div className="track-picker-filters" aria-label="Filter tracks by type">
              {KIND_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  className={kind === filter.value ? 'is-active' : undefined}
                  onClick={() => setKind(filter.value)}
                  aria-pressed={kind === filter.value}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>
          <div className="track-picker-summary">
            <span>{resultLabel}</span>
            <span>↑↓ navigate · Enter toggle</span>
          </div>
          <CommandList className="track-picker-list">
            {loading && tracks.length === 0 ? (
              <div className="track-picker-loading">
                <LoaderCircle className="animate-spin" /> Searching UCSC
              </div>
            ) : null}
            {error ? (
              <div className="track-picker-error" role="alert">
                <span>The UCSC catalog is unavailable.</span>
                <Button type="button" size="xs" variant="outline" onClick={() => setRetryNonce((current) => current + 1)}>Retry</Button>
              </div>
            ) : null}
            {!loading && !error ? <CommandEmpty>No supported tracks found.</CommandEmpty> : null}
            {displayedTracks.map((track) => {
              const active = activeTrackIds.has(track.id)
              const TrackIcon = trackKindIcon(track.kind)
              return (
                <CommandItem
                  key={track.id}
                  value={track.id}
                  onSelect={() => onToggle(track)}
                  className="track-picker-item"
                  data-checked={active}
                  title={track.description}
                >
                  <TrackIcon />
                  <div className="track-picker-copy">
                    <div className="track-picker-title">
                      <span>{track.label}</span>
                      {track.source_type === 'agent_annotation' ? <Badge variant="outline">Agent</Badge> : null}
                      {kind === 'all' ? <span className="track-picker-kind">{track.kind}</span> : null}
                    </div>
                    <p>{track.description}</p>
                  </div>
                </CommandItem>
              )
            })}
          </CommandList>
          {tracks.length < total ? (
            <div className="track-picker-footer">
              <span>
                Showing {tracks.length.toLocaleString()} of {total.toLocaleString()}
              </span>
              <Button type="button" size="xs" variant="ghost" onClick={loadMore} disabled={loading}>
                {loading ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, total - tracks.length)} more`}
              </Button>
            </div>
          ) : null}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function trackKindIcon(kind: TrackKind) {
  if (kind === 'gene') return Dna
  if (kind === 'variant') return CircleDot
  if (kind === 'signal') return Activity
  if (kind === 'regulatory' || kind === 'repeat') return Layers3
  return Database
}
