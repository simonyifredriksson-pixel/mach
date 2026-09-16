# VELOCITY RONIN

**Speed is damage.**

A high-speed 3D multiplayer katana game. Sprint, grapple, intercept.

```
DAMAGE = SPEED × 0.5          MAX SPEED 500          MAX HEALTH 250
```

| Speed | Damage | | Speed | Damage |
|------:|-------:|-|------:|-------:|
| 50  | 25  | | 300 | 150 |
| 100 | 50  | | 400 | 200 |
| 200 | 100 | | 500 | **250 — one shot** |

## The catch

Going faster does not simply make you better. It makes you **more dangerous and
less able to use it**:

1. **Steering collapses with speed.** At a walk you can reverse direction inside
   a tick (~690°/s). At 500 you get 66°/s — a 400-unit turning circle. Carving
   also scrubs momentum, so the moment you try to correct, you slow down (and
   then you *can* turn).
2. **The blade arc narrows with speed.** 150° and 36 units of reach at a walk;
   a 48° sliver at 27 units at 500 — and you cross that window in ~70 ms. The
   reticle *is* that arc. Watch it close as you accelerate.
3. **Missing costs you.** A whiff drops steering to 30% and doubles friction for
   half a second. At 400 speed that is 200 units of being a target.

A disciplined player at 200 beats a careless one at 450. That is the point.

## Movement

Movement is the game, not a way to reach the game.

- **Progressive acceleration.** ~2.5–3.5 s from a walk to 500 on a clean
  straight, and the last 50 units take almost a second. Top speed is earned.
- **Momentum is real.** Speed carries through jumps, landings, slopes and
  grapple releases. Ramps and the hill road feed gravity into your velocity —
  downhill is free damage.
- **Air control shapes, it does not reverse.** A lateral nudge lets you thread a
  gap or line up a landing; it will never turn a 400-speed commitment around.
- **No foot skating.** Stride frequency is derived from ground speed ÷ stride
  length, and stride length grows with speed — at 500 the ronin is taking
  6.5-metre bounds at ~7 Hz, not running a 20 Hz cycle on the spot.
- **Nothing snaps.** Every animation state is a *weight*, not a switch. Idle,
  walk, sprint, blitz, rise, fall and grapple all blend continuously into one
  pose, which is then damped again. There is no frame where the character pops.

### Parkour

The environment is the fastest route through the map, and every technique
below **redirects** your velocity rather than resetting it.

- **Wall-run** — jump alongside any vertical surface above 145 speed and you
  stick to it. Gravity drops to 14% and ramps back over ~1.5 s, so a wall-run is
  an arc with a natural end. You can still accelerate along the wall. The camera
  rolls 13° toward the surface and the whole body rotates onto it.
- **Wall-kick** — jump off. The along-wall component of your run is kept (and
  nudged up 4%), then out and up are added. Kick off a wall at 380 and you leave
  at 380, pointed somewhere new.
- **Wall-climb** — run at a wall head-on in the air holding forward and you run
  *up* it for up to 0.55 s. Height is paid for in horizontal speed.
- **Ledge vault** — ledges up to 46 units high are flowed over automatically at
  speed. You get exactly enough lift to clear the lip and lose nothing forward.
  This is the single biggest reason the movement never feels interrupted.
- **Slide** — hold `CTRL` above 150 speed. Friction drops to 11%, downhill
  slides accelerate hard, uphill kills them. Jumping out of a slide keeps
  everything. Measured: a 2-second slide ends at 279 speed where coasting ends
  at 0.

You cannot ladder a single wall: re-attaching to the same surface is locked out
for 0.45 s after you leave it.

### Grappling hook — `G`

The hook is a physical object, never a teleport.

- Aim and press **G**. The head visibly flies out at 2100 u/s; the reticle badge
  lights up when there is something in front of you to catch.
- On contact the rope becomes a real constraint: a reel acceleration hauls you
  along it, and the rope length clamps your distance — so anything sideways
  becomes a **swing**. Gravity keeps working, so the arc accelerates like a
  pendulum.
- **G** again releases. You keep your momentum, plus a small kick.
- Arriving at the anchor pops you up over the lip instead of into the wall, so
  roof-to-roof chaining works.

### The chain

Everything above is one continuous velocity. This is a real run, measured in
the client:

```
sprint 235 → jump → WALL-RUN at 362 → wall-kick → airborne
           → grapple → SWING at 496 → release → land at 440 → sprint
```

Nothing in that sequence resets your speed. 496 on the swing is 248 damage —
one connect from a kill.

## Play

Open `index.html` from any web server (ES modules, so `file://` will not work):

```bash
npx serve .          # or: python -m http.server 8080
```

Solo play spawns bots and runs the **same authoritative simulation** in the
page — the identical authority, with zero latency.

### Controls

| | |
|---|---|
| `W A S D` | Move |
| `SHIFT` | Sprint — hold it, there is no stamina |
| `SPACE` | Jump · wall-kick while on a wall |
| `CTRL` / `C` | Slide |
| `G` | Fire grapple / release |
| `LMB` | Slash. From the sheath it becomes an **iai** draw-cut |
| `R` / `RMB` | Draw / sheathe |
| `TAB` | Stat screen |
| `ESC` | Pause |

## Readability over spectacle

Sprinting must never be uncomfortable to look at. There is deliberately **no
chromatic aberration, no speed-scaled film grain, no screen noise and no ambient
camera shake at any speed**. Speed is sold with:

- a smooth FOV curve and a boom that breathes with your throttle
- crisp directional speed lines, held outside the centre 40% of the frame
- a gentle edge streak that only appears past ~300 and never touches the middle
- world-space wind, ground wake and character trails
- a forward lean that builds with velocity

The centre of the screen — where the enemy, your blade and your cable live —
stays sharp at 500.

The camera only moves for *events*: acceleration, landing, carving, grappling,
and one special case below. Every response is enveloped or critically damped, so
the frame always returns exactly to neutral.

### High-speed impact

Connect above **350** speed and the attacker's camera takes a single controlled
punch — a two-tone ring on one fixed axis that peaks immediately and settles
smoothly over **exactly 0.30 s**, scaled by tier:

| Attacker speed | Shake |
|---|---|
| ≤ 350 | none |
| 351–400 | strong (~1.9°) |
| 401–475 | very strong (~2.9°) |
| 476–500 | extremely powerful (~4.0°) |

Only the player who landed the hit feels it. It never stacks, and it returns the
camera to precisely its previous state (verified to 1e-10). It comes with a
sharper impact sound, a brief FOV kick, a 55 ms render-only hit-stop and a
directional spark cone — the simulation itself never pauses.

## Multiplayer

The server is authoritative. Clients send **inputs only**; positions, speed, hit
registration, damage, health, kills, credits and grapple state are all decided
server-side.

```bash
npm install
npm run server                 # ws://localhost:8787
```

Then open the client with `index.html?server=ws://localhost:8787`.
Options: `PORT`, `BOTS`, `MAX_PLAYERS`, `SEED`.

- 60 Hz fixed simulation, 30 Hz snapshots.
- The client predicts movement, combat and the grapple with the exact modules
  the server runs (`src/shared/`), then reconciles by replaying unacknowledged
  inputs. Correction error is bled off smoothly instead of snapping.
- Remote players render 100 ms behind the server clock and are interpolated.
- Hit registration is **lag compensated**: when a blade goes active the server
  rewinds every other player to where the attacker saw them, clamped to 300 ms.

## The map — Meridian District

5.2 × 5.2 km, hand-laid, deterministic from a seed, and built to be grappled.

- **Grand Boulevard / North Avenue** — 5.2 km straights meeting at a monument
  roundabout you can ramp over or swerve around.
- **Downtown** — dense towers, 90-unit streets, interior alleys, a rooftop
  skybridge network. The best grappling in the district and the worst place to
  arrive at 500.
- **The Yards** — warehouses, container staircases, silos with a gantry
  catwalk, and a wide apron for building momentum.
- **Terrace Hill** — a real hill with a mountain road over its shoulder, a
  tunnel bored through it, terraces and a hilltop citadel.
- **The Overpass** — an elevated deck on pillars with 900-unit on-ramps, and a
  sunken expressway crossed by three bridges.

## Crates

Cosmetics only, bought with credits **earned by playing**. Nothing in a case
touches speed, damage, reach, health or the grapple.

| Rarity | Odds | |
|---|---:|---|
| 🟢 Common | 35.05% | |
| 🔵 Uncommon | 27% | |
| 🟣 Rare | 20% | |
| 🟠 Epic | 10% | |
| 🔴 Legendary | 5% | |
| 🌟 Mythic | 2.9% | |
| ❓ **???** | **0.05%** | 1 in 2,000 |

The reward is decided *before* the reel spins, so there are no manufactured
near-misses. ??? does not get a bigger fanfare than Mythic; it gets a different
film — the colour drains out, the reel forgets what it was showing, the music
cuts, and one glyph arrives before the item does.

## Architecture

```
src/
  core/        Config (every balance value), Input, Util
  shared/      WorldData · Physics · Movement · Parkour · Combat · Grapple
               Sim · Bots
               ^ imported verbatim by BOTH the client and the server
  net/         Protocol, Transport (WebSocket | in-page loopback authority)
  game/        GameState (prediction + reconciliation), Avatar, CameraRig
  world/       WorldView, Sky, Materials
  fx/          PostFX, SpeedFX, CombatFX, GrappleFX, Particles
  audio/       Audio — everything synthesised at runtime, no sound files
  economy/     Rarity, Cosmetics, Crates, Profile
  ui/          HUD, StatScreen, Menu, CrateUI, Icons
server/        Authoritative server (node + ws)
lib/           three.js r160
```

There are **no asset files**. The city, katanas, characters, item icons, crate
art, sky, textures and every sound are generated in code at boot.

All tuning lives in [`src/core/Config.js`](src/core/Config.js) — `MAX_SPEED`,
`DAMAGE_MULTIPLIER`, turn rates, arc angles, swing timings, grapple forces,
camera behaviour and the impact-shake tiers.

## Performance

The whole city is ~30 draw calls and ~42k triangles: colliders are instanced per
material, terrain is one flat-shaded mesh, props are merged per type, and each
character is ~15 meshes across 2 materials. Particles are fixed-capacity pools
with no allocation after boot. One full-screen post pass carries outlines, the
edge streak, speed lines and the vignette.
