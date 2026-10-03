# public/audio

This folder is empty on purpose. **MONSTER-X: DUEL ARENA ships zero binary assets.**

Every sound in the game is synthesized at runtime with the Web Audio API in `src/audio.js`:
gunshots, reloads, footsteps per surface, impacts, pickups, jump pads, the announcer stingers,
UI clicks and hovers (`ui_hover`, `ui_click`, `ui_back`), and the music, which a lookahead
step sequencer plays live. Sounds are built from oscillators, filtered noise and envelopes,
then routed through separate `sfx` / `ui` / music buses with a convolution reverb send and
HRTF panning for positional effects. Announcer lines pair a synthesized stinger with the
browser's `speechSynthesis` voice.

Models are procedural Three.js geometry (`src/weapons/*.js`, `src/characters.js`,
`src/arena.js`) and textures are generated on canvas (`src/textures.js`). The whole game
downloads as a few hundred KB of gzipped JavaScript with no audio files to fetch.

## Adding optional audio later

Files in `public/` are copied as-is to the site root, so `public/audio/music_menu.ogg` is served
at `./audio/music_menu.ogg`. Fetch it through the base URL so it works under a GitHub Pages
sub-path, and decode it on the engine's existing `AudioContext`:

```js
const res = await fetch(import.meta.env.BASE_URL + 'audio/music_menu.ogg');
const buffer = await audioContext.decodeAudioData(await res.arrayBuffer());
```

Keep the synthesized version as the fallback, so a missing file or a blocked request never
silences the game. Use `.ogg` (Opus/Vorbis) or `.m4a` (AAC) and keep one-shot effects short.
Browsers only start audio after a user gesture; the engine already handles that unlock.
