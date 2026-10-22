import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './artifacts.mjs';

const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const sections = ['JoplinU third-party notices\nApplication source: https://github.com/UlinoyaPed/joplinu\nApplication license: AGPL-3.0-or-later (see AGPL-3.0-or-later.txt)'];
for (const [folder, entry] of Object.entries(lock.packages)) {
	if (!folder.startsWith('node_modules/') || entry.dev || entry.link) continue;
	const directory = join(root, folder);
	const info = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
	let text = `${info.name}@${info.version}\nLicense: ${info.license || entry.license || 'See package source'}`;
	for (const file of (await readdir(directory)).sort()) {
		if (!/^(licen[cs]e|notice|copying|ofl)(?:$|[._-])/i.test(file)) continue;
		try { text += `\n\n${file}\n${await readFile(join(directory, file), 'utf8')}`; } catch {}
	}
	sections.push(text);
}
sections.push(await readFile(join(root, 'apps/android/THIRD_PARTY_NOTICES.txt'), 'utf8'));
await writeFile(join(root, 'public/THIRD_PARTY_NOTICES.txt'), sections.join('\n\n----------------------------------------\n\n') + '\n');
console.log('Runtime third-party notices generated');
