import { readdir, rename, open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { root, writeManifest } from './artifacts.mjs';

if (process.platform !== 'win32') throw new Error('Inspect Windows artifacts on a Windows host');
if (process.env.CSC_KEY_PASSWORD && !process.env.CSC_LINK) throw new Error('Windows signing password configured without certificate');
const directory = join(root, 'artifacts/windows');
const files = (await readdir(directory)).filter(file => file.endsWith('.exe'));
if (files.length !== 1) throw new Error('Expected exactly one Windows installer');
const file = join(directory, files[0]); const handle = await open(file, 'r');
try { const magic = Buffer.alloc(2); await handle.read(magic, 0, 2, 0); if (magic.toString('ascii') !== 'MZ' || (await handle.stat()).size < 1024 * 1024) throw new Error('Invalid Windows installer'); }
finally { await handle.close(); }
const status = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$signature = Get-AuthenticodeSignature -LiteralPath $env:JOPLINU_BUILD_INSPECT_EXE; [int]$signature.Status'], { env: { ...process.env, JOPLINU_BUILD_INSPECT_EXE: file }, encoding: 'utf8' }).trim();
if (!['0', '2'].includes(status)) throw new Error('Windows installer signature verification failed');
const signed = status === '0';
if (process.env.CSC_LINK && !signed) throw new Error('Configured Windows certificate did not produce a verified signature');
const target = file.replace(/(?:-(?:signed|unsigned))?\.exe$/, signed ? '-signed.exe' : '-unsigned.exe');
if (target !== file) await rename(file, target);
await writeManifest(directory, 'windows-nsis', signed);
console.log(`Windows installer ready (${signed ? 'signed' : 'unsigned'})`);
