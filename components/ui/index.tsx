'use client';

import clsx from 'clsx';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export function Button({
  variant = 'default',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}) {
  return (
    <button
      {...props}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition',
        'disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm',
        variant === 'primary' && 'bg-shell-100 text-shell-950 hover:bg-white',
        variant === 'default' &&
          'border border-shell-700 bg-shell-800 text-shell-100 hover:border-shell-600 hover:bg-shell-700',
        variant === 'ghost' && 'text-shell-300 hover:bg-shell-800 hover:text-shell-100',
        variant === 'danger' && 'border border-red-900/60 text-red-300 hover:bg-red-950/50',
        className,
      )}
    />
  );
}

export function Panel({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx('rounded-lg border border-shell-800 bg-shell-900', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-shell-800 px-3.5 py-2.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-shell-400">
            {title}
          </h2>
          {actions}
        </header>
      )}
      <div className="p-3.5">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-shell-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-shell-400">{hint}</span>}
    </label>
  );
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        'w-full rounded-md border border-shell-700 bg-shell-850 px-2.5 py-1.5 text-sm',
        'text-shell-100 placeholder:text-shell-600',
        'focus:border-shell-400 focus:outline-none',
        className,
      )}
    />
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  unit = '',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs text-shell-300">{label}</span>
        <span className="font-mono text-[11px] text-shell-400">
          {Number.isInteger(value) ? value : value.toFixed(2)}
          {unit}
        </span>
      </div>
      <input
        type="range"
        className="w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'busy';
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        tone === 'neutral' && 'bg-shell-800 text-shell-300',
        tone === 'good' && 'bg-emerald-950 text-emerald-300',
        tone === 'warn' && 'bg-amber-950 text-amber-300',
        tone === 'bad' && 'bg-red-950 text-red-300',
        tone === 'busy' && 'bg-sky-950 text-sky-300',
      )}
    >
      {children}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-shell-800 px-5 py-8 text-center">
      <p className="text-sm font-medium text-shell-300">{title}</p>
      {children && <div className="mx-auto mt-1.5 max-w-md text-xs text-shell-400">{children}</div>}
    </div>
  );
}
