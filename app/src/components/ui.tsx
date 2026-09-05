import { clsx } from 'clsx'
import type { ComponentProps, ReactNode } from 'react'

export function Card({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      className={clsx('rounded-2xl border border-line bg-paper p-4 shadow-sm', className)}
      {...rest}
    />
  )
}

export function Label({ className, ...rest }: ComponentProps<'label'>) {
  return <label className={clsx('block text-sm font-semibold text-ink', className)} {...rest} />
}

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return (
    <input
      className={clsx(
        'tap w-full rounded-xl border border-line-strong bg-paper px-3.5 text-base text-ink',
        'placeholder:text-muted/70 focus:border-link focus:ring-2 focus:ring-link/25 focus:outline-none',
        className,
      )}
      {...rest}
    />
  )
}

type ButtonProps = ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'quiet' }

export function Button({ className, variant = 'primary', ...rest }: ButtonProps) {
  return (
    <button
      className={clsx(
        'tap-lg inline-flex items-center justify-center gap-2 rounded-xl px-5 text-base font-semibold',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        variant === 'primary' && 'bg-ink text-white hover:bg-ink-2',
        variant === 'secondary' && 'border border-line-strong bg-paper text-ink hover:bg-ground',
        variant === 'quiet' && 'text-link hover:text-link-hi',
        className,
      )}
      {...rest}
    />
  )
}

export function Notice({ tone = 'alert', children }: { tone?: 'alert' | 'info'; children: ReactNode }) {
  return (
    <p
      role="alert"
      className={clsx(
        'rounded-xl px-3.5 py-3 text-sm font-medium',
        tone === 'alert' ? 'bg-alert-soft text-alert' : 'bg-accent-soft text-accent',
      )}
    >
      {children}
    </p>
  )
}

/** Live / waiting / done are the only three status colours in the product (SPEC D3). */
export function StatusDot({ state }: { state: 'live' | 'waiting' | 'done' }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'inline-block size-2.5 rounded-full',
        state === 'live' && 'bg-live',
        state === 'waiting' && 'bg-waiting',
        state === 'done' && 'bg-done',
      )}
    />
  )
}
