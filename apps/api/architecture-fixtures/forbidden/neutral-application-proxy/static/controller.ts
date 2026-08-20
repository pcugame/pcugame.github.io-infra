import { request as forward } from 'node:http';

export function serveStaticObject(): void {
	forward('http://garage:3900/public/object');
}
