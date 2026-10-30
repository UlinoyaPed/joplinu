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

function externalWebUrl(value) {
	if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return null;
	try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null; }
	catch { return null; }
}

module.exports = { resolveAsset, externalWebUrl };
