/** Strict HTTP entity-tag and conditional request helpers, independent of any web framework. */
export interface EntityTag {
	weak: boolean;
	/** Quoted opaque-tag, preserved exactly (including commas and obs-text). */
	value: string;
}

export type IfNoneMatchCondition = { kind: 'wildcard' } | { kind: 'tags'; tags: EntityTag[] };

const IMF_FIXDATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const RFC850_DATE = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const ASCTIME_DATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const LONG_WEEKDAYS = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
] as const;

interface HttpDateParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function isOws(character: string | undefined): boolean {
	return character === ' ' || character === '\t';
}

function isOpaqueTagCharacter(character: string): boolean {
	const code = character.charCodeAt(0);
	return code === 0x21 || (code >= 0x23 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
}

/** Parse exactly one entity-tag; surrounding OWS is accepted for field values. */
export function parseEntityTag(value: string): EntityTag | undefined {
	let index = 0;
	while (isOws(value[index])) index++;
	let weak = false;
	if (value.slice(index, index + 2) === 'W/') {
		weak = true;
		index += 2;
	}
	if (value[index] !== '"') return undefined;
	const start = index++;
	while (index < value.length && value[index] !== '"') {
		if (!isOpaqueTagCharacter(value[index]!)) return undefined;
		index++;
	}
	if (value[index] !== '"') return undefined;
	const tag = value.slice(start, ++index);
	while (isOws(value[index])) index++;
	return index === value.length ? { weak, value: tag } : undefined;
}

/**
 * Parse every member of an If-None-Match list. A malformed member invalidates
 * the whole field, never just that member.
 */
export function parseIfNoneMatch(value: string | undefined): IfNoneMatchCondition | undefined {
	if (value === undefined) return undefined;
	let index = 0;
	while (isOws(value[index])) index++;
	if (value[index] === '*') {
		index++;
		while (isOws(value[index])) index++;
		return index === value.length ? { kind: 'wildcard' } : undefined;
	}
	const tags: EntityTag[] = [];
	for (;;) {
		let weak = false;
		if (value.slice(index, index + 2) === 'W/') {
			weak = true;
			index += 2;
		}
		if (value[index] !== '"') return undefined;
		const start = index++;
		while (index < value.length && value[index] !== '"') {
			if (!isOpaqueTagCharacter(value[index]!)) return undefined;
			index++;
		}
		if (value[index] !== '"') return undefined;
		tags.push({ weak, value: value.slice(start, ++index) });
		while (isOws(value[index])) index++;
		if (index === value.length) return { kind: 'tags', tags };
		if (value[index] !== ',') return undefined;
		index++;
		while (isOws(value[index])) index++;
		if (index === value.length) return undefined;
	}
}

/** S3 accepts entity-tags but has no need for weak prefixes under GET semantics. */
export function serializeIfNoneMatch(condition: IfNoneMatchCondition): string {
	return condition.kind === 'wildcard' ? '*' : condition.tags.map((tag) => tag.value).join(', ');
}

/** RFC weak comparison used by If-None-Match for GET and HEAD. */
export function matchesIfNoneMatch(
	condition: IfNoneMatchCondition | undefined,
	etag: string | undefined,
): boolean {
	if (!condition) return false;
	if (condition.kind === 'wildcard') return true;
	const current = etag ? parseEntityTag(etag) : undefined;
	return !!current && condition.tags.some((tag) => tag.value === current.value);
}

function createHttpDate(parts: HttpDateParts, weekday: string, weekdays: readonly string[]): Date | undefined {
	const { year, month, day, hour, minute, second } = parts;
	if (day < 1 || month < 0 || hour > 23 || minute > 59 || second > 59) return undefined;
	// Date.UTC normalizes invalid calendar values (e.g. 31 February), so create
	// and round-trip every supplied component, including the English weekday.
	const date = new Date(0);
	date.setUTCFullYear(year, month, day);
	date.setUTCHours(hour, minute, second, 0);
	return date.getUTCFullYear() === year
		&& date.getUTCMonth() === month
		&& date.getUTCDate() === day
		&& date.getUTCHours() === hour
		&& date.getUTCMinutes() === minute
		&& date.getUTCSeconds() === second
		&& weekdays[date.getUTCDay()] === weekday
		? date
		: undefined;
}

function resolveRfc850Year(twoDigitYear: number, parts: Omit<HttpDateParts, 'year'>, now: Date): number {
	const currentYear = now.getUTCFullYear();
	let year = Math.floor(currentYear / 100) * 100 + twoDigitYear;
	const candidate = new Date(0);
	candidate.setUTCFullYear(year, parts.month, parts.day);
	candidate.setUTCHours(parts.hour, parts.minute, parts.second, 0);
	const fiftyYearsFromNow = new Date(now.getTime());
	fiftyYearsFromNow.setUTCFullYear(currentYear + 50);
	if (candidate.getTime() > fiftyYearsFromNow.getTime()) year -= 100;
	return year;
}

/** Strictly parse IMF-fixdate and both RFC 9110 obsolete HTTP-date formats. */
export function parseHttpDate(value: string | undefined, now: Date = new Date()): Date | undefined {
	if (!value) return undefined;

	const imf = IMF_FIXDATE.exec(value);
	if (imf) {
		return createHttpDate({
			year: Number(imf[4]),
			month: MONTHS.indexOf(imf[3] as typeof MONTHS[number]),
			day: Number(imf[2]),
			hour: Number(imf[5]),
			minute: Number(imf[6]),
			second: Number(imf[7]),
		}, imf[1]!, WEEKDAYS);
	}

	const rfc850 = RFC850_DATE.exec(value);
	if (rfc850) {
		const parts = {
			month: MONTHS.indexOf(rfc850[3] as typeof MONTHS[number]),
			day: Number(rfc850[2]),
			hour: Number(rfc850[5]),
			minute: Number(rfc850[6]),
			second: Number(rfc850[7]),
		};
		return createHttpDate({
			...parts,
			year: resolveRfc850Year(Number(rfc850[4]), parts, now),
		}, rfc850[1]!, LONG_WEEKDAYS);
	}

	const asctime = ASCTIME_DATE.exec(value);
	if (asctime) {
		return createHttpDate({
			year: Number(asctime[7]),
			month: MONTHS.indexOf(asctime[2] as typeof MONTHS[number]),
			day: Number(asctime[3]),
			hour: Number(asctime[4]),
			minute: Number(asctime[5]),
			second: Number(asctime[6]),
		}, asctime[1]!, WEEKDAYS);
	}

	return undefined;
}

export function matchesIfModifiedSince(value: string | undefined, lastModified: Date | undefined): boolean {
	const since = parseHttpDate(value);
	return !!since && !!lastModified
		&& Math.floor(lastModified.getTime() / 1_000) <= Math.floor(since.getTime() / 1_000);
}

/** If-None-Match takes precedence, including when its field value is malformed. */
export function matchesConditionalGet(
	headers: { ifNoneMatch?: string; ifModifiedSince?: string },
	metadata: { etag?: string; lastModified?: Date },
): boolean {
	if (headers.ifNoneMatch !== undefined) {
		return matchesIfNoneMatch(parseIfNoneMatch(headers.ifNoneMatch), metadata.etag);
	}
	return matchesIfModifiedSince(headers.ifModifiedSince, metadata.lastModified);
}
