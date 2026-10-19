import { Filter, Search, LogOut } from 'lucide-react'
import { Logo } from '../Logo'
import { useAuth } from '../../context/AuthContext'
import { useNavigate } from 'react-router-dom'
import { MobileMenuButton } from './Sidebar'
import { ModeSwitch } from './ModeSwitch'

export function TopBar({ onMenu }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-white/90 px-4 py-3 backdrop-blur md:px-6">
      <MobileMenuButton onClick={onMenu} />
      <div className="hidden lg:block xl:hidden">
        <Logo size="sm" />
      </div>

      <div className="relative min-w-0 flex-1">
        <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
        <input
          type="search"
          placeholder="Search Here"
          className="w-full rounded-full border border-transparent bg-surface py-2.5 pl-10 pr-4 text-sm outline-none ring-brand/30 placeholder:text-muted focus:border-brand/30 focus:ring-2"
        />
      </div>

      <select
        defaultValue="This Month"
        className="hidden rounded-full border border-line bg-white px-3 py-2 text-sm font-semibold text-ink sm:block"
      >
        <option>This Month</option>
        <option>This Week</option>
        <option>This Year</option>
      </select>

      <button
        type="button"
        className="inline-flex items-center gap-2 rounded-full bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-brand/20 hover:brightness-105"
      >
        <Filter size={16} />
        Filter
      </button>

      <ModeSwitch />

      <div className="hidden items-center gap-3 md:flex">
        <Logo size="md" />
      </div>

      <button
        type="button"
        title="Sign out"
        onClick={() => {
          logout()
          navigate('/ops/login')
        }}
        className="rounded-full border border-line p-2 text-muted hover:bg-surface"
      >
        <LogOut size={16} />
      </button>
      {user ? (
        <div className="hidden text-right sm:block">
          <p className="text-xs font-semibold text-ink">{user.name}</p>
          <p className="text-[10px] uppercase tracking-wide text-muted">{user.role}</p>
        </div>
      ) : null}
    </header>
  )
}
