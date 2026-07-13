const { chromium } = require('playwright')
const fs = require('node:fs/promises')
const path = require('node:path')

const cards = [
  {
    name: 'intro',
    eyebrow: 'BASECASE',
    title: 'From question to genomic evidence',
    subtitle: 'A focused, inspectable research workflow',
  },
  {
    name: 'outro',
    eyebrow: 'BASECASE',
    title: 'Ask. Inspect. Focus. Annotate.',
    subtitle: 'Every answer stays connected to the genome and its evidence.',
  },
]

async function main() {
  const output = path.join(__dirname, 'cards')
  await fs.mkdir(output, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })

  for (const card of cards) {
    await page.setContent(`<!doctype html><html><head><style>
      * { box-sizing: border-box; }
      html, body { width: 1600px; height: 900px; margin: 0; overflow: hidden; }
      body {
        display: grid; place-items: center; color: #f8fafc;
        background:
          radial-gradient(circle at 74% 22%, rgba(79, 115, 132, .22), transparent 33%),
          linear-gradient(135deg, #102732 0%, #0b1c25 56%, #07151d 100%);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif;
      }
      .grid { position: absolute; inset: 0; opacity: .12; background-image: linear-gradient(rgba(255,255,255,.09) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.09) 1px, transparent 1px); background-size: 80px 80px; mask-image: linear-gradient(to bottom, transparent, #000 30%, #000 70%, transparent); }
      .locus { position: absolute; left: 9%; right: 9%; top: 22%; height: 1px; background: rgba(180, 207, 218, .24); }
      .locus:before, .locus:after { content: ""; position: absolute; top: -5px; width: 1px; height: 11px; background: rgba(180,207,218,.5); }
      .locus:before { left: 22%; } .locus:after { right: 17%; }
      main { width: 1240px; position: relative; z-index: 1; transform: translateY(16px); }
      .eyebrow { display: flex; align-items: center; gap: 14px; margin-bottom: 34px; color: #a9c3ce; font-size: 20px; font-weight: 700; letter-spacing: .22em; }
      .mark { width: 30px; height: 30px; border: 1px solid #7fa1b0; border-radius: 8px; display: grid; place-items: center; }
      .mark:before { content: ""; width: 10px; height: 10px; border: 2px solid #a9c3ce; border-radius: 50%; box-shadow: 7px 0 0 -3px #a9c3ce, -7px 0 0 -3px #a9c3ce; }
      h1 { max-width: 1160px; margin: 0; font-size: 76px; line-height: 1.05; letter-spacing: -.045em; font-weight: 650; }
      p { margin: 34px 0 0; color: #a9bbc4; font-size: 29px; line-height: 1.45; letter-spacing: -.01em; }
      .rule { width: 92px; height: 3px; margin-top: 54px; background: #8fb1be; border-radius: 2px; }
    </style></head><body><div class="grid"></div><div class="locus"></div><main><div class="eyebrow"><span class="mark"></span>${card.eyebrow}</div><h1>${card.title}</h1><p>${card.subtitle}</p><div class="rule"></div></main></body></html>`)
    await page.screenshot({ path: path.join(output, `${card.name}.png`) })
  }
  await browser.close()
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
