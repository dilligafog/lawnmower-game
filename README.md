# Lawn Pro

A browser lawn-mowing business game: plan the mowing route, then watch the mower drive it.
See [ROADMAP.md](ROADMAP.md) for the development phases.

## Commands

- `npm run dev`: start the dev server
- `npm test`: run unit tests (simulation and scoring)
- `npm run typecheck`: TypeScript check
- `npm run build`: production build into `dist/`

## Layout

- `src/sim/`: pure game logic (no Phaser): geometry, routes, snapping, mowing simulation, scoring
- `src/scenes/`: Phaser scenes and rendering
- `src/ui/`: DOM toolbar, side panel and results card
- `src/state/`: editor state shared between the UI and the scene
- `src/data/yards/`: yard definitions (JSON)

## Controls

Tools: `1` Straight, `2` Curve, `3` Freehand, `4` Stripes, `5` Contour.
`Shift` locks angles to 15°. `Ctrl+Z` / `Ctrl+Y` undo/redo. `Esc` or right-click cancels. `Enter` mows.
