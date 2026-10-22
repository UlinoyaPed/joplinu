import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { toBase64 } from '../../core/src/bytes';

export async function exportMarkdown(text: string, filename: string) {
	return exportFile(text, filename, 'text/markdown;charset=utf-8');
}

export async function exportFile(data: string | Uint8Array, filename: string, mime = 'application/octet-stream') {
	if (Capacitor.isNativePlatform()) {
		const result = await Filesystem.writeFile({
			path: `exports/${crypto.randomUUID()}-${filename.replace(/[^\w.\-]/g, '_')}`,
			data: typeof data === 'string' ? data : toBase64(data),
			directory: Directory.Cache,
			...(typeof data === 'string' ? { encoding: Encoding.UTF8 } : {}),
			recursive: true,
		});
		await Share.share({ title: filename, dialogTitle: '导出 Markdown', files: [result.uri] });
		return;
	}
	const url = URL.createObjectURL(new Blob([typeof data === 'string' ? data : new Uint8Array(data)], { type: mime }));
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
