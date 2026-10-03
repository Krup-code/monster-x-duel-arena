// Shared constants for MONSTER-X: DUEL ARENA.
// Gameplay numbers live here so host validation and local prediction agree.

export const GAME_TITLE = 'MONSTER-X';
export const GAME_SUBTITLE = 'DUEL ARENA';
export const TAGLINE = '1V1. NO EXCUSES.';
export const PROTOCOL_VERSION = 3;

export const PALETTE = {
  black: 0x050605,
  matte: 0x0b0d0c,
  charcoal: 0x16191a,
  gunmetal: 0x2a2f31,
  steel: 0x5b6265,
  acid: 0x7dff1a, // signature acid green
  acidDeep: 0x39d10a,
  acidGlow: 0xa6ff4d,
  white: 0xf2f5f0,
  warnRed: 0xff2a1a,
  warnOrange: 0xff7a1a,
  p1: 0x7dff1a, // player 1 accents: green
  p2: 0xff8a1f, // player 2 accents: orange
};

export const CSS_ACID = '#7dff1a';
export const CSS_P1 = '#7dff1a';
export const CSS_P2 = '#ff8a1f';

export const MATCH = {
  killLimit: 15,
  timeLimit: 8 * 60, // seconds
  respawnTime: 2.0,
  spawnProtection: 1.0,
  introDuration: 6.5, // arena flyover + VS card
  countdown: 3.0,
  endSlowmo: 1.6,
  reconnectWindow: 15,
};

export const PLAYER = {
  radius: 0.36,
  height: 1.8,
  crouchHeight: 1.15,
  slideHeight: 1.0,
  eyeOffset: 0.12, // eye sits this far below the top of the collider
  maxHealth: 100,
  maxArmor: 50,
  megaMax: 150,
  megaDecay: 2, // hp per second above 100
  maxEnergy: 100,
};

export const MOVE = {
  walk: 5,
  run: 7,
  sprint: 9,
  crouch: 3.4,
  slideBoost: 11,
  slideMin: 4.2,
  slideFriction: 2.2,
  slideDuration: 1.0,
  slideCooldown: 0.35,
  gravity: 20,
  jumpHeight: 1.2,
  groundAccel: 14,
  groundFriction: 9,
  airAccel: 2.2,
  airWishCap: 1.4, // quake-style air strafe cap
  airMaxSpeed: 14.5,
  stepHeight: 0.46,
  mantleMax: 1.35,
  coyoteTime: 0.1,
  jumpBuffer: 0.12,
  wallKickSpeed: 6.5,
  wallKickUp: 5.5,
  rushSpeedMul: 1.15,
  rushJumpMul: 1.12,
  maxFallSpeed: 40,
};

export const ENERGY = {
  perDamage: 0.22,
  perKill: 22,
  canPickup: 25,
  trick: { slidejump: 4, rocketjump: 6, jumppad: 2, mantle: 2, wallkick: 4, airtime: 3 },
  trickBudgetPer5s: 14, // host-side clamp on movement-trick energy
  rushDuration: 8,
  rushReloadMul: 1.15,
};

export const NET = {
  sendRate: 30, // snapshots per second
  interpDelay: 85, // ms
  maxRewind: 500, // ms of lag compensation
  historyLength: 1000, // ms of stored transforms
  pingInterval: 1000,
  timeoutMs: 3500, // no packets -> consider link lost
  reconnectWindow: 15, // seconds to wait for a dropped opponent before ending the match
  // Room codes avoid confusable characters (no O/0/I/1).
  codeAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  codeLength: 5,
  peerPrefix: 'mxduel-v3-',
  roomTTLMinutes: 60,
};

// Weapon ids are small ints so they pack into binary snapshots.
export const WEAPON_IDS = {
  pistol: 0,
  razor: 1,
  volt: 2,
  crush: 3,
  venom: 4,
  chaos: 5,
  rail: 6,
};
export const WEAPON_BY_ID = Object.fromEntries(Object.entries(WEAPON_IDS).map(([k, v]) => [v, k]));

export const SURFACES = ['concrete', 'metal', 'grate', 'gravel', 'glass'];
