import { request } from 'node:http';

export function proxyObject(): void {
	request('http://garage:3900/public/object');
}
