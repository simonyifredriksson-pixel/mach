# [MACH]

**Speed is damage.**

A 3D multiplayer katana PvP game built on one rule:

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
less able to use it**. Three systems enforce that:

1. **Steering collapses with speed.** At a walk you can reverse direction inside
   a single tick (~690°/s). At 500 you get 66°/s — a 400-unit turning circle.
   Carving also scrubs momentum, so the moment you try to correct, you slow
   down (and then you *can* turn). You commit to a line long before you arrive.
2. **The blade arc narrows with speed.** At low speed the katana covers a 150°
   fan out to 36 units. At 500 it is a 48° sliver at 27 units — and you cross
   that window in about 70 milliseconds. The on-screen reticle *is* that arc;
   watch it close as you accelerate.
3. **Missing costs you.** A whiff drops your steering to 30%, kills your
   acceleration and doubles friction for half a second. At 400 speed that is
   200 units of being a stationary target.

So the fight is an interception problem, not a chase. You read where someone
will be, commit, and swing early. A disciplined player at 200 beats a careless
one at 450, which is the point.

## Play

Open `index.html` from any web server (it uses ES modules, so `file://` will
not work):

```bash
npx serve .          # or: python -m http.server 8080
```

Solo play spawns bots and runs the **same authoritative simulation** in the page
— it is not a different game mode with different rules, it is the identical
authority with zero latency.

### Controls

| | |
|---|---|
| `W A S D` | Move |
| `SHIFT` | Sprint — hold it, there is no stamina |
| `SPACE` | Jump |
| `LMB` | Slash. From the sheath it becomes an **iai** draw-cut |
| `R` / `RMB` | Draw / sheathe |
| `TAB` | Stat screen |
| `ESC` | Pause |

## Multiplayer

The included server is authoritative. Clients send **inputs only**; positions,
speed, hit registration, damage, health, kills and credits are all decided
server-side and nothing else is trusted.

```bash
npm install
npm run server                 # ws://localhost:8787
```

Then open the client with the server in the query string:

```
index.html?server=ws://localhost:8787
```

Options: `PORT`, `BOTS`, `MAX_PLAYERS`, `SEED`.

**How it stays fair at 500 units/second:**

- 60 Hz fixed simulation, 30 Hz snapshots.
- The client predicts its own movement with the exact same module the server
  runs (`src/shared/Movement.js`), then reconciles by replaying unacknowledged
  inputs. Correction error is bled off smoothly instead of snapping.
- Remote players render 100 ms behind the server clock and are interpolated, so
  a high-speed pass reads as a streak rather than a teleport.
- Hit registration is **lag compensated**: when a blade goes active the server
  rewinds every other player to where the attacker actually saw them, clamped
  to 300 ms.

## The map — Meridian District

5.2 × 5.2 km, hand-laid, deterministic from a seed.

- **Grand Boulevard / North Avenue** — 5.2 km straights. Where 500 happens.
- **Downtown** — a dense tower grid with 90-unit streets, interior alleys and a
  rooftop skybridge network. Come in fast and you will die in a corner.
- **The Yards** — warehouses, container staircases, silos with a gantry
  catwalk, and a wide open apron for building momentum.
- **Terrace Hill** — a real hill with a mountain road over its shoulder, a
  tunnel bored through it, stepped terraces and a hilltop citadel.
- **The Overpass** — an elevated deck on pillars with 900-unit on-ramps, plus a
  sunken expressway crossed by three bridges.

Every collider you can stand on is drawn from the same numbers the physics
uses, so there are no phantom ledges.

## Crates

Cosmetics only, bought with credits **earned by playing** (damage dealt, kills,
time alive). Nothing in a case touches speed, damage, reach or health.

| Rarity | Odds | |
|---|---:|---|
| 🟢 Common | 35.05% | |
| 🔵 Uncommon | 27% | |
| 🟣 Rare | 20% | |
| 🟠 Epic | 10% | |
| 🔴 Legendary | 5% | |
| 🌟 Mythic | 2.9% | |
| ❓ **???** | **0.05%** | 1 in 2,000 |

The reward is decided *before* the reel spins — the strip is built around the
result, so there are no manufactured near-misses.

??? does not get a bigger fanfare than Mythic; it gets a different film. The
colour drains out of the room, the reel forgets what it was showing, the music
cuts, and one glyph arrives before the item does. There are three ??? items and
each is a different *kind* of object, not a shinier version of something else:

- **THE LAST SECOND** — the katana is a clock hand. The dial is the guard, the
  numerals are on the blade, and the second hand ticks. It has never moved.
- **ECHO** — you arrive three times. Two of them are not you.
- **TIMESTAMP** — a trail that writes the hour you passed.

## Architecture

```
src/
  core/        Config (every balance value), Input, Util
  shared/      WorldData · Physics · Movement · Combat · Sim · Bots
               ^ imported verbatim by BOTH the client and the server
  net/         Protocol, Transport (WebSocket | in-page loopback authority)
  game/        GameState (prediction + reconciliation), Avatar, CameraRig
  world/       WorldView, Sky, Materials
  fx/          PostFX, SpeedFX, CombatFX, Particles
  audio/       Audio — everything synthesised at runtime, no sound files
  economy/     Rarity, Cosmetics, Crates, Profile
  ui/          HUD, StatScreen, Menu, CrateUI, Icons
server/        Authoritative server (node + ws)
lib/           three.js r160
```

There are **no asset files**. Buildings, katanas, characters, item icons, crate
art, sky, textures and every sound are generated in code at boot.

All tuning lives in [`src/core/Config.js`](src/core/Config.js) — `MAX_SPEED`,
`DAMAGE_MULTIPLIER`, turn rates, arc angles, swing timings, camera behaviour.

## Performance

The whole city is ~29 draw calls and ~42k triangles: colliders are instanced
per material, terrain is one flat-shaded mesh, props are merged per type.
Particles are fixed-capacity pools with no allocation after boot. One
full-screen post pass carries outlines, motion blur, speed lines, chromatic
aberration, vignette and grain.
