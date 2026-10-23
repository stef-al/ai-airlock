# AI Airlock

Strip sensitive data from text, code, config files and logs **before** pasting into an AI chatbot, completely offline. Paste the AI's reply back to put the real values in again.

**Flow:** paste or drop files → detection → review highlights → *Copy masked* … later: paste the reply → *Restore* → *Copy restored*.

Original values and the placeholder mapping live only in the browser tab's memory. There is no backend and no network access; a strict Content-Security-Policy makes the browser refuse any outgoing request.

Download `dist/airlock.html` (or open the GitHub Pages site) and open it in a browser. It is a single self-contained file and works from disk or a shared drive.

(Full README: what it detects, honest limits, privacy design and how to add a detector: see the final documentation commit.)

## Develop
`npm ci`, then `npm test`, `npm run metrics`, `npm run build` (writes `dist/airlock.html`), `npm run smoke`.
See `CLAUDE.md` for the architecture.
