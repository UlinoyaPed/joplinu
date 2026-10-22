import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
	appId: 'org.joplinu.app',
	appName: 'JoplinU',
	webDir: '../../dist',
	android: { path: 'native', allowMixedContent: false },
	server: { androidScheme: 'https', cleartext: false },
};

export default config;
