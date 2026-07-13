import { useEffect, useId, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { ArrowRight, Dna, LocateFixed } from 'lucide-react'
import type { GeneSearchResult } from '@/lib/api'
import { searchGenes } from '@/lib/api'
import type { Region } from '@/lib/genome'
import { formatRegion, parseRegion } from '@/lib/genome'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const geneSearchCache = new Map<string, GeneSearchResult[]>()

type LocusSearchProps = {
  region: Region
  onNavigate: (region: Region) => void
}

export function LocusSearch({ region, onNavigate }: LocusSearchProps) {
  const listboxId = useId()
  const [value, setValue] = useState(formatRegion(region))
  const [results, setResults] = useState<GeneSearchResult[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [open, setOpen] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [searchError, setSearchError] = useState(false)

  useEffect(() => {
    setValue(formatRegion(region))
    setResults([])
    setOpen(false)
  }, [region])

  useEffect(() => {
    const query = value.trim()
    setSearchError(false)
    if (query.length < 2 || parseRegion(query, region.assembly)) {
      setResults([])
      setOpen(false)
      return
    }

    const cacheKey = `${region.assembly}:${query.toLocaleUpperCase()}`
    const cachedResults = geneSearchCache.get(cacheKey)
    if (cachedResults) {
      setResults(cachedResults)
      setActiveIndex(0)
      setOpen(true)
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      searchGenes(query, region.assembly, controller.signal)
        .then((response) => {
          geneSearchCache.set(cacheKey, response.results)
          setResults(response.results)
          setActiveIndex(0)
          setOpen(true)
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return
          setResults([])
          setSearchError(true)
          setOpen(true)
        })
    }, 80)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [region.assembly, value])

  function navigateToGene(result: GeneSearchResult) {
    const span = result.end - result.start
    const flank = Math.max(5_000, Math.round(span * 0.15))
    onNavigate({
      assembly: result.assembly,
      chrom: result.chrom,
      start: Math.max(0, result.start - flank),
      end: result.end + flank,
    })
    setOpen(false)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const coordinates = parseRegion(value, region.assembly)
    if (coordinates) {
      onNavigate(coordinates)
      return
    }
    if (results[activeIndex]) {
      navigateToGene(results[activeIndex])
      return
    }
    setInvalid(true)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && open && results[activeIndex]) {
      event.preventDefault()
      navigateToGene(results[activeIndex])
      return
    }
    if (!open || results.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => (current + 1) % results.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => (current - 1 + results.length) % results.length)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <form
      className="locus-search"
      onSubmit={submit}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <LocateFixed />
      <Input
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          setInvalid(false)
          setSearchError(false)
        }}
        onFocus={() => setOpen(results.length > 0)}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? `${listboxId}-${activeIndex}` : undefined}
        aria-invalid={invalid}
        aria-label="Gene or genomic coordinates"
        placeholder="Gene or chr:start-end"
        autoComplete="off"
      />
      <Button
        type="submit"
        size="icon-xs"
        className="locus-submit"
        aria-label="Navigate to locus"
        title="Navigate"
      >
        <ArrowRight />
      </Button>

      {open ? (
        <div className="gene-results" id={listboxId} role="listbox">
          {results.length > 0 ? (
            results.map((result, index) => (
              <button
                key={`${result.id}-${result.chrom}-${result.start}`}
                id={`${listboxId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? 'is-active' : ''}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => navigateToGene(result)}
              >
                <Dna />
                <span>
                  <strong>{result.symbol}</strong>
                  <small>{result.description ?? 'Gene match'}</small>
                </span>
                <span className="gene-result-meta">
                  <Badge variant="secondary">{result.source_track}</Badge>
                  <code>{result.chrom}</code>
                </span>
              </button>
            ))
          ) : searchError ? (
            <p className="gene-results-empty" role="status">Gene search is unavailable. Coordinates still work.</p>
          ) : (
            <p className="gene-results-empty">No matching genes</p>
          )}
        </div>
      ) : null}
      {invalid ? <p className="locus-search-error" role="alert">Enter a gene symbol or chr:start–end.</p> : null}
    </form>
  )
}
