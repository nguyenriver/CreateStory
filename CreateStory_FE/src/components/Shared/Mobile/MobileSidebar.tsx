import { useState } from 'react';
import { useLocation, Link } from 'react-router';
import type { AuthUser } from '../../../api';
import { AppIcon } from '../AppIcon';
import { Icon, appIcons } from '../Icon';
import type { ThemeMode } from '../../../types/theme';
import { getVisibleNavSections, navActive } from '../../../utils/navigation';
import { getThemeTokens } from '../design';

interface MobileSidebarProps {
    themeMode: ThemeMode;
    onOpenSettings: () => void;
    authUser: AuthUser;
    isOpen: boolean;
    onClose: () => void;
}

type NavItem = { to: string; label: string; iconKey: string };

const NAV_ICONS_MOBILE: Record<string, keyof typeof appIcons> = {
    '/': 'add',
    '/goodnovel-batch': 'batch',
    '/inkitt-batch': 'batch',
    '/novelhall-batch': 'batch',
    '/readnovelmtl-batch': 'batch',
    '/jobnib-batch': 'batch',
    '/results/all': 'crawlHistory',
    '/bedread/jobs': 'audioJobs',
    '/drive-sync': 'sync',
    '/drive-sync/history': 'syncHistory',
    '/drive-sync/content-update': 'contentUpdate',
    '/drive-sync/cover-update': 'image',
    '/drive-sync/banner-update': 'flag',
    '/drive-sync/intro-update': 'flag',
    '/drive-sync/metadata-update': 'info',
    '/drive-sync/title-update': 'edit',
    '/auto-audio': 'autoAudio',
    '/auto-audio/history': 'syncHistory',
    '/tools/gemini-watermark-remover': 'image',
    '/supported-sites': 'supportedSites',
    '/dashboard': 'dashboardUsers',
};

export function MobileSidebar({
    themeMode,
    onOpenSettings,
    authUser,
    isOpen,
    onClose,
}: Readonly<MobileSidebarProps>) {
    const location = useLocation();
    const tokens = getThemeTokens(themeMode);
    const isDark = tokens.isDark;
    const [hoveredItem, setHoveredItem] = useState<string | null>(null);
    const navSections = getVisibleNavSections(authUser.role);

    const makeNavItem = (item: NavItem) => {
        const iconKey = NAV_ICONS_MOBILE[item.iconKey] ?? 'add';
        const active = navActive(location.pathname, item.to);

        if (item.to === '/') {
            return (
                <Link
                    key={item.to}
                    to={item.to}
                    onClick={onClose}
                    className="group relative my-2 flex min-h-11 items-center justify-center gap-2 rounded-full border px-4 py-2.5 text-sm font-bold transition-all duration-150"
                    style={{
                        textDecoration: 'none',
                        background: active ? tokens.colors.primary : tokens.colors.primarySoft,
                        borderColor: active ? tokens.colors.primary : isDark ? 'rgba(255,91,0,0.25)' : 'rgba(255,91,0,0.18)',
                        color: active ? '#ffffff' : tokens.colors.primary,
                    }}
                >
                    <span className="flex h-4.5 w-4.5 items-center justify-center flex-shrink-0">
                        <Icon icon={appIcons[iconKey]} className="w-3.5 h-3.5" />
                    </span>
                    <span className="text-xs tracking-wide">
                        {item.label}
                    </span>
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
                onClick={onClose}
                onMouseEnter={() => setHoveredItem(item.to)}
                onMouseLeave={() => setHoveredItem(null)}
                className="group relative flex min-h-11 items-center gap-2.5 rounded-full px-3 py-2 transition-all duration-150"
                style={{
                    textDecoration: 'none',
                    background,
                }}
            >
                <span
                    className="flex h-5 w-5 items-center justify-center flex-shrink-0 transition-colors duration-150"
                    style={{ color }}
                >
                    <Icon icon={appIcons[iconKey]} className="w-3.5 h-3.5" />
                </span>
                <span
                    className="min-w-0 flex-1 whitespace-normal break-words text-sm font-semibold tracking-[0.01em] transition-colors duration-150"
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
        <>
            {/* Backdrop */}
            <button
                type="button"
                className={`fixed inset-0 z-40 transition-opacity duration-200 cursor-default ${isOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
                style={{
                    background: isDark ? 'rgba(0,0,0,0.42)' : 'rgba(17,17,17,0.18)',
                    backdropFilter: 'blur(3px)',
                }}
                onClick={onClose}
                aria-label="Close sidebar"
            />

            {/* Sidebar panel */}
            <aside
                className="fixed inset-0 z-50 flex flex-col transition-transform duration-200 ease-out"
                style={{
                    width: 292,
                    background: tokens.colors.surfaceElevated,
                    borderRight: `1px solid ${tokens.colors.border}`,
                    boxShadow: tokens.shadows.floating,
                    transform: isOpen ? 'translateX(0)' : 'translateX(-100%)',
                }}
            >
                {/* Brand */}
                <div
                    className="flex items-center gap-3 border-b"
                    style={{
                        padding: 'max(env(safe-area-inset-top), 14px) 14px 12px',
                        borderColor: tokens.colors.border,
                    }}
                >
                    <div
                        className="flex h-9 w-9 items-center justify-center rounded-xl overflow-hidden flex-shrink-0"                    >
                        <AppIcon size="md" className="flex-shrink-0" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h1 className="text-sm font-semibold" style={{ color: tokens.colors.text }}>
                            CreateStory
                        </h1>
                        <p className="text-xs" style={{ color: tokens.colors.textMuted }}>
                            Workspace
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onOpenSettings}
                        className="cs-icon-button flex-shrink-0 touch-manipulation"
                        onMouseEnter={() => setHoveredItem('/settings')}
                        onMouseLeave={() => setHoveredItem(null)}
                        aria-label="Open settings"
                    >
                        <Icon icon={appIcons.settings} className="w-4 h-4" />
                    </button>
                </div>

                {/* Nav */}
                <nav
                    className="flex-1 overflow-y-auto"
                    style={{
                        padding: '4px 8px 16px',
                    }}
                >
                    {navSections.map((section) => (
                        <div key={section.label} style={{ marginTop: 14 }}>
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
            </aside>
        </>
    );
}

export default MobileSidebar;
