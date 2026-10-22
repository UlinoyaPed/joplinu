import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export async function exportMarkdown(text: string, filename: string) {
	if (Capacitor.isNativePlatform()) {
		const result = await Filesystem.writeFile({
			path: `exports/${crypto.randomUUID()}-${filename.replace(/[^\w.\-]/g, '_')}`,
			data: text,
			directory: Directory.Cache,
			encoding: Encoding.UTF8,
			recursive: true,
		});
		await Share.share({ title: filename, dialogTitle: '导出 Markdown', files: [result.uri] });
		return;
	}
	const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
