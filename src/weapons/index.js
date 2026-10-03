// Weapon registry: definitions keyed by id + model factory.
import { WEAPON_IDS, WEAPON_BY_ID } from '../config.js';
import pistol from './Pistol.js';
import razor from './AssaultRifle.js';
import volt from './SMG.js';
import crush from './Shotgun.js';
import venom from './DMR.js';
import chaos from './RocketLauncher.js';
import rail from './Railgun.js';

export { getWeaponMaterials, makeEnergyMaterial } from './materials.js';

export const WEAPONS = { pistol, razor, volt, crush, venom, chaos, rail };
export const WEAPON_ORDER = ['razor', 'volt', 'crush', 'venom', 'pistol', 'chaos', 'rail'];

// Convenience fields: seconds between shots and the compact network id.
for (const def of Object.values(WEAPONS)) {
  def.fireInterval = 60 / def.rpm;
  def.netId = WEAPON_IDS[def.id];
}

/** Look up a weapon definition by string id (or numeric network id). Returns null if unknown. */
export function getWeapon(id) {
  const key = typeof id === 'number' ? WEAPON_BY_ID[id] : id;
  // Own keys only: an id like '__proto__' or 'constructor' from the network must not resolve.
  return typeof key === 'string' && Object.hasOwn(WEAPONS, key) ? WEAPONS[key] : null;
}

/** Build a fresh THREE.Group for the weapon. opts: { detail: 'high' | 'low' }. */
export function buildWeaponModel(id, opts) {
  const def = getWeapon(id);
  if (!def) throw new Error(`Unknown weapon id: ${id}`);
  return def.buildModel(opts);
}
