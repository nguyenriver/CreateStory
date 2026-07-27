import { Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { AppIcon } from '../../components/Shared/AppIcon';
import { Icon, appIcons } from '../../components/Shared/Icon';
import type { AuthUser } from '../../api';
import type { ThemeMode } from '../../types/theme';
import { AdminUsersPanel } from './AdminUsersPage';

interface DashboardPageProps {
  themeMode: ThemeMode;
  authUser: AuthUser;
}

export function DashboardPage(props: Readonly<DashboardPageProps>) {
  const { themeMode, authUser } = props;
  const isDark = themeMode === 'dark';
  const pageBackground = 'var(--cs-page)';

  return (
    <div className={`${isDark ? 'dark' : 'light'} min-h-screen`} style={{ background: pageBackground }}>
      <DashboardSidebar themeMode={themeMode} authUser={authUser} />
      <div className="min-h-screen pl-0 lg:pl-[260px] transition-all duration-300">
        <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard/users" replace />} />
            <Route path="/users" element={<AdminUsersPanel themeMode={themeMode} embedded />} />
            <Route path="*" element={<Navigate to="/dashboard/users" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

function DashboardSidebar(props: Readonly<{ themeMode: ThemeMode; authUser: AuthUser }>) {
  const { authUser } = props;
  const location = useLocation();
  const active = location.pathname === '/dashboard' || location.pathname.startsWith('/dashboard/users');
  const panelBackground = 'var(--cs-surface-elevated)';
  const panelBorder = 'var(--cs-border)';
  const pageText = 'var(--cs-text)';
  const secondaryText = 'var(--cs-text-soft)';
  const tertiaryText = 'var(--cs-text-faint)';
  const mutedSurface = 'var(--cs-surface-muted)';
  const activeSurface = 'var(--cs-primary-soft)';

  return (
    <aside
      className="fixed left-0 top-0 z-50 hidden h-screen w-[260px] flex-col border-r lg:flex"
      style={{ background: panelBackground, borderColor: panelBorder }}
    >
      <div className="border-b px-5 py-5" style={{ borderColor: panelBorder }}>
        <div className="flex items-center gap-3">
          <AppIcon size="xl" className="shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold" style={{ color: pageText }}>
              Dashboard
            </h1>
            <p className="truncate text-xs" style={{ color: secondaryText }}>
              {authUser.email}
            </p>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-4 py-5">
        <div className="mb-3 text-xs font-medium uppercase tracking-[0.16em]" style={{ color: tertiaryText }}>
          Admin
        </div>
        <Link
          to="/dashboard/users"
          className="flex items-center gap-3 rounded-md border px-3 py-2.5 text-sm transition-colors"
          style={{
            textDecoration: 'none',
            background: active ? activeSurface : 'transparent',
            borderColor: active ? panelBorder : 'transparent',
            color: active ? pageText : secondaryText,
          }}
        >
          <Icon icon={appIcons.users} className="h-4 w-4 shrink-0" />
          <span className="truncate font-medium">Users</span>
        </Link>
      </nav>

      <div className="border-t px-4 py-4" style={{ borderColor: panelBorder }}>
        <Link
          to="/"
          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors"
          style={{
            textDecoration: 'none',
            background: mutedSurface,
            borderColor: panelBorder,
            color: secondaryText,
          }}
        >
          <Icon icon={appIcons.back} className="h-4 w-4" />
          Back to app
        </Link>
      </div>
    </aside>
  );
}
