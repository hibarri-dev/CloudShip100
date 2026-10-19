import { LogOut } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Logo } from '../Logo'
import { useAuth } from '../../context/AuthContext'
import { MobileMenuButton } from './Sidebar'
import { ModeSwitch } from './ModeSwitch'

export function CustomerTopBar({ onMenu }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-white/90 px-4 py-3 backdrop-blur md:px-6">
      <MobileMenuButton onClick={onMenu} />
      <div className="lg:hidden">
        <Logo size="sm" />
      </div>

      <div className="flex-1" />

      <ModeSwitch />

      {user ? (
        <div className="hidden text-right sm:block">
          <p className="text-xs font-semibold text-ink">{user.name}</p>
          <p className="text-[10px] text-muted">{user.email}</p>
        </div>
      ) : null}

      <button
        type="button"
        title="Sign out"
        onClick={() => {
          logout()
          navigate('/login')
        }}
        className="rounded-full border border-line p-2 text-muted hover:bg-surface"
      >
        <LogOut size={16} />
      </button>
    </header>
  )
}
