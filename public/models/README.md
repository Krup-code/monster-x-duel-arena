# public/models

This folder is empty on purpose. **MONSTER-X: DUEL ARENA ships zero binary assets.**

Every model in the game is procedural Three.js geometry, built in code when the game loads:

- **Weapons**: `src/weapons/*.js`. Each definition has a `buildModel({ detail })` that assembles
  the viewmodel and world model from primitives and returns a `THREE.Group` with named
  attachment nodes (`muzzle`, `sight`, `energy`, `magazine`, `pump`, `slide`, `rocket`,
  `coil`) that the animation and effects code hook into.
- **Characters**: `src/characters.js` (the armored rider, with player-accent trims, a
  procedural animator and a verlet ragdoll).
- **Arenas**: `src/arena.js`, `src/arenaBuilder.js` and `src/training.js` (THE BLACKOUT
  FACILITY, BLACKOUT: LOCKDOWN and TRAINING GROUNDS, including props, cover, jump pads and
  signage).

Textures are generated on canvas (`src/textures.js`) and audio is synthesized with the Web
Audio API (`src/audio.js`). As a result the whole game downloads as a few hundred KB of
gzipped JavaScript and starts without fetching a single mesh, image or sound file.

## Adding optional models later

Files in `public/` are copied as-is to the site root, so `public/models/rifle.glb` is served
at `./models/rifle.glb`. Use a relative URL (or `import.meta.env.BASE_URL + 'models/rifle.glb'`)
so it keeps working under a GitHub Pages sub-path:

```js
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const gltf = await new GLTFLoader().loadAsync(import.meta.env.BASE_URL + 'models/rifle.glb');
// Keep the same named nodes ('muzzle', 'sight', ...) so the existing code can attach to them,
// and fall back to the procedural buildModel() if loading fails.
```

Keep the procedural model as the fallback, so a missing or slow file never breaks a match.
Prefer `.glb` with Draco/Meshopt compression and keep each file small. Both players load
assets independently, so a model only changes visuals and never needs to be identical on
both sides for gameplay.
