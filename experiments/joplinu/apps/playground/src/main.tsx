import { createRoot } from 'react-dom/client';
import { openVaultStorage } from '../../../packages/database/src/index';
import { LibraryController } from '../../../packages/library/src/controller';
import { exportFile } from '../../../packages/platform/src/export';
import { LibraryApp } from './LibraryApp';
import { sample } from './sample';
import 'katex/dist/katex.min.css';
import 'prosemirror-view/style/prosemirror.css';
import './style.css';
import './library.css';

const root = createRoot(document.getElementById('root')!);
const storage = openVaultStorage();
const controller = new LibraryController(storage);
root.render(<div className="startup">正在打开本地笔记库…</div>);
void controller.open(sample).then(() => root.render(<LibraryApp controller={controller} />)).catch(() => {
	root.render(<div className="startup"><h1>无法打开本地笔记库</h1><p role="alert">{controller.error}</p><p>原数据没有被重置。请先导出原始资料，再检查存储空间或恢复备份。</p><button onClick={() => { void storage.read().then(record => exportFile(JSON.stringify(record), 'JoplinU-raw-recovery.json', 'application/json')).catch(() => alert('数据库读取失败。请保留应用数据目录，不要卸载或清除存储。')); }}>导出原始恢复文件</button><button onClick={() => location.reload()}>重试打开</button></div>);
});
