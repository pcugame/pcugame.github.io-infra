/** These are discovery hints, not automatic acceptance rules. */
const CLUES: Array<[string, RegExp]> = [
	['Unity', /(?:^|\/)UnityPlayer\.(?:dll|so)$|_Data\/(?:globalgamemanagers|boot\.config)$/i],
	['Unreal', /\.(?:pak|utoc|ucas|uasset|umap)$/i],
	['Godot', /\.pck$|(?:^|\/)project\.godot$/i],
	['GameMaker', /(?:^|\/)(?:data\.win|game\.unx|game\.ios|game\.droid)$/i],
	['RPG Maker MV/MZ', /(?:^|\/)(?:rpg_core|rmmz_core)\.js$/i],
	['Ren\u2019Py', /(?:^|\/)renpy\/|\.(?:rpy|rpyc|rpa)$/i],
	['Construct', /(?:^|\/)(?:c2runtime|c3runtime|workermain)\.js$/i],
	['GDevelop', /(?:^|\/)gdjs[-.]|(?:^|\/)runtimegame\.js$/i],
	['Defold', /(?:^|\/)game\.(?:projectc|dmanifest|arci|arcd)$/i],
	['Cocos Creator', /(?:^|\/)(?:jsb-adapter|cocos-js)\/|(?:^|\/)libcocos\./i],
	['PlayCanvas', /(?:^|\/)playcanvas(?:[-.]|\.min\.)/i],
];
export function nativeEngineCandidates(paths: string[]): string[] {
	return CLUES.filter(([, clue]) => paths.some((path) => clue.test(path))).map(([engine]) => engine);
}
