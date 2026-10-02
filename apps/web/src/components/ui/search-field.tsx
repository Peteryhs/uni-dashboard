import { useRef } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import './search-field.css';

export function SearchField({ value, onValueChange, label, placeholder, clearLabel = 'Clear search', className }: {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  placeholder: string;
  clearLabel?: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <div className={cn('search-field', className)} role="search" aria-label={label}>
    <Search size={16} strokeWidth={1.7} aria-hidden="true" />
    <input ref={input} type="search" aria-label={label} placeholder={placeholder} value={value} onChange={event => onValueChange(event.target.value)} />
    <button type="button" className="search-field-clear" aria-label={clearLabel} disabled={!value} onClick={() => { onValueChange(''); input.current?.focus(); }}><X size={14} strokeWidth={1.7} aria-hidden="true" /></button>
  </div>;
}
