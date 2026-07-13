const { chromium } = require('playwright')
const fs = require('node:fs/promises')
const path = require('node:path')

const outputDir = path.join(__dirname, 'captures')
const target = path.join(outputDir, 'basecase-annotation-persist.webm')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  await fs.mkdir(outputDir, { recursive: true })
  await fs.rm(target, { force: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    recordVideo: { dir: outputDir, size: { width: 1600, height: 900 } },
  })
  const page = await context.newPage()
  await page.goto('http://localhost:5174/', { waitUntil: 'networkidle' })
  await page.evaluate(() => {
    const trackId = 'agent-demo-brca1-evidence'
    localStorage.setItem('basecase-agent-annotations-v1', JSON.stringify([{
      active: true,
      track: {
        id: trackId,
        assembly: 'hg38',
        label: 'Agent · BRCA1 evidence',
        description: 'Grounded annotations created from the agent response.',
        category: 'Agent annotations',
        kind: 'variant',
        source_type: 'agent_annotation',
        source_url: null,
        data_version: null,
        default_visible: false,
        default_rank: null,
      },
      features: [
        { id: `${trackId}:1`, track_id: trackId, assembly: 'hg38', chrom: 'chr17', start: 43045628, end: 43045629, label: 'ClinVar · pathogenic', strand: null, score: null, value: null, source_url: null, attributes: { annotation_kind: 'variant' } },
        { id: `${trackId}:2`, track_id: trackId, assembly: 'hg38', chrom: 'chr17', start: 43057050, end: 43057051, label: 'Promoter evidence', strand: null, score: null, value: null, source_url: null, attributes: { annotation_kind: 'regulatory' } },
        { id: `${trackId}:3`, track_id: trackId, assembly: 'hg38', chrom: 'chr17', start: 43104120, end: 43104121, label: 'Linked evidence', strand: null, score: null, value: null, source_url: null, attributes: { annotation_kind: 'variant' } },
      ],
    }]))
  })
  await page.reload({ waitUntil: 'networkidle' })
  await pause(4_000)
  await page.locator('.browser-panel').evaluate((element) => {
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  })
  await pause(2_500)
  const annotation = page.locator('.genome-track-annotation')
  await annotation.waitFor({ timeout: 30_000 })
  const box = await annotation.boundingBox()
  if (box) {
    await page.mouse.move(box.x + Math.min(480, box.width * .58), box.y + box.height / 2, { steps: 28 })
  }
  await pause(7_000)

  const video = page.video()
  await context.close()
  if (!video) throw new Error('Playwright did not create a video')
  await video.saveAs(target)
  await browser.close()
  console.log(target)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
