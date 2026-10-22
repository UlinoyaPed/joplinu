import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { resolveAsset } = require('../apps/desktop/assets.cjs');
const root = resolve('/tmp/joplinu-web');

test('Electron asset protocol stays inside its packaged root', () => {
	assert.equal(resolveAsset(root, 'joplinu://app/'), resolve(root, 'index.html'));
	assert.equal(resolveAsset(root, 'joplinu://app/assets/app.js'), resolve(root, 'assets/app.js'));
	for (const url of ['file:///etc/passwd', 'https://example.org/', 'joplinu://other/app.js', 'joplinu://app/%2f..%2f..%2fetc/passwd', 'joplinu://app/%00', 'joplinu://app/%5c..%5csecret', 'joplinu://app/%zz']) assert.equal(resolveAsset(root, url), null);
});
