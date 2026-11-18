#!/usr/bin/env node
'use strict';

/**
 * Generates calc/src/data/rc.ts: the Roria Conquest (RC) balance changes as
 * patches on top of the calc's Gen 9 (SV) data. RC is exposed as gen 10.
 *
 * Source: the RC-Showdown fork's built client data (same source the dex uses).
 * Only fields that differ from the calc's SV data are written, so the diff of
 * rc.ts after a patch shows exactly what changed.
 *
 * Requires the calc to have been compiled once (calc/dist), since it reads the
 * SV data from there. Run `node build` afterwards.
 *
 * Usage: node sync-rc.js [--fork-dir <path>]
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.chdir(__dirname);

const argIdx = process.argv.indexOf('--fork-dir');
const FORK_DIR = argIdx > 0 ? process.argv[argIdx + 1] :
	'/var/www/RC-Showdown/client/play.pokemonshowdown.com/data';
const OUT = 'calc/src/data/rc.ts';

function loadFork(file, globalName) {
	const ctx = {exports: {}, window: {}};
	ctx.global = ctx;
	vm.runInNewContext(fs.readFileSync(path.join(FORK_DIR, file), 'utf8'), ctx);
	const data = ctx.exports[globalName] || ctx.window[globalName] || ctx[globalName];
	if (!data) throw new Error(`${globalName} not found in ${file}`);
	return data;
}

// Compiled SV data (gen index 9).
const SV_SPECIES = require('./calc/dist/data/species').SPECIES[9];
const SV_MOVES = require('./calc/dist/data/moves').MOVES[9];
const SV_ABILITIES = new Set(require('./calc/dist/data/abilities').ABILITIES[9]);

const forkDex = loadFork('pokedex.js', 'BattlePokedex');
const forkMoves = loadFork('moves.js', 'BattleMovedex');
const forkAbilities = loadFork('abilities.js', 'BattleAbilities');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- Species ----
const STAT_MAP = {hp: 'hp', atk: 'at', def: 'df', spa: 'sa', spd: 'sd', spe: 'sp'};
const speciesPatch = {};
for (const entry of Object.values(forkDex)) {
	if (!entry.name || !entry.baseStats) continue;
	const sv = SV_SPECIES[entry.name];
	const bs = {};
	for (const [k, v] of Object.entries(STAT_MAP)) bs[v] = entry.baseStats[k];
	const ability0 = entry.abilities && entry.abilities[0];

	if (!sv) {
		// Species the calc doesn't know about: only add ones that are legal in RC.
		if (entry.isNonstandard && entry.isNonstandard !== 'Past' && entry.isNonstandard !== 'RC') continue;
		if (entry.num <= 0) continue;
		const full = {types: entry.types, bs, weightkg: entry.weightkg};
		if (ability0) full.abilities = {0: ability0};
		if (entry.baseSpecies && entry.baseSpecies !== entry.name) full.baseSpecies = entry.baseSpecies;
		if (entry.otherFormes) full.otherFormes = entry.otherFormes;
		speciesPatch[entry.name] = full;
		continue;
	}
	const patch = {};
	if (!same(sv.bs, bs)) patch.bs = bs;
	if (!same(sv.types, entry.types)) patch.types = entry.types;
	if (ability0 && (!sv.abilities || sv.abilities[0] !== ability0)) patch.abilities = {0: ability0};
	if (Object.keys(patch).length) speciesPatch[entry.name] = patch;
}

// ---- Moves ----
const FLAG_MAP = {
	contact: 'makesContact', punch: 'isPunch', bite: 'isBite', bullet: 'isBullet',
	sound: 'isSound', pulse: 'isPulse', slicing: 'isSlicing', wind: 'isWind',
	kick: 'isKick',
};
function convertMove(m) {
	const out = {bp: m.basePower || 0, type: m.type, category: m.category};
	if (m.priority) out.priority = m.priority;
	if (m.multihit) out.multihit = m.multihit;
	if (m.recoil) out.recoil = m.recoil;
	if (m.drain) out.drain = m.drain;
	if (m.willCrit) out.willCrit = true;
	if (m.secondary || (m.secondaries && m.secondaries.length)) out.secondaries = true;
	if (m.target) out.target = m.target;
	for (const [flag, key] of Object.entries(FLAG_MAP)) {
		if (m.flags && m.flags[flag]) out[key] = true;
	}
	return out;
}
const movesPatch = {};
for (const m of Object.values(forkMoves)) {
	if (!m.name || m.isZ || m.isMax) continue;
	const sv = SV_MOVES[m.name];
	const rc = convertMove(m);
	if (!sv) {
		if (m.isNonstandard && m.isNonstandard !== 'Past' && m.isNonstandard !== 'RC') continue;
		movesPatch[m.name] = rc;
		continue;
	}
	const patch = {};
	for (const key of ['bp', 'type', 'priority', 'multihit', 'recoil', 'drain', 'willCrit',
		...Object.values(FLAG_MAP)]) {
		const a = sv[key] === undefined ? (key === 'priority' ? 0 : undefined) : sv[key];
		const b = rc[key] === undefined ? (key === 'priority' ? 0 : undefined) : rc[key];
		// Flags present in vanilla but removed in RC have to be set to false explicitly.
		if (!same(a, b)) patch[key] = (b === undefined && a === true) ? false : b;
	}
	// The calc only stores category for non-Status moves when it differs from the type default
	// in old gens; in SV it's always explicit.
	if (sv.category && sv.category !== rc.category) patch.category = rc.category;
	for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
	if (Object.keys(patch).length) movesPatch[m.name] = patch;
}

// ---- Removed species ----
// The calc's SV data includes CAP Pokemon, which aren't in RC. Calc-only formes that RC's dex
// doesn't list (e.g. Aegislash-Both) are judged by their base species.
const toId = t => ('' + t).toLowerCase().replace(/[^a-z0-9]+/g, '');
const removedSpecies = Object.keys(SV_SPECIES).filter(name => {
	const entry = forkDex[toId(name)] || forkDex[toId(name.split('-')[0])];
	return entry && entry.isNonstandard === 'CAP';
}).sort();

// ---- Abilities (names only; effects live in mechanics code) ----
const newAbilities = Object.values(forkAbilities)
	.filter(a => a.name && a.name !== 'No Ability' && !SV_ABILITIES.has(a.name) && (!a.isNonstandard || a.isNonstandard === 'Past' || a.isNonstandard === 'RC'))
	.map(a => a.name)
	.sort();

// ---- Write ----
const sortObj = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
const ts = `// GENERATED by sync-rc.js from the RC-Showdown fork. Do not edit by hand.
/* eslint-disable */
import type {SpeciesData} from './species';
import type {MoveData} from './moves';
import type {DeepPartial} from '../util';

export const RC_SPECIES_PATCH: {[name: string]: DeepPartial<SpeciesData>} = ${JSON.stringify(sortObj(speciesPatch), null, '\t')};

export const RC_MOVES_PATCH: {[name: string]: DeepPartial<MoveData>} = ${JSON.stringify(sortObj(movesPatch), null, '\t')};

export const RC_NEW_ABILITIES: string[] = ${JSON.stringify(newAbilities, null, '\t')};

export const RC_REMOVED_SPECIES: string[] = ${JSON.stringify(removedSpecies, null, '\t')};
`;
fs.writeFileSync(OUT, ts);
console.log(`Wrote ${OUT}: ${Object.keys(speciesPatch).length} species, ` +
	`${Object.keys(movesPatch).length} moves, ${newAbilities.length} new abilities, ${removedSpecies.length} CAP species removed`);
