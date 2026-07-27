import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { Icon, appIcons } from './Icon';
import type { AuthUser } from '../../api';

interface AccountMenuProps {
  authUser: AuthUser;
  isDark: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onLogout: () => void;
  placement?: 'floating' | 'sidebar' | 'topbar';
}

export function AccountMenu({
  authUser,
  isDark,
  isOpen,
  onToggle,
  onClose,
  onLogout,
  placement = 'floating',
}: Readonly<AccountMenuProps>) {
  const isAdmin = authUser.role === 'admin';
  const menuRef = useRef<HTMLDivElement>(null);
  const isSidebar = placement === 'sidebar';
  const isTopbar = placement === 'topbar';

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  const wrapperClassName = isSidebar || isTopbar ? 'relative' : 'fixed right-4 top-3 z-[70]';
  const buttonClassName = isSidebar
    ? `group flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors ${
        isDark
          ? 'border-white/[0.08] bg-[#202020] text-slate-200 hover:bg-[#262626]'
          : 'border-[rgba(55,53,47,0.12)] bg-white text-[#37352f] hover:bg-[#f7f6f3]'
      }`
    : isTopbar
      ? `group relative inline-flex h-9 items-center gap-2 rounded-full border px-2.5 transition-all ${
          isDark
            ? 'border-white/[0.09] bg-white/[0.05] text-slate-100 hover:bg-white/[0.08]'
            : 'border-black/10 bg-white text-[#111111] shadow-sm hover:bg-[#f7f6f3]'
        }`
    : `group relative inline-flex h-10 items-center gap-2 rounded-xl border px-2.5 transition-all ${
        isDark
          ? 'border-white/[0.08] bg-slate-950/80 text-slate-200 hover:bg-slate-900'
          : 'border-black/10 bg-white/90 text-slate-700 hover:bg-slate-50 shadow-sm'
      }`;

  const panelClassName = isSidebar
    ? `absolute bottom-[calc(100%+8px)] left-0 right-0 rounded-xl border p-1.5 shadow-2xl ${
        isDark
          ? 'border-white/[0.08] bg-[#191919] text-slate-200'
          : 'border-[rgba(55,53,47,0.12)] bg-[#fbfbfa] text-[#37352f]'
      }`
    : isTopbar
      ? `absolute right-0 top-[calc(100%+10px)] w-72 rounded-2xl border p-2 shadow-2xl ${
          isDark
            ? 'border-white/[0.08] bg-[#161616]/95 text-slate-200'
            : 'border-black/10 bg-white/95 text-slate-800'
        }`
    : `absolute right-0 mt-2 w-72 rounded-xl border p-3 shadow-2xl ${
        isDark
          ? 'border-white/[0.08] bg-slate-950/95 text-slate-200'
          : 'border-black/10 bg-white/95 text-slate-800'
      }`;

  const itemClassName = isDark
    ? 'text-slate-300 hover:bg-white/[0.06]'
    : 'text-[#37352f] hover:bg-[rgba(55,53,47,0.06)]';

  return (
    <div className={wrapperClassName} ref={menuRef}>
      <button
        type="button"
        onClick={onToggle}
        className={buttonClassName}
        title="Account"
        aria-label="Account menu"
        aria-expanded={isOpen}
      >
        <span
          className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border ${
            isDark
              ? 'border-white/[0.08] bg-white/[0.04] text-slate-200'
              : 'border-[rgba(55,53,47,0.08)] bg-[#f1f1ef] text-[#37352f]'
          }`}
        >
          <Icon icon={appIcons.user} className="h-3.5 w-3.5" />
        </span>

        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[13px] font-medium ${isDark ? 'text-slate-100' : 'text-[#37352f]'}`}>
            {authUser.email}
          </span>
          <span className={`block text-[11px] capitalize ${isDark ? 'text-slate-400' : 'text-[rgba(55,53,47,0.58)]'}`}>
            {authUser.role}
          </span>
        </span>

        <span className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${isDark ? 'text-slate-400' : 'text-[rgba(55,53,47,0.55)]'}`}>
          <Icon icon={appIcons.chevronDown} className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {isOpen && (
        <div className={panelClassName}>
          <div className={`rounded-lg px-2.5 py-2 ${isDark ? 'bg-white/[0.03]' : 'bg-[rgba(55,53,47,0.04)]'}`}>
            <div className={`truncate text-[13px] font-medium ${isDark ? 'text-slate-100' : 'text-[#37352f]'}`}>{authUser.email}</div>
            <div className={`mt-0.5 text-[10px] uppercase tracking-[0.14em] ${isDark ? 'text-slate-500' : 'text-[rgba(55,53,47,0.5)]'}`}>
              {authUser.role}
            </div>
          </div>

          <div className="mt-1.5 space-y-0.5">
            {isAdmin && (
              <Link
                to="/dashboard"
                onClick={onClose}
                className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors ${itemClassName}`}
                style={{ textDecoration: 'none' }}
              >
                <Icon icon={appIcons.dashboardUsers} className="h-4 w-4" />
                Dashboard
              </Link>
            )}

            <button
              type="button"
              onClick={() => {
                onClose();
                onLogout();
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
                isDark ? 'text-red-300 hover:bg-red-500/10' : 'text-red-600 hover:bg-red-50'
              }`}
            >
              <Icon icon={appIcons.logout} className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
