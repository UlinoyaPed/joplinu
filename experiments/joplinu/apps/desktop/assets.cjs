const path = require('node:path');

function resolveAsset(root, requestUrl) {
	const url = new URL(requestUrl);
	if (url.protocol !== 'joplinu:' || url.host !== 'app' || url.username || url.password) return null;
	let pathname;
	try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
	if (pathname.includes('\0') || pathname.includes('\\')) return null;
	const target = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
	const relative = path.relative(root, target);
	if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
	return target;
}

module.exports = { resolveAsset };
