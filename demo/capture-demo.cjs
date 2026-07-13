const { chromium } = require('playwright')
const fs = require('node:fs/promises')
const path = require('node:path')

const outputDir = path.join(__dirname, 'captures')
const target = path.join(outputDir, 'basecase-demo-raw.webm')

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function move(page, x, y, steps = 18) {
  await page.mouse.move(x, y, { steps })
}

async function typePrompt(page, prompt) {
  const composer = page.locator('#message')
  const box = await composer.boundingBox()
  if (box) await move(page, box.x + 140, box.y + box.height / 2)
  await composer.click()
  await composer.pressSequentially(prompt, { delay: 20 })
  await pause(800)
  await composer.press('Enter')
}

async function waitForAnswer(page, previousCount = 0) {
  await page.locator('.agent-answer').nth(previousCount).waitFor({ timeout: 120_000 })
  await pause(3_000)
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true })
  await fs.rm(target, { force: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    recordVideo: { dir: outputDir, size: { width: 1600, height: 900 } },
  })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      errors.push(message.text())
    }
  })

  await page.goto('http://localhost:5174/', { waitUntil: 'networkidle' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'networkidle' })
  await page.evaluate(() => {
    const cursor = document.createElement('div')
    cursor.id = 'demo-cursor'
    Object.assign(cursor.style, {
      position: 'fixed', zIndex: '99999', width: '18px', height: '18px',
      border: '2px solid rgba(32, 55, 70, .82)', borderRadius: '50%',
      background: 'rgba(255,255,255,.72)', boxShadow: '0 2px 8px rgba(20,30,40,.2)',
      pointerEvents: 'none', transform: 'translate(-50%, -50%)', left: '50%', top: '50%',
      transition: 'width 100ms ease, height 100ms ease, background 100ms ease',
    })
    window.addEventListener('mousemove', (event) => {
      cursor.style.left = `${event.clientX}px`
      cursor.style.top = `${event.clientY}px`
    }, true)
    window.addEventListener('mousedown', () => {
      cursor.style.width = '13px'; cursor.style.height = '13px'; cursor.style.background = 'rgba(100,116,139,.32)'
    }, true)
    window.addEventListener('mouseup', () => {
      cursor.style.width = '18px'; cursor.style.height = '18px'; cursor.style.background = 'rgba(255,255,255,.72)'
    }, true)
    document.body.append(cursor)
  })

  // Establish the workspace and the relationship between browser and agent.
  await move(page, 500, 110)
  console.log('scene: workspace')
  await pause(4_000)
  await move(page, 1_320, 180)
  await pause(4_000)

  // Disease question and ranked gene loci.
  await typePrompt(page, 'Genes related to hypertrophic cardiomyopathy')
  console.log('scene: disease query')
  await pause(2_500)
  await waitForAnswer(page, 0)
  await pause(5_000)
  const myh7 = page.getByRole('button', { name: /Open MYH7 at/i }).first()
  if (await myh7.count()) {
    const box = await myh7.boundingBox()
    if (box) await move(page, box.x + box.width * .55, box.y + box.height / 2)
    await myh7.click()
    await pause(5_000)
  }

  // Attach two ranges without moving, then show their explicit context chips.
  const ruler = page.locator('.ruler-scale')
  const rulerBox = await ruler.boundingBox()
  if (rulerBox) {
    for (const [from, to] of [[.18, .31], [.52, .69]]) {
      await page.keyboard.down('Shift')
      await move(page, rulerBox.x + rulerBox.width * from, rulerBox.y + 20)
      await page.mouse.down()
      await move(page, rulerBox.x + rulerBox.width * to, rulerBox.y + 20, 28)
      await page.mouse.up()
      await page.keyboard.up('Shift')
      await pause(2_000)
    }
  }
  await move(page, 1_340, 76)
  console.log('scene: multi-range context')
  await pause(5_000)

  // Variant plus regulatory context query.
  await page.locator('.agent-new-thread').click()
  await typePrompt(page, 'rs334 nearby enhancers in blood cells')
  console.log('scene: regulatory query')
  await pause(2_500)
  await waitForAnswer(page, 0)
  const trackDisclosure = page.locator('.agent-track-actions summary')
  if (await trackDisclosure.count()) {
    const box = await trackDisclosure.boundingBox()
    if (box) await move(page, box.x + 150, box.y + box.height / 2)
    await trackDisclosure.click()
    await pause(5_000)
  }

  // Exact VCF anchor and surrounding context.
  await page.locator('.agent-new-thread').click()
  await typePrompt(page, 'Show me the evidence around this VCF row: chr11 5227002 rs334 A T')
  console.log('scene: VCF anchor')
  await pause(2_500)
  await waitForAnswer(page, 0)
  const anchor = page.locator('.agent-query-anchor')
  if (await anchor.count()) {
    const box = await anchor.boundingBox()
    if (box) await move(page, box.x + box.width * .55, box.y + box.height / 2)
    await pause(2_000)
    await anchor.click()
    await pause(5_000)
  }

  // Create a browser annotation from the grounded result.
  const addAnnotations = page.getByRole('button', { name: 'Add annotations as track' })
  if (await addAnnotations.count()) {
    const box = await addAnnotations.boundingBox()
    if (box) await move(page, box.x + box.width / 2, box.y + box.height / 2)
    await addAnnotations.click()
    await pause(5_000)
  }
  console.log('scene: annotation track')
  await page.reload({ waitUntil: 'networkidle' })
  await pause(6_000)
  await move(page, 600, 690)
  await pause(5_000)

  const video = page.video()
  await context.close()
  if (!video) throw new Error('Playwright did not create a video')
  await video.saveAs(target)
  await browser.close()

  console.log(JSON.stringify({ target, errors: [...new Set(errors)] }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
