const fs = require('node:fs')
const path = require('node:path')

const clauses = [
  'Genomic research rarely begins with a coordinate.',
  'It begins with a question.',
  'Basecase turns that question into a focused, inspectable evidence workflow.',
  'On the left is a genome browser with genes, clinical variants, regulatory elements, population frequency, and conservation.',
  'On the right is an evidence agent that understands both the question and the exact genomic context currently attached to it.',
  'Start with a disease-level prompt: which genes are related to hypertrophic cardiomyopathy?',
  'The agent translates the request into a genomic plan, gathers grounded evidence,',
  'and streams a concise reasoning summary before the answer.',
  'Instead of returning a wall of text, it ranks linked genes and makes the important next actions obvious.',
  'Open MYH7, and the browser moves to the gene while preserving the precise locus as a visible selection.',
  'The answer is not a dead end.',
  'Every gene, variant, feature, and range can take you back into the evidence.',
  'You can also select context directly.',
  'Shift-drag across the ruler to attach a range without immediately moving the viewport.',
  'Add a second range, compare them together, remove either one, or use its focus control when you are ready.',
  'The context chips above the conversation always show exactly what the next question will use.',
  'Queries can be much more specific.',
  'Ask for nearby enhancers around rs334 in blood cells.',
  'Basecase resolves the variant, searches relevant regulatory evidence,',
  'and groups optional browser tracks separately from the primary action, so the interface stays focused.',
  'For a VCF row, the exact allele is treated as the query anchor,',
  'while the wider window is clearly labeled as surrounding context.',
  'Selecting the anchor opens the locus and marks the precise base,',
  'even when the underlying ClinVar or population track is displayed as density.',
  'Finally, the agent can write its grounded result back into the browser as an annotation track.',
  'Those annotations remain available after reload and can be managed like any other track.',
  'Basecase creates a tight loop between asking, inspecting, focusing, comparing, and annotating—',
  'so every answer stays connected to the genome and to its evidence.',
]

const start = 2
const end = 148
const totalWords = clauses.reduce((sum, clause) => sum + clause.split(/\s+/).length, 0)
let cursor = start

function timestamp(seconds) {
  const millis = Math.round(seconds * 1000)
  const hours = Math.floor(millis / 3_600_000)
  const minutes = Math.floor((millis % 3_600_000) / 60_000)
  const secs = Math.floor((millis % 60_000) / 1000)
  const ms = millis % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

const cues = clauses.map((clause, index) => {
  const words = clause.split(/\s+/).length
  const next = index === clauses.length - 1 ? end : cursor + (words / totalWords) * (end - start)
  const cue = `${index + 1}\n${timestamp(cursor)} --> ${timestamp(next)}\n${clause}\n`
  cursor = next
  return cue
})

fs.writeFileSync(path.join(__dirname, 'Basecase-demo-2m30s.srt'), cues.join('\n'))
