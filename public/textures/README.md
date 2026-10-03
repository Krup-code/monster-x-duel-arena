# public/textures

This folder is empty on purpose. **MONSTER-X: DUEL ARENA ships zero binary assets.**

Every PBR texture is generated at load time on a `<canvas>` by `src/textures.js`:

- **Albedo** maps (concrete, gunmetal plates, grates, hazard stripes, painted metal, the
  MONSTER-X ENERGY signage and emblem).
- **Normal** maps derived from procedural height fields.
- **Packed AO / roughness / metalness** maps (R = AO, G = roughness, B = metalness, the layout
  Three.js `MeshStandardMaterial` expects for `aoMap` / `roughnessMap` / `metalnessMap`).
- Resolution scales with the graphics quality preset, from **256 to 1024 px** per map, so low-end
  GPUs get small textures and high presets get crisp ones.

Models are procedural Three.js geometry (`src/weapons/*.js`, `src/characters.js`,
`src/arena.js`) and audio is synthesized with the Web Audio API (`src/audio.js`). The whole game
downloads as a few hundred KB of gzipped JavaScript and needs no image requests to start.

## Adding optional textures later

Files in `public/` are copied as-is to the site root, so `public/textures/floor_albedo.webp` is
served at `./textures/floor_albedo.webp`. Load it through the base URL so it works under a
GitHub Pages sub-path:

```js
import * as THREE from 'three';

const tex = await new THREE.TextureLoader().loadAsync(import.meta.env.BASE_URL + 'textures/floor_albedo.webp');
tex.colorSpace = THREE.SRGBColorSpace; // albedo only; normal / ORM maps stay linear
tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
```

Keep the canvas generator as the fallback, so a missing file never leaves a surface blank.
Prefer `.webp` or KTX2 (Basis) for size, power-of-two dimensions, and the same packed ORM
layout described above.
