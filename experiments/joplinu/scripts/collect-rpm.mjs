import { readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { signRpm } from './signing.mjs';
import { root, writeManifest } from './artifacts.mjs';

const directory = join(root, 'artifacts/desktop');
const files = (await readdir(directory)).filter(file => file.endsWith('.rpm'));
if (files.length !== 1) throw new Error('Expected one RPM artifact');
const file = join(directory, files[0]);
const signed = await signRpm(file, join(directory, 'joplinu-signing-public-key.asc'));
const target = file.replace(/(?:-(?:signed|unsigned))?\.rpm$/, signed ? '-signed.rpm' : '-unsigned.rpm');
if (target !== file) await rename(file, target);
await writeManifest(directory, 'linux-rpm', signed);
console.log(`RPM artifact ready (${signed ? 'signed' : 'unsigned'})`);
