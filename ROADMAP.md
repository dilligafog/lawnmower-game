# Lawn Mowing Idle Game — Development Phases

## Context
New browser game, starting from an empty repo (`/home/bustabook/lawnmower-game`). The player runs a lawn mowing business that starts with their own yard and grows to neighbors and beyond. The core mechanic is that the player **plans the mowing route** on a top-down yard map and the mower then drives it automatically. A faster, cleaner route earns more profit and better customer satisfaction, which unlocks growth. Equipment upgrades improve speed and quality. The idle layer comes from **saved routes plus hired crews** that re-mow recurring customers, including while the player is away.

**Decisions so far**
- Stack: **Phaser 3 + TypeScript + Vite**, deployed as a static site.
- Idle model: a route drawn once is saved per yard. Crews replay saved routes on a schedule and earn offline. Redrawing a route improves its score.
- Path input: **city-builder-style road tools**. The player picks a segment type (straight, curve/arc, freehand) and the game fits and smooths it to the map. This handles both rounded obstacles (trees, round beds) and sharp V-shaped landscaping.

## Core model (shared by all phases)
- **Yard** = a grass coverage grid at fine resolution (e.g. 4–8 px cells) plus obstacle polygons and circles plus metadata (customer, pay, grass height, special rules).
- **Route** = an ordered list of segments (`line | arc | freehand-spline`), each sampled into a polyline.
- **Mower** = deck width, top speed, turning radius, accel/turn slowdown, and any modifiers such as a bagger or trimmer.
- **Simulation** = the mower follows the sampled polyline. Each tick it stamps its deck footprint onto the coverage grid. Tight turns slow it down, so straight stripes are rewarded naturally. Hitting an obstacle causes a penalty or damage.
- **Job score** = coverage %, time taken, overlap/waste, damage, and stripe neatness. Together these give **pay** and **satisfaction**.

---

## Phase 0 — Project scaffold ✅
- Vite + TS + Phaser 3, ESLint/Prettier, Vitest for pure logic.
- Folder layout: `src/scenes/`, `src/sim/` (pure, Phaser-free logic), `src/data/yards/`, `src/ui/`, `src/state/`.
- Keep the simulation and scoring in `src/sim/` with no Phaser imports, so they can be unit-tested and reused for offline/crew calculations.

**Done when:** `npm run dev` shows a blank Phaser scene and `npm test` runs.

## Phase 1 — Core mowing prototype (the "is it fun?" test) ✅ (needs playtesting)
One hardcoded yard (your own yard), one mower, no economy.
- **Drawing tools** (toolbar): Straight, Curve (3-point arc / bezier), Freehand (smoothed with Catmull-Rom). Segments chain from the end of the previous one. Snap to the grid and to obstacle edges. Undo/redo.
- **Route preview:** show the deck-width swath ghosted along the path, with live estimates of coverage % and time before you press Go.
- **Playback:** the mower drives the route, grass changes from tall to cut, and alternating directions leave stripe shading. Speed controls 1x/2x/4x.
- **Results screen:** coverage %, time, missed spots highlighted, overlap heatmap.

**Done when:** you can draw a route around a round tree and a V-shaped bed, watch it mow, and see a score that clearly rewards the better route. Playtest this heavily before moving on; it is the heart of the game.

### Playtest round 1 (done)
- Choose your own start point on any pavement (driveway, sidewalk, street; parking lots later).
- More forgiving snapping: corner snap points, horizontal/vertical alignment with the last point, bigger radii, visible guides.
- Contour tool replaced by **Edge**: freehand that sticks to edges and lets go when you pull away. Pinched spots (the inside of a V bed, lot corners) stay uncut on purpose; they're for the trimmer.
- Surroundings: street, sidewalk, neighbors' lawns in a different shade, a dashed property line. Driving onto a neighbor's lawn counts as an incident.

## Phase 2 — Yard content & challenges
- Yard data format: JSON, or Tiled map editor export. Fields: size, grass areas, obstacles, start point (driveway/gate), customer info.
- Obstacle and challenge types: round trees, V-shaped and curved landscape beds (damage penalty), fences and narrow gates (a mower can't get under a fence but grass still grows, so fence lines need edging), slopes (slower), thick or wet grass patches (slower or a second pass needed), toys and hoses (must be avoided), flower beds (high satisfaction penalty), a dog in the yard (moving obstacle, later).
- Build 6–10 handcrafted yards that teach one challenge each, increasing in difficulty.

**Done when:** yards load from data files and each challenge measurably affects score.

## Phase 3 — Business loop & persistence
- Money, customer satisfaction per client, and an overall **reputation**.
- Job board/map: your yard, then the neighbors unlock based on reputation or referrals.
- Pay formula: base rate × yard size × satisfaction multiplier, plus a speed bonus.
- Save/load to `localStorage`, with a versioned save schema.

**Done when:** a full loop works: mow → get paid → reputation rises → a new yard unlocks. The game survives a page refresh.

## Phase 4 — Equipment upgrades
Upgrades change the simulation itself, not just a number:
- Deck width (fewer passes), engine (top speed), **zero-turn mower** (tight turning radius, which changes the best route shapes), bagger (satisfaction), string trimmer/edger (cleans edge cells near obstacles), mulching kit, fuel/battery capacity, trailer (travel time between jobs).
- **Trimmer / edging pass:** after mowing, trim the cells the deck can't reach (along fences, in pinched corners like the inside of a V bed). Costs time, raises customer satisfaction. Score those "trim cells" separately from mowable coverage.
- Shop UI with tiered upgrades.

**Done when:** buying an upgrade visibly changes both how the mower behaves and which route is optimal.

## Phase 5 — Idle layer: saved routes, recurring customers, crews
- Grass regrows on a timer, so customers need recurring service (e.g. weekly).
- A saved route per yard records its best score.
- Hire crews and assign them to customers. Crews replay saved routes using headless `src/sim/` (or a cached score) on a schedule.
- Offline progress: on return, calculate elapsed jobs and show a "while you were away" summary. Cap the earnings.
- Crew stats: skill and equipment tier affect execution quality.

**Done when:** you can close the tab, come back, and have earned money from crews mowing saved routes.

## Phase 6 — Growth & progression
- Areas that open over time: your street, then the neighborhood, then suburbs, then commercial lots, parks, golf course, and estates. Bigger and odder maps.
- Business upgrades: office, more crew slots, marketing (more customer leads), equipment fleet.
- Optional: a prestige/franchise reset for the long-term idle loop.
- Events: rain days, HOA inspections, rush jobs.

## Phase 7 — Polish & ship
- Art pass (sprites, stripe shaders, clipping particles), sound, juice.
- Mobile/touch support for drawing.
- Balance pass with a spreadsheet or sim script that uses the headless sim.
- Tutorial and onboarding in your own yard.
- Deploy as a static site (GitHub Pages / Netlify / Itch.io).

---

## Verification approach (every phase)
- **Unit tests (Vitest)** on `src/sim/`: segment sampling, coverage stamping, turn-speed model, scoring, offline calculation.
- **Manual playtest** in `npm run dev` against each phase's "Done when" criteria.
- From Phase 3 onward: test that saves still load after any schema change (migration).

## Suggested next step
Start with **Phase 0 + Phase 1** together. The drawing tools and coverage scoring prove whether the core idea is fun, and everything else builds on top of them.
