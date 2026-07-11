import { useEffect, useState } from 'react'
import { ArrowUp, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import './App.css'

type Health = {
  status: 'ok'
  service: string
}

function App() {
  const [health, setHealth] = useState<Health | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((response) => {
        if (!response.ok) throw new Error('API unavailable')
        return response.json() as Promise<Health>
      })
      .then(setHealth)
      .catch(() => setHealth(null))
  }, [])

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <span className="brand">Basecase</span>
          <span className="location">hg38 · chr17:43,044,295-43,125,364</span>
        </div>
        <Badge variant="outline" className={`status ${health ? 'connected' : ''}`}>
          {health ? 'API connected' : 'API offline'}
        </Badge>
      </header>

      <section className="workspace">
        <section className="browser-panel" aria-label="Genome browser">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Genome browser</p>
              <h1>BRCA1</h1>
            </div>
            <Button type="button" variant="outline">
              <Plus data-icon="inline-start" />
              Add track
            </Button>
          </div>

          <div className="browser-placeholder">
            <div className="ruler">43.04 Mb&nbsp;&nbsp;&nbsp; 43.08 Mb&nbsp;&nbsp;&nbsp; 43.12 Mb</div>
            <div className="track">
              <span>MANE Select</span>
              <div className="gene-line"><i /><i /><i /><i /><i /></div>
            </div>
            <div className="track muted">
              <span>ClinVar</span>
              <div className="variant-line"><i /><i /><i /></div>
            </div>
          </div>
        </section>

        <aside className="agent-panel" aria-label="Evidence agent">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Evidence workspace</p>
              <h2>Locus brief</h2>
            </div>
          </div>

          <div className="empty-state">
            <p>
              Ask the agent to explain this locus, add evidence tracks, or compare
              another region.
            </p>
          </div>

          <form className="composer" onSubmit={(event) => event.preventDefault()}>
            <label htmlFor="message">Message the evidence agent</label>
            <div>
              <Input
                id="message"
                name="message"
                placeholder="What stands out at this locus?"
                autoComplete="off"
              />
              <Button type="submit" size="icon" aria-label="Send message">
                <ArrowUp />
              </Button>
            </div>
          </form>
        </aside>
      </section>
    </main>
  )
}

export default App
