import {
  FileText,
  Users,
  Receipt,
  DollarSign,
  BarChart3,
  Settings,
  Plus,
  LayoutDashboard,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { SidebarPlatformFooter } from '@bigbluebam/ui/sidebar-footer';

interface BillSidebarProps {
  onNavigate: (path: string) => void;
  activePage: string;
}

const navItems = [
  { label: 'Dashboard', icon: LayoutDashboard, path: '/', page: 'dashboard' },
  { label: 'Invoices', icon: FileText, path: '/invoices', page: 'invoices' },
  { label: 'Clients', icon: Users, path: '/clients', page: 'clients' },
  { label: 'Expenses', icon: Receipt, path: '/expenses', page: 'expenses' },
  { label: 'Rates', icon: DollarSign, path: '/rates', page: 'rates' },
  { label: 'Reports', icon: BarChart3, path: '/reports', page: 'reports' },
];

const settingsItems = [
  { label: 'Bill Settings', icon: Settings, path: '/settings', page: 'settings' },
];

export function BillSidebar({ onNavigate, activePage }: BillSidebarProps) {
  const user = useAuthStore((s) => s.user);
  return (
    <div className="flex flex-col h-full">
      {/* Logo area */}
      <div className="flex items-center gap-2 px-4 h-14 shrink-0">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-green-600 text-white font-bold text-sm">
          <DollarSign className="h-4.5 w-4.5" />
        </div>
        <span className="text-sm font-semibold text-white">Bill</span>
      </div>

      {/* Quick actions */}
      <div className="px-2 pb-2">
        <button
          onClick={() => onNavigate('/invoices/new')}
          className="flex items-center gap-2 w-full rounded-lg px-3 py-2 text-sm font-medium text-green-400 bg-green-500/10 hover:bg-green-500/20 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Invoice
        </button>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto custom-scrollbar">
        {navItems.map((item) => {
          const isActive = activePage === item.page;
          const Icon = item.icon;
          return (
            <button
              key={item.path}
              onClick={() => onNavigate(item.path)}
              className={cn(
                'flex items-center gap-3 w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-sidebar-active text-white'
                  : 'text-zinc-400 hover:bg-sidebar-hover hover:text-zinc-200',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </button>
          );
        })}

        <div className="pt-4 pb-1 px-3">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Bill Settings</span>
        </div>

        {settingsItems.map((item) => {
          const isActive = activePage === item.page;
          const Icon = item.icon;
          return (
            <button
              key={item.path}
              onClick={() => onNavigate(item.path)}
              className={cn(
                'flex items-center gap-3 w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-sidebar-active text-white'
                  : 'text-zinc-400 hover:bg-sidebar-hover hover:text-zinc-200',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </button>
          );
        })}
      </nav>

      <SidebarPlatformFooter user={user} />
    </div>
  );
}
