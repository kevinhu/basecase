export type Region = {
  assembly: string
  chrom: string
  start: number
  end: number
}

export const BRCA1_REGION: Region = {
  assembly: 'hg38',
  chrom: 'chr17',
  start: 43_042_000,
  end: 43_128_000,
}

export function formatCoordinate(value: number): string {
  return new Intl.NumberFormat('en-US').format(value + 1)
}

export function formatRegion(region: Region): string {
  return `${region.chrom}:${formatCoordinate(region.start)}-${formatCoordinate(region.end - 1)}`
}

export function formatSpan(span: number): string {
  if (span >= 1_000_000) return `${(span / 1_000_000).toFixed(1)} Mb`
  if (span >= 1_000) return `${Math.round(span / 1_000)} kb`
  return `${span} bp`
}

export function parseRegion(value: string, assembly: string): Region | null {
  const match = value.trim().replaceAll(',', '').match(/^(chr[^:]+):(\d+)-(\d+)$/i)
  if (!match) return null
  const start = Number(match[2]) - 1
  const end = Number(match[3])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    return null
  }
  return { assembly, chrom: match[1], start, end }
}

export function zoomRegion(region: Region, factor: number): Region {
  const midpoint = (region.start + region.end) / 2
  const nextSpan = Math.max(20, Math.round((region.end - region.start) * factor))
  const start = Math.max(0, Math.round(midpoint - nextSpan / 2))
  return { ...region, start, end: start + nextSpan }
}

export function panRegion(region: Region, fraction: number): Region {
  const span = region.end - region.start
  const shift = Math.round(span * fraction)
  const start = Math.max(0, region.start + shift)
  return { ...region, start, end: start + span }
}

export function bufferRegion(region: Region, factor: number): Region {
  const viewportSpan = region.end - region.start
  const bufferedSpan = Math.min(5_000_000, Math.max(viewportSpan, Math.round(viewportSpan * factor)))
  const midpoint = (region.start + region.end) / 2
  const start = Math.max(0, Math.round(midpoint - bufferedSpan / 2))
  return { ...region, start, end: start + bufferedSpan }
}

export function bufferCoversViewport(
  buffer: Pick<Region, 'start' | 'end'>,
  viewport: Pick<Region, 'start' | 'end'>,
): boolean {
  const viewportSpan = viewport.end - viewport.start
  const spare = Math.max(0, buffer.end - buffer.start - viewportSpan)
  const guard = Math.min(viewportSpan * 0.15, spare * 0.2)
  return viewport.start >= buffer.start + guard && viewport.end <= buffer.end - guard
}

export function ticks(region: Region, count = 5): number[] {
  const span = Math.max(0, region.end - region.start - 1)
  return Array.from({ length: count }, (_, index) =>
    Math.round(region.start + (span * index) / (count - 1)),
  )
}

export function scaleBar(span: number, targetFraction = 0.18): { bases: number; widthPercent: number } {
  const rough = Math.max(1, span * targetFraction)
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const multiplier = [1, 2, 5, 10].filter((value) => value * magnitude <= rough).at(-1) ?? 1
  const bases = multiplier * magnitude
  return { bases, widthPercent: (bases / span) * 100 }
}
