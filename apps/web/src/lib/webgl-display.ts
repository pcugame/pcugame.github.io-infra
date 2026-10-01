/** Normal mode never enlarges a game. Fullscreen may enlarge with letterboxing. */
export function getWebglDisplayScale(width: number, height: number, availableWidth: number, availableHeight: number, fullscreen: boolean) {
	if (width <= 0 || height <= 0 || availableWidth <= 0 || availableHeight <= 0) return 0;
	return Math.min(availableWidth / width, availableHeight / height, fullscreen ? Infinity : 1);
}
