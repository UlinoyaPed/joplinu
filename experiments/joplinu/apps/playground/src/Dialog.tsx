import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';

export const DialogErrorContext = createContext('');

export function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose(): void; wide?: boolean }) {
	const ref = useRef<HTMLDialogElement>(null);
	const error = useContext(DialogErrorContext);
	const close = useRef(onClose); close.current = onClose;
	useEffect(() => {
		const dialog = ref.current!;
		const previous = document.activeElement as HTMLElement | null;
		dialog.showModal();
		const cancel = (event: Event) => { event.preventDefault(); close.current(); };
		dialog.addEventListener('cancel', cancel);
		return () => { dialog.removeEventListener('cancel', cancel); dialog.close(); previous?.focus(); };
	}, []);
	return <dialog ref={ref} className={wide ? 'app-dialog wide' : 'app-dialog'} aria-label={title}>
		<header className="dialog-header"><h2>{title}</h2><button onClick={onClose} aria-label="关闭对话框">✕</button></header>
		{error && <div role="alert" className="problem">{error}</div>}<div className="dialog-content">{children}</div>
	</dialog>;
}
