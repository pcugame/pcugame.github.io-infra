import { ZipValidationError } from '../archive/bounded-zip-validator.js';
import { localPath, type PackageReader } from './reader.js';
import { scriptFacts } from './script-facts.js';

export type LinkedScript = { path: string; text: string };
export const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
/** Inspect only resources reached from this entry's bootstrap, not unrelated engine files. */
export async function inspectLinkedWebEngines(
	reader: PackageReader,
	entry: string,
	scripts: LinkedScript[],
	evidence: string[],
	reasons: string[],
): Promise<string[]> {
	const confirmed: string[] = [];
	const facts = scripts.map((s) => scriptFacts(s.text));
	const assignment = (name: string) => facts.map((f) => f.assignments.get(name)).find((v) => v !== undefined);
	const calls = new Set(facts.flatMap((f) => [...f.calls]));
	const constructors = new Set(facts.flatMap((f) => [...f.constructors]));
	const required = (reference: string, base = entry): string | undefined => {
		const path = localPath(base, reference);
		if (!path) {
			reasons.push('external-engine-resource');
			return undefined;
		}
		if (!reader.entries.has(path)) {
			reasons.push(`missing:${path}`);
			return undefined;
		}
		evidence.push(`${base} -> ${path}`);
		return path;
	};
	const json = async (reference: string): Promise<Record<string, unknown> | undefined> => {
		const path = required(reference);
		if (!path) return undefined;
		if (reader.entries.get(path)!.uncompressedSize > 2 * 1024 * 1024) {
			reasons.push('engine-json-analysis-budget');
			return undefined;
		}
		try {
			return record(JSON.parse((await reader.read(path, 2 * 1024 * 1024)).toString('utf8')));
		} catch (error) {
			if (error instanceof SyntaxError) throw new ZipValidationError(`Invalid engine JSON: ${path}`);
			throw error;
		}
	};
	if (
		constructors.has('pc.Application') &&
		[...calls].some((c) => c.endsWith('.configure')) &&
		[...calls].some((c) => c.endsWith('.loadScene')) &&
		[...calls].some((c) => c.endsWith('.start'))
	) {
		const configName = assignment('CONFIG_FILENAME'),
			sceneName = assignment('SCENE_PATH');
		if (typeof configName === 'string' && typeof sceneName === 'string') {
			const config = await json(configName),
				scene = await json(sceneName);
			if (
				config &&
				scene &&
				record(config.application_properties) &&
				record(config.assets) &&
				record(scene.entities) &&
				Object.keys(record(scene.entities)!).length &&
				scripts.some(
					(s) => /PlayCanvas/i.test(s.text) && /Application/.test(s.text) && /GraphicsDevice/.test(s.text),
				)
			) {
				const prefix = assignment('ASSET_PREFIX');
				for (const asset of Object.values(record(config.assets)!)) {
					const file = record(record(asset)?.file),
						url = file?.url;
					if (typeof url === 'string') required((typeof prefix === 'string' ? prefix : '') + url);
				}
				confirmed.push('PlayCanvas');
				evidence.push('PlayCanvas application -> config/scene/assets');
			}
		}
	}
	if (constructors.has('gdjs.RuntimeGame') && [...calls].some((c) => c.endsWith('.startGameLoop'))) {
		const project = record(assignment('gdjs.projectData'));
		const layouts = project?.layouts;
		if (
			Array.isArray(layouts) &&
			layouts.length &&
			record(project?.properties) &&
			scripts.some(
				(s) =>
					/\.RuntimeGame\s*=/.test(s.text) && /loadAllAssets/.test(s.text) && /getSceneStack/.test(s.text),
			)
		) {
			const resources = record(project?.resources)?.resources;
			if (Array.isArray(resources))
				for (const resource of resources) {
					const file = record(resource)?.file;
					if (typeof file === 'string' && file) required(file);
				}
			confirmed.push('GDevelop');
			evidence.push('GDJS RuntimeGame -> projectData/layouts/resources -> game loop');
		}
	}
	if (
		constructors.has('self.RuntimeInterface') &&
		scripts.some(
			(s) =>
				/C3_CreateRuntime/.test(s.text) && /C3_InitRuntime/.test(s.text) && /["']data\.json["']/.test(s.text),
		)
	) {
		const project = await json('data.json');
		if (
			Array.isArray(project?.project) &&
			project.project.length > 10 &&
			typeof project.project[0] === 'string' &&
			Array.isArray(project.project[2])
		) {
			confirmed.push('Construct');
			evidence.push('Construct RuntimeInterface -> runtime/worker/project data');
		}
	}
	if (
		calls.has('SceneManager.run') &&
		scripts.some((s) => /RPGMAKER_NAME\s*=\s*["'](?:MV|MZ)["']/.test(s.text))
	) {
		const database = assignment('DataManager._databaseFiles');
		if (Array.isArray(database)) {
			const systemFile = database.find((v) => record(v)?.name === '$dataSystem');
			const mapsFile = database.find((v) => record(v)?.name === '$dataMapInfos');
			if (typeof record(systemFile)?.src === 'string' && typeof record(mapsFile)?.src === 'string') {
				const system = await json('data/' + record(systemFile)!.src);
				const mapsPath = required('data/' + record(mapsFile)!.src);
				let maps: unknown;
				if (mapsPath && reader.entries.get(mapsPath)!.uncompressedSize <= 512 * 1024) {
					try {
						maps = JSON.parse((await reader.read(mapsPath)).toString('utf8'));
					} catch {
						throw new ZipValidationError('Invalid RPG Maker map list');
					}
				}
				for (const file of database)
					if (typeof record(file)?.src === 'string') required('data/' + record(file)!.src);
				if (
					system &&
					typeof system.gameTitle === 'string' &&
					Array.isArray(maps) &&
					maps.some((m) => typeof record(m)?.id === 'number')
				) {
					for (const map of maps) {
						const id = record(map)?.id;
						if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
							required(`data/Map${String(id).padStart(3, '0')}.json`);
					}
					const startMap =
						typeof system.startMapId === 'number' &&
						Number.isSafeInteger(system.startMapId) &&
						system.startMapId > 0
							? await json(`data/Map${String(system.startMapId).padStart(3, '0')}.json`)
							: undefined;
					if (
						!startMap ||
						typeof startMap.width !== 'number' ||
						typeof startMap.height !== 'number' ||
						!Array.isArray(startMap.data) ||
						!Array.isArray(startMap.events) ||
						startMap.data.length !== startMap.width * startMap.height * 6
					)
						reasons.push('unverified-rpg-maker-start-map');
					confirmed.push('RPG Maker MV/MZ');
					evidence.push('RPG Maker bootstrap -> core/DataManager -> system/maps/database');
				}
			}
		}
	}
	if (
		calls.has('cc.game.init') &&
		calls.has('cc.game.run') &&
		constructors.has('Application') &&
		scripts.some((s) => /System\.register/.test(s.text) && /GraphicsDevice|AssetManager/.test(s.text))
	) {
		const settingsPath = assignment('this.settingsPath');
		if (typeof settingsPath === 'string') {
			const settings = await json(settingsPath),
				assets = record(settings?.assets),
				launch = record(settings?.launch);
			if (
				typeof settings?.CocosEngine === 'string' &&
				Array.isArray(assets?.projectBundles) &&
				typeof launch?.launchScene === 'string'
			) {
				let scene = false;
				const versions = record(assets.bundleVers),
					remotes = Array.isArray(assets.remoteBundles) ? assets.remoteBundles : [];
				for (const bundle of assets.projectBundles) {
					if (typeof bundle !== 'string' || remotes.includes(bundle)) continue;
					const version = versions?.[bundle],
						suffix = typeof version === 'string' && version ? '.' + version : '';
					const configPath = `assets/${bundle}/config${suffix}.json`,
						config = await json(configPath);
					if (!config) continue;
					if (config.hasPreloadScript) required(`assets/${bundle}/index${suffix}.js`);
					const scenes = record(config.scenes);
					if (scenes && Object.hasOwn(scenes, launch.launchScene)) {
						const index = scenes[launch.launchScene];
						const uuid =
							Array.isArray(config.uuids) && typeof index === 'number' ? config.uuids[index] : undefined;
						const imports = record(config.versions)?.import;
						if (
							typeof uuid !== 'string' ||
							!Array.isArray(imports) ||
							Object.keys(record(config.packs) ?? {}).length ||
							Object.keys(record(config.extensionMap) ?? {}).length
						) {
							reasons.push('unsupported-cocos-scene-container');
							continue;
						}
						let hex = uuid;
						if (/^[0-9a-f]{2}[A-Za-z0-9+/]{20}$/.test(uuid)) {
							const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
							hex = uuid.slice(0, 2);
							for (let i = 2; i < 22; i += 2) {
								const a = alphabet.indexOf(uuid[i]!),
									b = alphabet.indexOf(uuid[i + 1]!);
								hex +=
									(a >> 2).toString(16) + (((a & 3) << 2) | (b >> 4)).toString(16) + (b & 15).toString(16);
							}
							hex = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
						}
						if (!/^[0-9a-f-]{36}$/.test(hex)) {
							reasons.push('unsupported-cocos-scene-id');
							continue;
						}
						let hash: unknown;
						for (let i = 0; i < imports.length; i += 2)
							if (imports[i] === index || imports[i] === uuid) hash = imports[i + 1];
						const scenePath = required(
							`assets/${bundle}/${typeof config.importBase === 'string' ? config.importBase : 'import'}/${hex.slice(0, 2)}/${hex}${typeof hash === 'string' ? '.' + hash : ''}.json`,
						);
						if (scenePath && reader.entries.get(scenePath)!.uncompressedSize <= 2 * 1024 * 1024) {
							try {
								const payload: unknown = JSON.parse(
									(await reader.read(scenePath, 2 * 1024 * 1024)).toString('utf8'),
								);
								scene = Array.isArray(payload) && payload.length > 0;
							} catch (error) {
								if (error instanceof SyntaxError) throw new ZipValidationError('Invalid Cocos scene data');
								throw error;
							}
						}
					}
				}
				if (scene) {
					confirmed.push('Cocos Creator');
					evidence.push('Cocos SystemJS/application -> engine/settings/bundles/launch scene');
				}
			}
		}
	}
	if (
		facts.some((f) => f.calls.has('GameMaker_Init') || f.bindings.get('window.onload') === 'GameMaker_Init')
	) {
		for (let i = 0; i < scripts.length; i++) {
			const runtime = facts[i]!,
				initializer = runtime.functions.get('GameMaker_Init');
			if (!initializer || !/g_GameMakerHTML5Dir/.test(scripts[i]!.text)) continue;
			const init = scriptFacts(initializer);
			for (const binding of init.bindings.values()) {
				const data = record(runtime.assignments.get(binding));
				if (!data) continue;
				const arrays = Object.values(data).filter(Array.isArray);
				const rooms = arrays.some((a) =>
					a.some((v) => typeof record(v)?.width === 'number' && typeof record(v)?.height === 'number'),
				);
				const textures = arrays.flatMap((a) =>
					a.filter((v) => typeof v === 'string' && /\.(png|webp|jpe?g)$/i.test(v)),
				) as string[];
				if (!rooms || !textures.length || !init.calls.has('document.getElementById')) continue;
				for (const texture of textures) required(texture, scripts[i]!.path);
				confirmed.push('GameMaker');
				evidence.push('GameMaker initializer -> compiled game tables/rooms/textures');
				break;
			}
		}
	}
	return confirmed;
}
