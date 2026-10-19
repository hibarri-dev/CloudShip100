import { getMode, setMode } from '../../services/mode'

// Stripe-style Test/Live switch. Test mode shows only sandbox data (simulated carriers, nothing real).
export function ModeSwitch() {
  const mode = getMode()
  const options = [
    ['live', 'Live'],
    ['test', 'Test'],
  ]

  return (
    <div
      role="group"
      aria-label="Data mode"
      className="inline-flex rounded-full border border-line bg-surface p-0.5 text-xs font-semibold"
    >
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          onClick={() => mode !== value && setMode(value)}
          className={`rounded-full px-3 py-1.5 transition-colors ${
            mode === value
              ? value === 'test'
                ? 'bg-amber-500 text-white shadow-sm'
                : 'bg-brand-gradient text-white shadow-sm'
              : 'text-muted hover:text-ink'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export function ModeBanner() {
  if (getMode() !== 'test') return null
  return (
    <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-900">
      <strong>Test mode.</strong> You are viewing sandbox data only. Carriers are simulated and nothing here is real.
      Switch to Live to see your real orders.
    </div>
  )
}
