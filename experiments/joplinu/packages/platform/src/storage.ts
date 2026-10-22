import { Capacitor, registerPlugin } from '@capacitor/core';
import { indexedDbUpdateStore } from '../../storage/src/indexeddb';
import type { DocumentUpdateStore } from '../../storage/src/index';

interface NativeResult { updates: string[] }
interface NativeStorage {
	read(options: { noteId: string }): Promise<NativeResult>;
	append(options: { noteId: string; update: string }): Promise<void>;
}
interface DesktopStorage {
	read(noteId: string): Promise<NativeResult>;
	append(noteId: string, update: string): Promise<void>;
	onCloseRequested(callback: () => void): () => void;
	readyToClose(): void;
}

declare global {
	interface Window { joplinuDesktop?: DesktopStorage }
}

const androidStorage = registerPlugin<NativeStorage>('JoplinuStorage');

function toBase64(value: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < value.length; i += 0x4000) {
		binary += String.fromCharCode(...value.subarray(i, i + 0x4000));
	}
	return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
	if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
		throw new Error('Invalid update encoding from native storage');
	}
	const decoded = atob(encoded);
	return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

export function createDocumentStore(): DocumentUpdateStore {
	const desktop = window.joplinuDesktop;
	if (desktop) return {
		async load(noteId) {
			const result = await desktop.read(noteId);
			return result.updates.map(fromBase64);
		},
		append(noteId, update) { return desktop.append(noteId, toBase64(update)); },
	};
	if (Capacitor.isNativePlatform()) return {
		async load(noteId) {
			const result = await androidStorage.read({ noteId });
			return result.updates.map(fromBase64);
		},
		append(noteId, update) { return androidStorage.append({ noteId, update: toBase64(update) }); },
	};
	// Never silently downgrade the desktop package to a different storage
	// location if the sandboxed preload/IPC bridge fails to initialize.
	if (navigator.userAgent.includes('Electron/')) throw new Error('Electron 本地存储桥接未加载。');
	return indexedDbUpdateStore();
}
