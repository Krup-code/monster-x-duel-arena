// Vite config for MONSTER-X: DUEL ARENA.
//
// - Relative base ('./') so the same build works from a domain root, from any GitHub Pages
//   project subdirectory (https://USER.github.io/REPO/) and with ?room=CODE invite links.
//   Override with VITE_BASE (shell env, CI variable, or .env / .env.local), e.g. VITE_BASE=/arena/.
// - three.js gets its own long-cacheable chunk; Firebase (only dynamically imported when
//   VITE_FIREBASE_* is configured) lands in a separate lazy 'firebase' chunk, so the default
//   zero-config PeerJS build never downloads it.
import { defineConfig, loadEnv } from 'vite';

const THREE_RE = /[\\/]node_modules[\\/]three[\\/]/;
const FIREBASE_RE = /[\\/]node_modules[\\/](?:firebase|@firebase)[\\/]/;

function manualChunks(id) {
  if (THREE_RE.test(id)) return 'three';
  if (FIREBASE_RE.test(id)) return 'firebase';
  return undefined;
}

// Without VITE_FIREBASE_* the Firebase code is tree-shaken away, which would leave an empty,
// unreferenced 'firebase' chunk plus an EMPTY_BUNDLE warning. Drop both for a clean build.
const dropEmptyChunks = {
  name: 'monsterx-drop-empty-chunks',
  apply: 'build',
  generateBundle(_options, bundle) {
    for (const [file, out] of Object.entries(bundle)) {
      if (out.type === 'chunk' && !out.isEntry && !out.isDynamicEntry && out.code.trim() === '') delete bundle[file];
    }
  },
};

function onwarn(warning, warn) {
  if (warning.code === 'EMPTY_BUNDLE') return;
  warn(warning);
}

export default defineConfig(({ mode }) => {
  // process.env wins (CI / shell), then .env files, then the relative default.
  const fileEnv = loadEnv(mode, process.cwd(), 'VITE_');
  const base = process.env.VITE_BASE || fileEnv.VITE_BASE || './';

  return {
    base,
    publicDir: 'public',
    plugins: [dropEmptyChunks],
    build: {
      target: 'es2022',
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      chunkSizeWarningLimit: 1600,
      rollupOptions: {
        output: { manualChunks },
        onwarn,
      },
    },
    server: {
      host: true, // reachable from other devices on the LAN for 2-machine testing
      port: 5173,
    },
    preview: {
      host: true,
      port: 4173,
    },
  };
});
