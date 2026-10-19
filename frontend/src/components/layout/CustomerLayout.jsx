import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { CustomerTopBar } from './CustomerTopBar'
import { customerNav } from '../../navigation/nav'
import { ModeBanner } from './ModeSwitch'

export function CustomerLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} nav={customerNav} />
      <div className="flex min-w-0 flex-1 flex-col">
        <CustomerTopBar onMenu={() => setSidebarOpen(true)} />
        <ModeBanner />
        <main className="min-w-0 flex-1 overflow-x-hidden p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
