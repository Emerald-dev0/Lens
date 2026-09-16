# Harbor — the Lens demo application

A small, deliberately dependency-free web app used to exercise and demonstrate Lens.
It is the target for the quick start, the integration tests, the showcase example and
the README screenshots.

## Running it

```bash
npm run demo            # from the Lens repo root → http://127.0.0.1:4173
node fixtures/demo-app/server.mjs
DEMO_PORT=4321 node fixtures/demo-app/server.mjs
```

## What is in it

| Route | Purpose for Lens |
| --- | --- |
| `#/` | Landing page: hero, CTA, feature grid — screenshot/OG material |
| `#/signup` | Multi-field form, validation errors, radio groups — interaction + typing |
| `#/dashboard` | Stats grid, table, **empty state**, modal create-flow |
| `#/projects/<id>` | Tabs, CRUD on records, **loading then ready** async chart |
| `#/settings` | Theme switch, `window.confirm()` danger zone — dialog handling |
| `#/pricing` | Equal-height card grid — responsive reflow checks |
| `/api/metrics?mode=fail` | Returns 500 so `lens network --problems` has something real to report |

## Defect mode

```bash
open http://127.0.0.1:4173/?defects=1
```

Injects deterministic problems the visual reviewer must find: horizontal overflow on a
narrow viewport, text clipped by a fixed-height box, sub-4.5:1 contrast on two text
tokens, and a broken image. `test/e2e/review.e2e.test.ts` asserts each one.

## Data

State lives in `localStorage` under `harbor.v1`. Nothing leaves the browser.
`window.__harbor.reset()` clears it; Lens's demo-data tooling prefers the UI.
