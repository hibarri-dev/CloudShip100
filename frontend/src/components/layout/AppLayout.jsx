import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { IconRail } from './IconRail'
import { ModeBanner } from './ModeSwitch'

export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setSidebarOpen(true)} />
        <ModeBanner />
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-x-hidden p-4 md:p-6">
            <Outlet />
          </main>
          <IconRail />
        </div>
      </div>
    </div>
  )
}
