import { useEffect, useRef, useState } from 'react';
import { IconInfoCircle } from '@tabler/icons-react';

export function FieldHelp({ id, label, children }: { id: string; label: string; children: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);

  return <span ref={root} className="field-help" onMouseEnter={() => setOpen(true)}
    onMouseLeave={() => { if (!root.current?.contains(document.activeElement)) setOpen(false); }}>
    <button type="button" className="field-help__button" aria-label={`${label} 도움말`} aria-describedby={id}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}>
      <IconInfoCircle size={18} aria-hidden="true" />
    </button>
    <span id={id} role="tooltip" className="field-help__tooltip" hidden={!open}>{children}</span>
  </span>;
}
