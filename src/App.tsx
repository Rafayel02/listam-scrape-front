import { useEffect, useState } from 'react'
import { scrapeEngine } from './scraper/engine'
import { startPeriodicBackendSync, stopPeriodicBackendSync } from './sync/backendSync'
import { ListingsView } from './views/ListingsView'
import { ScraperView } from './views/ScraperView'
import './App.css'

type Tab = 'scraper' | 'listings'

function App() {
  const [tab, setTab] = useState<Tab>('scraper')

  useEffect(() => {
    void scrapeEngine.init()
    startPeriodicBackendSync()
    return () => stopPeriodicBackendSync()
  }, [])

  return (
    <div className="app">
      <header>
        <h1>List.am Scraper</h1>
        <nav>
          <button
            type="button"
            className={tab === 'scraper' ? 'active' : ''}
            onClick={() => setTab('scraper')}
          >
            Scraper
          </button>
          <button
            type="button"
            className={tab === 'listings' ? 'active' : ''}
            onClick={() => setTab('listings')}
          >
            Listings
          </button>
        </nav>
      </header>
      <main>
        {tab === 'scraper' && <ScraperView />}
        {tab === 'listings' && <ListingsView />}
      </main>
    </div>
  )
}

export default App
