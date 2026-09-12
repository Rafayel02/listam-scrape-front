import type { Plugin } from 'vite'
import {
  BrowserProfileLockedError,
  closeBrowser,
  enableScraping,
  endScrapeSession,
  fetchHtmlViaBrowser,
  isBrowserOpen,
  isScrapingEnabled,
  prepareBrowser,
  readCurrentPageHtml,
  scrapeItemPage,
} from './playwrightBrowser.js'

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
  })
}

function sendJson(res: import('node:http').ServerResponse, status: number, data: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

export function listamScraperPlugin(): Plugin {
  return {
    name: 'listam-scraper',
    configureServer(server) {
      const onServerClose = () => {
        void closeBrowser()
      }
      server.httpServer?.on('close', onServerClose)

      server.middlewares.use(async (req, res, next) => {
        try {
          if (!req.url) return next()

          if (req.url === '/api/dev/browser/status') {
            sendJson(res, 200, {
              open: isBrowserOpen(),
              scrapingEnabled: isScrapingEnabled(),
            })
            return
          }

          if (req.url === '/api/dev/browser/prepare' && req.method === 'POST') {
            const body = await readBody(req)
            let url = 'https://www.list.am/category/56/1'
            try {
              const parsed = JSON.parse(body) as { url?: string }
              if (parsed.url) url = parsed.url
            } catch {
              // use default
            }

            try {
              await prepareBrowser(url)
              sendJson(res, 200, { ok: true })
            } catch (err) {
              const message =
                err instanceof BrowserProfileLockedError
                  ? err.message
                  : (err as Error).message
              sendJson(res, 500, { ok: false, message })
            }
            return
          }

          if (req.url === '/api/dev/browser/begin' && req.method === 'POST') {
            try {
              enableScraping()
              sendJson(res, 200, { ok: true })
            } catch (err) {
              sendJson(res, 500, { ok: false, message: (err as Error).message })
            }
            return
          }

          if (req.url === '/api/dev/browser/close' && req.method === 'POST') {
            await endScrapeSession()
            sendJson(res, 200, { ok: true })
            return
          }

          if (req.url === '/api/dev/fetch/current' && req.method === 'POST') {
            const result = await readCurrentPageHtml()
            sendJson(res, 200, result)
            return
          }

          if (req.url === '/api/dev/scrape-item' && req.method === 'POST') {
            const body = await readBody(req)
            let listingId = ''
            try {
              const parsed = JSON.parse(body) as { listingId?: string }
              if (parsed.listingId) listingId = parsed.listingId
            } catch {
              // use default
            }

            if (!listingId) {
              sendJson(res, 400, { ok: false, message: 'listingId is required' })
              return
            }

            try {
              const result = await scrapeItemPage(listingId)
              sendJson(res, 200, result)
            } catch (err) {
              const message =
                err instanceof BrowserProfileLockedError
                  ? err.message
                  : (err as Error).message
              sendJson(res, 500, { ok: false, message })
            }
            return
          }

          if (req.url === '/api/dev/fetch' && req.method === 'POST') {
            const body = await readBody(req)
            let path = '/category/56/1'
            let dedicatedPage = false
            try {
              const parsed = JSON.parse(body) as { path?: string; dedicatedPage?: boolean }
              if (parsed.path) path = parsed.path
              dedicatedPage = parsed.dedicatedPage === true
            } catch {
              // use default
            }

            const result = await fetchHtmlViaBrowser(path, { dedicatedPage })
            sendJson(res, 200, result)
            return
          }

          next()
        } catch (err) {
          console.error('[listam-scraper]', err)
          if (!res.headersSent) {
            sendJson(res, 500, { ok: false, message: (err as Error).message })
          }
        }
      })

      return onServerClose
    },
  }
}
