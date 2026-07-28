import { useState } from 'react';
import { useLocation, Link } from 'react-router';
import type { AuthUser } from '../../api';
import { AppIcon } from './AppIcon';
import { Icon, appIcons } from './Icon';
import type { ThemeMode } from '../../types/theme';
import { getVisibleNavSections, navActive } from '../../utils/navigation';
import { getThemeTokens } from './design';

interface SidebarProps {
    themeMode: ThemeMode;
    onOpenSettings: () => void;
    authUser: AuthUser;
    onLogout: () => void;
}

const NAV_ICONS = {
    '/': 'add',
    '/goodnovel-batch': 'batch',
    '/inkitt-batch': 'batch',
    '/novelhall-batch': 'batch',
    '/jobnib-batch': 'batch',
    '/results/all': 'crawlHistory',
    '/bedread/jobs': 'audioJobs',
    '/drive-sync': 'sync',
    '/drive-sync/history': 'syncHistory',
    '/drive-sync/content-update': 'contentUpdate',
    '/drive-sync/cover-update': 'image',
    '/drive-sync/banner-update': 'image',
    '/drive-sync/intro-update': 'image',
    '/drive-sync/metadata-update': 'info',
    '/drive-sync/title-update': 'edit',
    '/auto-audio': 'autoAudio',
    '/auto-audio/history': 'syncHistory',
    '/tools/gemini-watermark-remover': 'image',
    '/tools/fix-watermark-pictures': 'image',
    '/supported-sites': 'supportedSites',
    '/dashboard': 'dashboardUsers',
} as const;

export function Sidebar({
    themeMode,
    onOpenSettings,
    authUser,
    onLogout,
}: Readonly<SidebarProps>) {
    const location = useLocation();
    const tokens = getThemeTokens(themeMode);
    const isDark = tokens.isDark;
    const [hoveredItem, setHoveredItem] = useState<string | null>(null);
    const navSections = getVisibleNavSections(authUser.role);

    const renderIcon = (iconKey: keyof typeof appIcons) => {
        if (iconKey === 'sync') {
            return (
                <svg viewBox="0 0 192 192" fill="none" className="w-4 h-4 flex-shrink-0">
                    <mask id="gdrive-mask-a" width="168" height="154" x="12" y="18" maskUnits="userSpaceOnUse" style={{ maskType: 'alpha' }}>
                        <path fill="#b43333" d="M63.09 37c14.626-25.333 51.193-25.334 65.819 0l45.033 78c14.626 25.334-3.657 57.001-32.91 57.001H50.967c-29.253 0-47.536-31.667-32.91-57.001z"/>
                    </mask>
                    <g mask="url(#gdrive-mask-a)">
                        <path fill="url(#gdrive-grad-b)" d="M206.905 172.02h-91.888l-19.015-32.934 45.944-79.578z"/>
                        <path fill="url(#gdrive-grad-c)" d="M-14.919 172.006 50.04 59.494v.002L31.032 92.422h38.02L115 172.004l-129.918.001z"/>
                        <path fill="url(#gdrive-grad-d)" d="M96.007-20.085 141.954 59.5l-19.011 32.928H31.048z"/>
                    </g>
                    <defs>
                        <linearGradient id="gdrive-grad-b" x1="193.6" x2="103.09" y1="165.6" y2="111.21" gradientUnits="userSpaceOnUse">
                            <stop offset=".09" stopColor="#ffe921"/>
                            <stop offset="1" stopColor="#fec700"/>
                        </linearGradient>
                        <linearGradient id="gdrive-grad-c" x1="114.4" x2="15.53" y1="181.61" y2="121.8" gradientUnits="userSpaceOnUse">
                            <stop offset=".15" stopColor="#a9a8ff"/>
                            <stop offset=".33" stopColor="#6d97ff"/>
                            <stop offset=".48" stopColor="#3186ff"/>
                        </linearGradient>
                        <linearGradient id="gdrive-grad-d" x1="128.88" x2="28.7" y1="37.88" y2="84.64" gradientUnits="userSpaceOnUse">
                            <stop offset=".55" stopColor="#0ebc5f"/>
                            <stop offset=".85" stopColor="#78c9ff"/>
                        </linearGradient>
                    </defs>
                </svg>
            );
        }
        return <Icon icon={appIcons[iconKey]} className="w-3.5 h-3.5" />;
    };

    const makeNavItem = (item: { to: string; label: string; iconKey: string }) => {
        const resolvedIcon = NAV_ICONS[item.iconKey as keyof typeof NAV_ICONS] as keyof typeof appIcons;
        const active = navActive(location.pathname, item.to);

        if (item.to === '/') {
            return (
                <Link
                    key={item.to}
                    to={item.to}
                    className="group relative my-2 flex min-h-10 items-center justify-center gap-2 rounded-full border px-3 py-2 text-xs font-bold transition-all duration-150"
                    style={{
                        textDecoration: 'none',
                        background: active ? tokens.colors.primary : tokens.colors.primarySoft,
                        borderColor: active ? tokens.colors.primary : isDark ? 'rgba(255,91,0,0.25)' : 'rgba(255,91,0,0.18)',
                        color: active ? '#ffffff' : tokens.colors.primary,
                        boxShadow: active ? '0 12px 28px rgba(255,91,0,0.22)' : 'none',
                    }}
                >
                    <span className="flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center">
                        {renderIcon(resolvedIcon)}
                    </span>
                    <span>{item.label}</span>
                </Link>
            );
        }

        const hovered = hoveredItem === item.to;
        const background = active ? tokens.colors.active : hovered ? tokens.colors.surfaceMuted : 'transparent';
        const color = active ? tokens.colors.activeText : hovered ? tokens.colors.text : tokens.colors.textSoft;

        let badgeText: string | null = null;
        let badgeColor = 'transparent';
        let badgeTextColor = tokens.colors.textMuted;

        if (item.to === '/auto-audio') {
            badgeText = 'AI';
            badgeColor = isDark ? 'rgba(255,91,0,0.12)' : 'rgba(255,91,0,0.08)';
            badgeTextColor = '#ff5b00';
        } else if (item.to === '/drive-sync') {
            badgeText = 'Cloud';
            badgeColor = isDark ? 'rgba(59,130,246,0.12)' : 'rgba(29,78,216,0.08)';
            badgeTextColor = isDark ? '#60a5fa' : '#1d4ed8';
        }

        return (
            <Link
                key={item.to}
                to={item.to}
                className="group relative flex min-h-9 items-center gap-2 rounded-full px-3 py-2 transition-all duration-150"
                style={{
                    textDecoration: 'none',
                    background,
                    color,
                }}
                onMouseEnter={() => setHoveredItem(item.to)}
                onMouseLeave={() => setHoveredItem(null)}
            >
                <span
                    className="flex h-5 w-5 flex-shrink-0 items-center justify-center transition-colors duration-150"
                    style={{ color }}
                >
                    {renderIcon(resolvedIcon)}
                </span>

                <span
                    className="min-w-0 flex-1 whitespace-normal break-words text-xs font-semibold tracking-[0.01em] transition-colors duration-150"
                    style={{ color }}
                >
                    {item.label}
                </span>

                {badgeText && (
                    <span 
                        className="rounded-full px-1.5 py-0.5 text-[9px] font-bold leading-none scale-90"
                        style={{ background: badgeColor, color: badgeTextColor }}
                    >
                        {badgeText}
                    </span>
                )}
            </Link>
        );
    };

    return (
        <aside
            className="hidden lg:flex fixed bottom-0 left-0 top-0 z-40 flex-col overflow-hidden border-r transition-colors duration-200"
            style={{
                width: 260,
                background: isDark ? tokens.colors.surfaceElevated : '#f9fafb',
                borderColor: tokens.colors.border,
                boxShadow: 'none',
            }}
        >
            <div
                className="flex items-center gap-3"
                style={{
                    padding: '20px 20px 12px',
                }}
            >
                <div
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg"
                >
                    <AppIcon size="md" className="flex-shrink-0" />
                </div>
                <div className="flex-1 min-w-0">
                    <h1
                        className="text-sm font-semibold"
                        style={{ color: tokens.colors.text }}
                    >
                        CreateStory
                    </h1>
                    <p className="text-xs" style={{ color: tokens.colors.textMuted }}>
                        Workspace
                    </p>
                </div>
                <button
                    type="button"
                    className="cs-icon-button flex-shrink-0"
                    onClick={onOpenSettings}
                    onMouseEnter={() => setHoveredItem('/settings')}
                    onMouseLeave={() => setHoveredItem(null)}
                    aria-label="Open settings"
                >
                    <Icon icon={appIcons.settings} className="w-4 h-4" />
                </button>
            </div>

            <nav
                className="flex-1 overflow-y-auto"
                style={{
                    padding: '8px 8px 16px',
                }}
            >
                {navSections.map((section) => (
                    <div key={section.label} style={{ marginTop: 12 }}>
                        <p
                            className="px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.16em]"
                            style={{ color: tokens.colors.textFaint }}
                        >
                            {section.label}
                        </p>
                        <div className="space-y-1">
                            {section.items.map((item) => makeNavItem(item))}
                        </div>
                    </div>
                ))}
            </nav>

            <div
                className="border-t px-3 py-3"
                style={{ borderColor: tokens.colors.border }}
            >
                <div className="mb-2 min-w-0 rounded-2xl border px-3 py-2" style={{ borderColor: tokens.colors.border, background: tokens.colors.surfaceMuted }}>
                    <p className="break-words text-[11px] font-semibold leading-4" style={{ color: tokens.colors.text }}>
                        {authUser.email}
                    </p>
                    <p className="text-[10px] capitalize" style={{ color: tokens.colors.textMuted }}>
                        {authUser.role}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={onLogout}
                    className="cs-btn-logout flex w-full items-center justify-center gap-2 rounded-full px-3 py-2 text-xs font-semibold"
                >
                    <Icon icon={appIcons.logout} className="h-3.5 w-3.5" />
                    Sign out
                </button>
            </div>
        </aside>
    );
}

export default Sidebar;
