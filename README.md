# Australian FIRE Calculator

A calculator for planning early retirement in Australia, built with actual tax and superannuation rules instead of generic assumptions.

Most FIRE calculators are American and don't handle things like super guarantee, concessional contribution caps, or our marginal tax brackets. This one does, using FY 2025-26 rates.

## What it does

- Projects your path to Lean, Coast, Barista, or Full FIRE
- Models income tax and super contributions together, including salary sacrifice and HECS/HELP repayments
- Lets you plan as a single person or a couple
- Charts your balance over time so you can see the effect of changing an input
- Generates a shareable link that encodes your inputs, so you can send someone your exact scenario
- Works fully offline after the first load, no backend, no accounts, no data leaving your browser

## Running it locally

It's a static site, so there's no build step. Pick whichever you prefer:

```bash
# just open it
open index.html

# or serve it with any static server
python3 -m http.server 8080
```

Or with Docker:

```bash
docker compose up
```

This serves the app on port 8181 via nginx.

## Deploying

There's a `vercel.json` already set up with sensible caching and security headers, so pushing this to Vercel should work out of the box.

## Stack

Plain HTML, CSS and JavaScript. Charts are done with Chart.js loaded from a CDN. No frameworks, no npm install, no build tooling.

## Disclaimer

This tool is for personal planning and education. It is not financial advice, and tax and super rules change often, so double check anything important with a professional or the ATO before making decisions based on it.
