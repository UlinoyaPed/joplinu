import { Capacitor } from '@capacitor/core';

/** Keep browser previews in their tab; native shells handle ordinary navigation
 * through the OS browser. Never dispatch file/custom schemes or URI credentials. */
export function prepareWebLink(anchor: HTMLAnchorElement): boolean {
	const href = anchor.getAttribute('href') ?? '';
	if (!/^https?:\/\//i.test(href) || href.length > 8192 || /[\u0000-\u0020\u007f]/.test(href)) return false;
	let url: URL; try { url = new URL(href); } catch { return false; }
	if (!url.hostname || url.username || url.password) return false;
	anchor.href = url.href; anchor.rel = 'noopener noreferrer';
	if (Capacitor.isNativePlatform()) anchor.removeAttribute('target'); else anchor.target = '_blank';
	return true;
}
