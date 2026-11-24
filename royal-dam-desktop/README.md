# Royal Dam Desktop

## Edit the app

- Edit the UI in the root file: `../royal-dam-erp-updated.html`.
- Run `npm run start` to copy the UI and local API, then open Electron.
- Run `npm run dist` to create the Windows installer in `dist/`.
- The current installer is generated in `dist/منظومة-السد-الملكي-Setup-${version}.exe`.

## Folder guide

- `main.js`, `preload.js`: Electron shell and secure bridge.
- `scripts/`: build-time copy scripts.
- `services/`: local quantity-takeoff services.
- `build/`: application icons used by Electron and Windows.
- `dist/`: current build output only; old builds belong in the root `_archive/` folder.
- `node_modules/`: installed dependencies; do not edit manually.
- `.royal-dam-data/`: local offline data; keep it if you need the desktop data.

`index.html`, `renderer/index.html`, and `local-api.mjs` are generated copies used by the desktop build. Edit their source files instead of editing these copies manually.
