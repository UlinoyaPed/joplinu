import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

/** Native back is consumed until the UI has safely saved and chosen navigation. */
export async function installAndroidBackHandler(action: () => Promise<void>): Promise<() => Promise<void>> {
	if (Capacitor.getPlatform() !== 'android') return async () => {};
	const listener = await App.addListener('backButton', () => { void action().catch(() => {}); });
	return () => listener.remove();
}
export async function minimizeAndroidApp() { if (Capacitor.getPlatform() === 'android') await App.minimizeApp(); }
