# Royal Dam ERP workspace

## Edit here

- `royal-dam-erp-updated.html` — desktop UI source.
- `royal-dam-api/src/` — active Node/Express API source.
- `royal-dam-api/scripts/` — API tests and maintenance scripts.
- `royal-dam-desktop/services/` — desktop service source copied from the API service layer.
- `royal-dam-desktop/main.js`, `preload.js`, `scripts/` — Electron shell and build scripts.

## Generated files

- `royal-dam-desktop/index.html`
- `royal-dam-desktop/renderer/index.html`
- `royal-dam-desktop/local-api.mjs`

Regenerate these with `npm run prepare-renderer` and `npm run prepare-api`; do not edit them manually.

## Build and archive boundaries

- `royal-dam-desktop/dist/` — current installer output only.
- `_archive/` — recoverable old installers and historical build artifacts.
- `royal-dam-desktop/.royal-dam-data/` — offline application data; preserve it.
- `node_modules/` — dependencies; do not edit or clean manually.

## Project support folders

- `assets/` — reusable assets.
- `docs/` — project documentation.
- `tmp/` and `outputs/` — workspace tooling artifacts; not application source.
