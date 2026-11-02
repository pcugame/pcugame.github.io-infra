import { parse } from 'acorn';

type Node = { type?: string; [key: string]: unknown };
export interface ScriptFacts {
	assignments: Map<string, unknown>;
	calls: Set<string>;
	constructors: Set<string>;
	strings: Set<string>;
	arguments: Map<string, unknown[][]>;
	bindings: Map<string, string>;
	functions: Map<string, string>;
	parsed: boolean;
}
/** Bounded syntax inspection only. No eval, VM, imports or uploaded functions are run. */
export function scriptFacts(source: string): ScriptFacts {
	const result: ScriptFacts = {
		assignments: new Map(),
		calls: new Set(),
		constructors: new Set(),
		strings: new Set(),
		arguments: new Map(),
		bindings: new Map(),
		functions: new Map(),
		parsed: false,
	};
	let root: unknown;
	try {
		root = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
	} catch {
		try {
			root = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
		} catch {
			return result;
		}
	}
	for (const node of ((root as Node).body as Node[]).slice(0, 10000)) {
		if (
			node.type === 'FunctionDeclaration' &&
			typeof (node.id as Node)?.name === 'string' &&
			typeof node.start === 'number' &&
			typeof node.end === 'number'
		)
			result.functions.set(String((node.id as Node).name), source.slice(node.start, node.end));
	}
	const name = (value: unknown, depth = 0): string | undefined => {
		if (!value || typeof value !== 'object' || depth > 12) return undefined;
		const n = value as Node;
		if (n.type === 'Identifier') return String(n.name);
		if (n.type === 'ThisExpression') return 'this';
		if (n.type === 'MemberExpression') {
			const object = name(n.object, depth + 1),
				property = n.property as Node;
			const key = n.computed ? property?.value : property?.name;
			if (object && typeof key === 'string') return `${object}.${key}`;
		}
		return undefined;
	};
	let literals = 0;
	const literal = (value: unknown, depth = 0): unknown => {
		if (!value || typeof value !== 'object' || depth > 48 || ++literals > 100000) return undefined;
		const n = value as Node;
		if (n.type === 'Literal') return n.value;
		if (n.type === 'Identifier') return result.assignments.get(String(n.name));
		if (n.type === 'ArrayExpression') return (n.elements as unknown[]).map((e) => literal(e, depth + 1));
		if (n.type === 'ObjectExpression') {
			const out: Record<string, unknown> = Object.create(null);
			for (const p of n.properties as Node[]) {
				const key = p.key as Node;
				const field = p.computed ? undefined : (key?.name ?? key?.value);
				if (typeof field === 'string') out[field] = literal(p.value, depth + 1);
			}
			return out;
		}
		return undefined;
	};
	const stack = [root];
	let visited = 0;
	while (stack.length) {
		if (++visited > 200000) return result;
		const raw = stack.pop();
		if (!raw || typeof raw !== 'object') continue;
		const n = raw as Node;
		if (n.type === 'Literal' && typeof n.value === 'string') result.strings.add(n.value);
		if (n.type === 'CallExpression' || n.type === 'NewExpression') {
			const target = name(n.callee);
			if (target) {
				(n.type === 'NewExpression' ? result.constructors : result.calls).add(target);
				const args = result.arguments.get(target) ?? [];
				args.push((n.arguments as unknown[]).map((a) => literal(a)));
				result.arguments.set(target, args);
			}
		}
		if (n.type === 'AssignmentExpression' || n.type === 'VariableDeclarator') {
			const target = name(n.left ?? n.id),
				value = literal(n.right ?? n.init);
			if (target && value !== undefined) result.assignments.set(target, value);
			const binding = name(n.right ?? n.init);
			if (target && binding) result.bindings.set(target, binding);
		}
		for (const child of Object.values(n).reverse()) {
			if (Array.isArray(child)) stack.push(...[...child].reverse());
			else if (child && typeof child === 'object') stack.push(child);
		}
	}
	result.parsed = true;
	return result;
}
