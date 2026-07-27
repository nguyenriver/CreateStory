import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { AuthUser } from '../../api';
import type { ThemeMode } from '../../types/theme';
import { getVisibleNavSections, navActive } from '../../utils/navigation';
import { AccountMenu } from './AccountMenu';
import { AppIcon } from './AppIcon';
import { Icon, appIcons } from './Icon';
import { getThemeTokens } from './design';

interface AppHeaderProps {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  onOpenSettings: () => void;
  authUser: AuthUser;
  onLogout: () => void;
}

const QUICK_MODULES = [
  { label: 'Crawler', to: '/', icon: 'crawl' },
  { label: 'Drive', to: '/drive-sync', icon: 'sync' },
  { label: 'Audio', to: '/auto-audio', icon: 'autoAudio' },
] as const;

export function AppHeader({
  themeMode,
  onThemeChange,
  onOpenSettings,
  authUser,
  onLogout,
}: Readonly<AppHeaderProps>) {
  const location = useLocation();
  const tokens = getThemeTokens(themeMode);
  const [accountOpen, setAccountOpen] = useState(false);

  const currentItem = useMemo(() => {
    for (const section of getVisibleNavSections(authUser.role)) {
      const match = section.items.find((item) => navActive(location.pathname, item.to));
      if (match) return match;
    }
    return null;
  }, [authUser.role, location.pathname]);

  return (
    <header className="cs-topbar hidden lg:flex">
      <div className="cs-topbar__brand">
        <span className="cs-topbar__logo">
          <AppIcon size="md" />
        </span>
        <div className="min-w-0">
          <p className="cs-topbar__name">CreateStory</p>
          <p className="cs-topbar__caption">Novel workspace</p>
        </div>
      </div>

      <nav className="cs-topbar__modules" aria-label="Primary modules">
        {QUICK_MODULES.map((module) => {
          const active = navActive(location.pathname, module.to);
          return (
            <Link
              key={module.to}
              to={module.to}
              className={`cs-module-chip ${active ? 'cs-module-chip--active' : ''}`}
              style={{ textDecoration: 'none' }}
            >
              <Icon icon={appIcons[module.icon]} className="h-3.5 w-3.5" />
              <span>{module.label}</span>
            </Link>
          );
        })}
      </nav>

      <Link to={currentItem?.to ?? '/'} className="cs-route-search" style={{ textDecoration: 'none' }}>
        <Icon icon={appIcons.search} className="h-3.5 w-3.5" />
        <span className="min-w-0 flex-1 truncate">
          Search "{currentItem?.label ?? 'CreateStory'}"
        </span>
        <kbd>/</kbd>
      </Link>

      <div className="cs-topbar__actions">
        <button
          type="button"
          className="cs-submit-chip"
          onClick={onOpenSettings}
        >
          <Icon icon={appIcons.settings} className="h-3.5 w-3.5" />
          Settings
        </button>
        <button
          type="button"
          className="cs-icon-button"
          onClick={() => onThemeChange(themeMode === 'dark' ? 'light' : 'dark')}
          aria-label={`Switch to ${themeMode === 'dark' ? 'light' : 'dark'} theme`}
          title={`Switch to ${themeMode === 'dark' ? 'light' : 'dark'} theme`}
        >
          <Icon icon={themeMode === 'dark' ? appIcons.themeLight : appIcons.moon} className="h-4 w-4" />
        </button>
        <div className="relative">
          <AccountMenu
            authUser={authUser}
            isDark={tokens.isDark}
            isOpen={accountOpen}
            onToggle={() => setAccountOpen((open) => !open)}
            onClose={() => setAccountOpen(false)}
            onLogout={onLogout}
            placement="topbar"
          />
        </div>
      </div>
    </header>
  );
}

export default AppHeader;
