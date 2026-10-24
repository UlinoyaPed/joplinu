import { useRef } from 'react';

/** Preview width in CSS; persist one preference change at the end of the gesture. */
export function PaneResizer({ label, property, value, min, max, initial, onChange }: {
	label: string; property: string; value: number; min: number; max: number; initial: number; onChange(value: number): void;
}) {
	const drag = useRef<{ pointer: number; x: number; width: number; next: number } | undefined>(undefined);
	const preview = (target: HTMLElement, width: number) => (target.closest('.library-shell') as HTMLElement | null)?.style.setProperty(property, `${width}px`);
	const clamp = (width: number) => Math.max(min, Math.min(max, Math.round(width)));
	return <div className={`pane-resizer ${property === '--sidebar-width' ? 'sidebar-resizer' : 'list-resizer'}`} role="separator" tabIndex={0}
		aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
		title={`${label} · 拖动或使用方向键，双击重置`}
		onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { pointer: event.pointerId, x: event.clientX, width: value, next: value }; }}
		onPointerMove={event => { const current = drag.current; if (!current || current.pointer !== event.pointerId) return; current.next = clamp(current.width + event.clientX - current.x); preview(event.currentTarget, current.next); }}
		onPointerUp={event => { const current = drag.current; if (!current || current.pointer !== event.pointerId) return; drag.current = undefined; onChange(current.next); event.currentTarget.releasePointerCapture(event.pointerId); }}
		onLostPointerCapture={event => { if (drag.current) { drag.current = undefined; preview(event.currentTarget, value); } }}
		onDoubleClick={() => onChange(initial)}
		onKeyDown={event => {
			const next = event.key === 'ArrowLeft' ? value - 10 : event.key === 'ArrowRight' ? value + 10 : event.key === 'Home' ? min : event.key === 'End' ? max : undefined;
			if (next !== undefined) { event.preventDefault(); onChange(clamp(next)); }
		}} />;
}
