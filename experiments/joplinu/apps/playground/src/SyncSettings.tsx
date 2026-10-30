import { useState, useSyncExternalStore } from 'react';
import type { LibraryController } from '../../../packages/library/src/controller';
import { formatDate } from '../../../packages/library/src/model';
import { cloudBridge, cloudValue, cloudErrorMessage, CloudError, HostStorageProvider } from '../../../packages/platform/src/cloud';
import { recoveryCode, syncSession } from '../../../packages/sync/src/engine';

export async function configuredProvider() {
	const bridge = cloudBridge(); if (!bridge) throw new Error('请在原生客户端使用云同步');
	const info = await cloudValue(bridge.info()); if (!info.configured || !info.config) throw new Error('请先保存下方的云存储配置');
	return new HostStorageProvider(info.config.kind, bridge, info.config);
}
export function SyncSettings({ controller }: { controller: LibraryController }) {
	const engine = syncSession(controller); useSyncExternalStore(engine.subscribe, engine.getSnapshot);
	const [mode, setMode] = useState<'create' | 'join'>('create'); const [code, setCode] = useState('');
	const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState('');
	const [keyAction, setKeyAction] = useState<'rotate' | 'join'>('rotate');
	const state = controller.syncState;
	const run = async (action: () => Promise<void>, success = '') => {
		setError(''); setMessage('');
		try { await action(); setMessage(success); }
		catch (problem) { setError(problem instanceof CloudError ? cloudErrorMessage(problem) : problem instanceof Error ? problem.message : '同步失败，请重试'); }
		finally { setPassword(''); setConfirm(''); }
	};
	if (!cloudBridge()) return <p className="hint">加密云同步需要桌面或 Android 原生客户端。</p>;
	return <section className="sync-settings"><h4>加密笔记同步</h4>
		<p className="hint">正文、标题、文件夹、标签、附件及历史在本机加密后上传。同步密码只用于解锁本次会话，不会交给云服务。请妥善保存恢复码、密码和独立备份。</p>
		{!state ? <form onSubmit={event => { event.preventDefault(); void run(async () => {
			if (mode === 'create') { if (password !== confirm) throw new Error('两次输入的密码不一致'); await engine.create(password); }
			else await engine.join(await configuredProvider(), code.trim(), password);
			setPassword(''); setConfirm(''); await engine.sync(await configuredProvider());
		}, '同步库已连接，本轮同步完成。'); }}>
			<label className="setting-field">连接方式<select value={mode} disabled={engine.busy} onChange={event => setMode(event.target.value as 'create' | 'join')}><option value="create">创建新的加密同步库</option><option value="join">加入已有加密同步库</option></select></label>
			{mode === 'join' && <><label className="setting-field">恢复码<input required value={code} disabled={engine.busy} onChange={event => setCode(event.target.value)} autoComplete="off" /></label><p className="hint">远端笔记会与本机笔记合并，保留双方内容。</p></>}
			<label className="setting-field">同步密码<input required minLength={12} maxLength={1024} type="password" disabled={engine.busy} value={password} onChange={event => setPassword(event.target.value)} autoComplete={mode === 'create' ? 'new-password' : 'current-password'} /></label>
			{mode === 'create' && <label className="setting-field">再次输入密码<input required type="password" disabled={engine.busy} value={confirm} onChange={event => setConfirm(event.target.value)} autoComplete="new-password" /></label>}
			<button className="primary" disabled={engine.busy} type="submit">{engine.busy ? '正在连接…' : mode === 'create' ? '创建并同步' : '加入并同步'}</button>
		</form> : <>
			<label className="setting-field">恢复码<input readOnly value={recoveryCode(state.manifest)} aria-label="同步恢复码" onFocus={event => event.target.select()} /></label><p className="hint">在另一设备填写相同的云存储配置、恢复码与密码即可加入。恢复码不包含解密密钥。</p>
			{!engine.unlocked ? <form onSubmit={event => { event.preventDefault(); void run(async () => { await engine.unlock(password); setPassword(''); await engine.sync(await configuredProvider()); }, '已解锁，本轮同步完成。'); }}><label className="setting-field">解锁同步密码<input required type="password" value={password} disabled={engine.busy} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label><button className="primary" disabled={engine.busy}>解锁并同步</button></form> : <div className="button-row"><button className="primary" disabled={engine.busy} onClick={() => void run(async () => engine.sync(await configuredProvider()), '本轮同步完成。')}>{engine.busy ? '正在同步…' : '立即同步'}</button><button disabled={engine.busy} onClick={() => void run(async () => engine.sync(await configuredProvider(), true), '远端对象认证、摘要和历史完整性检查通过。')}>检查远端完整性</button><button disabled={engine.busy} onClick={() => void run(async () => engine.snapshot(await configuredProvider()), '加密恢复快照已创建，原始更新历史继续保留。')}>创建恢复快照</button><button disabled={engine.busy} onClick={() => engine.lock()}>锁定同步密钥</button></div>}
			<label className="setting-toggle"><span>自动同步<small>前台解锁后每分钟同步；Android 系统任务只传输已加密队列。关闭可暂停两者。</small></span><input type="checkbox" checked={state.autoSync} disabled={engine.busy} onChange={event => void run(() => controller.saveSyncState({ ...controller.syncState!, autoSync: event.target.checked }))} /></label>
			<p className="hint">待上传加密对象：{state.outbox.length} · {engine.unlocked ? '密钥已解锁' : '密钥已锁定'}<br />{state.lastSync ? `上次同步完成：${formatDate(state.lastSync, controller.vault.preferences)}` : '尚未完成首次同步'}</p>
			{engine.unlocked && <details><summary>主密钥与其他设备</summary><p className="hint">更换主密钥会重加密完整历史，生成新的恢复码。旧仓库保留，旧密钥仍可读取旧历史；新库及后续编辑使用新密钥。请先完成其他设备同步并保存独立备份。其他设备使用“加入新密钥库”迁移其离线编辑和历史。</p><form onSubmit={event => { event.preventDefault(); void run(async () => {
				if (keyAction === 'rotate') { if (password !== confirm) throw new Error('两次输入的密码不一致'); await engine.changeKey(await configuredProvider(), password); }
				else await engine.joinChangedKey(await configuredProvider(), code.trim(), password);
			}, '已切换到新密钥库并完成同步，请保存上方的新恢复码。旧仓库保持原样。'); }}>
				<label className="setting-field">密钥操作<select value={keyAction} disabled={engine.busy} onChange={event => setKeyAction(event.target.value as 'rotate' | 'join')}><option value="rotate">更换主密钥并创建新恢复码</option><option value="join">加入另一设备创建的新密钥库</option></select></label>
				{keyAction === 'join' && <label className="setting-field">新恢复码<input required value={code} disabled={engine.busy} onChange={event => setCode(event.target.value)} autoComplete="off" /></label>}
				<label className="setting-field">新同步密码<input required minLength={12} maxLength={1024} type="password" value={password} disabled={engine.busy} onChange={event => setPassword(event.target.value)} autoComplete={keyAction === 'rotate' ? 'new-password' : 'current-password'} /></label>
				{keyAction === 'rotate' && <label className="setting-field">确认新密码<input required type="password" value={confirm} disabled={engine.busy} onChange={event => setConfirm(event.target.value)} autoComplete="new-password" /></label>}
				<button disabled={engine.busy} type="submit">{keyAction === 'rotate' ? '重加密并更换主密钥' : '保留本机编辑并加入新密钥库'}</button>
			</form></details>}
		</>}
		{engine.progress && <p role="status">{engine.progress}</p>}{engine.pendingRemoteCount > 0 && <p role="status">远端待应用更新：{engine.pendingRemoteCount}</p>}{(error || engine.error) && <p role={engine.status === 'waiting' ? 'status' : 'alert'}>{error || engine.error}</p>}{message && <p role="status">{message}</p>}{controller.syncRecoveryNote && <p role="status">{controller.syncRecoveryNote}</p>}
		<p className="hint">恢复快照可加快新设备初始化，全部云端更新继续保留。锁定只移除会话密钥，已加密队列仍可后台传输；关闭自动同步可暂停上传。云端仍可删除或回滚数据，请定期保留独立加密备份。</p>
	</section>;
}
