import { useEffect, useState } from 'react';
import { Icon, appIcons } from '../../../components/Shared/Icon';
import { showToast } from '../../../components/Shared/Toast';
import {
    clearBackendData,
    getSettings,
    updateSettings,
    updateInkittCookies,
    checkInkittCookies,
    updateScribblehubCookies,
    checkScribblehubCookies,
    updateNovelHallCookies,
    checkNovelHallCookies,
    updateGoodnovelCookies,
    checkGoodnovelCookies,
    updateWebnovelCookies,
    checkWebnovelCookies,
    getStoredAuthUser,
    getDriveSyncConfig,
    initDriveSyncConfig,
    checkCredentialsExists,
    type SettingsResponse,
    type DriveSyncConfig,
    FIXED_JSON_PREFIX,
} from '../../../api';
import { DriveConfig, type ConfigFormData } from '../../../components/Shared/DriveConfig';
import type { ThemeMode } from '../../../types/theme';

type SettingsCategory = 'profile' | 'appearance' | 'driveSync' | 'inkitt' | 'scribblehub' | 'novelhall' | 'goodnovel' | 'webnovel' | 'crawler' | 'audio' | 'danger';

interface CategoryItem {
    id: SettingsCategory;
    label: string;
    description: string;
    icon: keyof typeof appIcons;
}

const CATEGORIES: CategoryItem[] = [
    { id: 'profile', label: 'Profile', description: 'Account information', icon: 'user' },
    { id: 'appearance', label: 'Appearance', description: 'Theme and display', icon: 'moon' },
    { id: 'driveSync', label: 'Drive Sync', description: 'Google Drive and API', icon: 'sync' },
    { id: 'inkitt', label: 'Inkitt Cookies', description: 'Crawler login cookies', icon: 'shield' },
    { id: 'scribblehub', label: 'ScribbleHub Cookies', description: 'Cloudflare bypass cookies', icon: 'shield' },
    { id: 'novelhall', label: 'NovelHall Cookies', description: 'Cloudflare bypass cookies', icon: 'shield' },
    { id: 'goodnovel', label: 'GoodNovel Cookies', description: 'Login cookies to unlock chapters', icon: 'shield' },
    { id: 'webnovel', label: 'WebNovel Cookies', description: 'Cloudflare and login cookies', icon: 'shield' },
    { id: 'crawler', label: 'Crawler', description: 'Default crawl behavior', icon: 'settings' },
    { id: 'audio', label: 'Audio Pipeline', description: 'Auto Audio and TTS', icon: 'music' },
    { id: 'danger', label: 'Advanced', description: 'Cleanup actions', icon: 'delete' },
];

interface MobileSettingsPageProps {
    themeMode: ThemeMode;
    onThemeChange: (mode: ThemeMode) => void;
    onClose: () => void;
    onLogout: () => void | Promise<void>;
}

export function MobileSettingsPage({
    themeMode,
    onThemeChange,
    onClose,
    onLogout,
}: Readonly<MobileSettingsPageProps>) {
    const isDark = themeMode === 'dark';
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [errorBannerVisible, setErrorBannerVisible] = useState(false);
    const [activeCategory, setActiveCategory] = useState<SettingsCategory | null>(null);
    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

    const [localTheme, setLocalTheme] = useState<'light' | 'dark'>(themeMode === 'dark' ? 'dark' : 'light');
    const [crawlMode, setCrawlMode] = useState<'count' | 'range'>('count');
    const [count, setCount] = useState(10);
    const [rangeFrom, setRangeFrom] = useState(1);
    const [rangeTo, setRangeTo] = useState(10);
    const [crawlAutoMaxChapters, setCrawlAutoMaxChapters] = useState(false);
    const [autoAudioRestSeconds, setAutoAudioRestSeconds] = useState(0);
    const [autoAudioTestStoryIds, setAutoAudioTestStoryIds] = useState<string[]>([]);
    const [autoAudioTestIdsText, setAutoAudioTestIdsText] = useState('');

    // Inkitt cookies states
    const [inkittUserCredentials, setInkittUserCredentials] = useState('');
    const [inkittCfClearance, setInkittCfClearance] = useState('');
    const [inkittUserAgent, setInkittUserAgent] = useState('');
    const [savingInkittCookies, setSavingInkittCookies] = useState(false);
    const [checkingInkittCookies, setCheckingInkittCookies] = useState(false);
    const [inkittCookieError, setInkittCookieError] = useState('');
    const [inkittCookieMessage, setInkittCookieMessage] = useState('');
    const [inkittJsonText, setInkittJsonText] = useState('');

    // ScribbleHub cookies states
    const [scribblehubCookies, setScribblehubCookies] = useState('');
    const [scribblehubUserAgent, setScribblehubUserAgent] = useState('');
    const [savingScribblehubCookies, setSavingScribblehubCookies] = useState(false);
    const [checkingScribblehubCookies, setCheckingScribblehubCookies] = useState(false);
    const [scribblehubCookieError, setScribblehubCookieError] = useState('');
    const [scribblehubCookieMessage, setScribblehubCookieMessage] = useState('');

    // NovelHall cookies states
    const [novelhallCookies, setNovelhallCookies] = useState('');
    const [novelhallUserAgent, setNovelhallUserAgent] = useState('');
    const [savingNovelhallCookies, setSavingNovelhallCookies] = useState(false);
    const [checkingNovelhallCookies, setCheckingNovelhallCookies] = useState(false);
    const [novelhallCookieError, setNovelhallCookieError] = useState('');
    const [novelhallCookieMessage, setNovelhallCookieMessage] = useState('');

    // GoodNovel cookies states
    const [goodnovelCookies, setGoodnovelCookies] = useState('');
    const [goodnovelUserAgent, setGoodnovelUserAgent] = useState('');
    const [goodnovelTestUrl, setGoodnovelTestUrl] = useState('');
    const [savingGoodnovelCookies, setSavingGoodnovelCookies] = useState(false);
    const [checkingGoodnovelCookies, setCheckingGoodnovelCookies] = useState(false);
    const [goodnovelCookieError, setGoodnovelCookieError] = useState('');
    const [goodnovelCookieMessage, setGoodnovelCookieMessage] = useState('');

    // WebNovel cookies states
    const [webnovelCookies, setWebnovelCookies] = useState('');
    const [webnovelUserAgent, setWebnovelUserAgent] = useState('');
    const [webnovelTestUrl, setWebnovelTestUrl] = useState('');
    const [savingWebnovelCookies, setSavingWebnovelCookies] = useState(false);
    const [checkingWebnovelCookies, setCheckingWebnovelCookies] = useState(false);
    const [webnovelCookieError, setWebnovelCookieError] = useState('');
    const [webnovelCookieMessage, setWebnovelCookieMessage] = useState('');

    const [clearState, setClearState] = useState<'idle' | 'clearing'>('idle');
    const [clearConfirm, setClearConfirm] = useState('');
    const authUser = getStoredAuthUser();
    const isAdmin = authUser?.role === 'admin';

    // Drive Sync config state
    const [config, setConfig] = useState<DriveSyncConfig | null>(null);
    const [isInitialSetup, setIsInitialSetup] = useState(false);
    const [configForm, setConfigForm] = useState<ConfigFormData>({
        folder_id: '',
        service_account_json_name: 'google-service-account.json',
        main_be_api_base_url: '',
        main_be_bearer_token: '',
        main_be_user_id: '',
    });
    const [savingConfig, setSavingConfig] = useState(false);
    const [savingConfigError, setSavingConfigError] = useState('');
    const [credentialFileExists, setCredentialFileExists] = useState(true);
    const [uploadError, setUploadError] = useState('');

    const bg = isDark ? '#0f0f0f' : '#f8f8f7';
    const cardBg = isDark ? '#1c1c1c' : '#ffffff';
    const cardBorder = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)';
    const textPrimary = isDark ? 'rgba(255,255,255,0.92)' : 'rgba(15,15,15,0.92)';
    const textSecondary = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(15,15,15,0.5)';
    const textTertiary = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(15,15,15,0.3)';
    const inputBg = isDark ? '#242424' : '#ffffff';
    const inputBorder = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)';
    const primary = '#2563eb';
    const danger = '#dc2626';
    const success = '#16a34a';

    const inputCls = `w-full rounded-xl border px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow ${isDark ? 'bg-[#242424] border-white/10 text-white/90 placeholder:text-white/25' : 'bg-white border-black/10 text-[rgba(15,15,15,0.92)] placeholder:text-black/30'}`;
    const labelCls = `block text-xs font-medium mb-1.5 ${isDark ? 'text-white/40' : 'text-black/40'}`;
    const sectionCard = `rounded-2xl border p-4 space-y-4`;

    useEffect(() => {
        getSettings()
            .then((s: SettingsResponse) => {
                setLocalTheme(s.theme === 'dark' ? 'dark' : 'light');
                setCrawlMode(s.crawl_mode as 'count' | 'range');
                setCount(s.crawl_default_count);
                setRangeFrom(s.crawl_default_range_from);
                setRangeTo(s.crawl_default_range_to);
                setCrawlAutoMaxChapters(s.crawl_auto_max_chapters ?? false);
                setAutoAudioRestSeconds(s.auto_audio_rest_seconds ?? 0);
                setAutoAudioTestStoryIds(s.auto_audio_test_story_ids ?? []);
                setAutoAudioTestIdsText((s.auto_audio_test_story_ids ?? []).join(', '));
            })
            .catch(() => setError('Failed to load settings.'))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = ''; };
    }, []);

    useEffect(() => {
        if (!error) {
            setErrorBannerVisible(false);
            return;
        }

        setErrorBannerVisible(true);
        const fadeTimer = globalThis.setTimeout(() => setErrorBannerVisible(false), 3500);
        const clearTimer = globalThis.setTimeout(() => setError(''), 3900);

        return () => {
            globalThis.clearTimeout(fadeTimer);
            globalThis.clearTimeout(clearTimer);
        };
    }, [error]);

    // Load Drive Sync config
    useEffect(() => {
        async function loadDriveConfig() {
            try {
                const cfg = await getDriveSyncConfig();
                setConfig(cfg);
                const exists = await checkCredentialsExists('google-service-account.json');
                setCredentialFileExists(exists);
                setConfigForm({
                    folder_id: cfg?.folder_id || '',
                    service_account_json_name: cfg?.service_account_json_name || 'google-service-account.json',
                    main_be_api_base_url: cfg?.main_be_api_base_url || '',
                    main_be_bearer_token: cfg?.main_be_bearer_token || '',
                    main_be_user_id: cfg?.main_be_user_id || '',
                });
                setIsInitialSetup(!cfg?.folder_id);
            } catch {
                // silently ignore
            }
        }
        loadDriveConfig();
    }, []);

    const handleConfigFormChange = (data: Partial<ConfigFormData>) => {
        setConfigForm(prev => ({ ...prev, ...data }));
    };

    const handleSaveConfig = async () => {
        setSavingConfig(true);
        setSavingConfigError('');
        try {
            const cfg = await initDriveSyncConfig({
                folder_id: configForm.folder_id,
                service_account_json_path: FIXED_JSON_PREFIX + configForm.service_account_json_name,
                main_be_api_base_url: configForm.main_be_api_base_url,
                main_be_user_id: configForm.main_be_user_id,
                main_be_bearer_token: configForm.main_be_bearer_token || undefined,
            });
            setConfig(cfg);
            setIsInitialSetup(false);
            showToast('Drive Sync configuration saved.', 'success', 2000, 'top-center');
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to save Drive Sync config.';
            setSavingConfigError(msg);
            showToast(msg, 'error', 3000, 'top-center');
        } finally {
            setSavingConfig(false);
        }
    };

    const handleJsonFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploadError('');

        try {
            let json = JSON.parse(await file.text());
            if (Array.isArray(json)) {
                if (json.length === 0) {
                    setUploadError('JSON array is empty');
                    return;
                }
                json = json[0];
            }
            if (json && typeof json === 'object' && !json.folder_id && !json.main_be_api_base_url) {
                if (json.data) json = json.data;
                else if (json.config) json = json.config;
                else if (json.settings) json = json.settings;
                else if (json.attributes) json = json.attributes;
                else if (json.result) json = json.result;
            }
            if (Array.isArray(json)) {
                json = json[0] || {};
            }
            if (!json || typeof json !== 'object') {
                setUploadError('Invalid JSON structure');
                return;
            }

            const folderId = json.folder_id || json.folderId || json.folder || '';
            const apiUrl = json.main_be_api_base_url || json.apiBaseUrl || json.apiUrl || json.baseUrl || '';
            if (!folderId && !apiUrl) {
                setUploadError('Missing required fields. Received keys: ' + Object.keys(json).join(', '));
                return;
            }

            setConfigForm({
                folder_id: folderId,
                service_account_json_name: json.service_account_json_name || json.serviceAccountJsonName || json.serviceAccount || 'google-service-account.json',
                main_be_api_base_url: apiUrl,
                main_be_bearer_token: json.main_be_bearer_token || json.bearerToken || json.token || '',
                main_be_user_id: json.main_be_user_id || json.userId || json.user_id || '',
            });
            setUploadError('');
        } catch (err) {
            setUploadError(`Invalid JSON: ${err instanceof Error ? err.message : 'Parse error'}`);
        } finally {
            e.target.value = '';
        }
    };

    const handleSave = async () => {
        setSaveState('saving');
        setError('');
        try {
            await updateSettings({
                theme: localTheme,
                crawl_mode: crawlMode,
                crawl_default_count: count,
                crawl_default_range_from: rangeFrom,
                crawl_default_range_to: rangeTo,
                crawl_auto_max_chapters: crawlAutoMaxChapters,
                auto_audio_rest_seconds: autoAudioRestSeconds,
                auto_audio_test_story_ids: autoAudioTestStoryIds,
            });
            onThemeChange(localTheme === 'dark' ? 'dark' : 'light');
            setSaveState('saved');
            showToast('Changes are saved.', 'success', 2000, 'top-center');
            setTimeout(() => setSaveState('idle'), 2000);
        } catch {
            setError('Failed to save settings.');
            setSaveState('idle');
        }
    };

    const handleClearBackendData = async () => {
        if (clearConfirm.trim() !== 'CLEAR_BACKEND_DATA') {
            showToast('Type CLEAR_BACKEND_DATA before clearing.', 'warning', 2200, 'top-center');
            return;
        }
        setClearState('clearing');
        setError('');
        try {
            const result = await clearBackendData();
            setClearConfirm('');
            showToast(
                `Cleared ${result.cleared_tables.length} tables, deleted ${result.deleted_paths.length} paths, and cleared ${result.cleared_logs.length} logs.`,
                'success', 3500, 'top-center',
            );
            globalThis.setTimeout(() => globalThis.location.assign('/'), 600);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to clear backend data.');
            showToast('Failed to clear backend data.', 'error', 3000, 'top-center');
        } finally {
            setClearState('idle');
        }
    };

    const handleSaveInkittCookies = async () => {
        const userCredentials = inkittUserCredentials.trim();
        const cfClearance = inkittCfClearance.replace(/\s+/g, '').trim();
        const userAgent = inkittUserAgent.trim();
        if (!userCredentials || !cfClearance) {
            setInkittCookieError('Paste both user_credentials and cf_clearance before saving.');
            setInkittCookieMessage('');
            return;
        }
        setSavingInkittCookies(true);
        setInkittCookieError('');
        setInkittCookieMessage('');
        try {
            const result = await updateInkittCookies(
                `user_credentials=${userCredentials}; cf_clearance=${cfClearance}`,
                userAgent || undefined
            );
            const message = `Saved ${result.cookie_count} Inkitt cookie${result.cookie_count === 1 ? '' : 's'}.`;
            setInkittCookieMessage(message);
            setInkittUserCredentials('');
            setInkittCfClearance('');
            setInkittUserAgent('');
            showToast(message, 'success', 2200, 'top-center');
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to update Inkitt cookies.';
            setInkittCookieError(message);
            showToast('Failed to update Inkitt cookies.', 'error', 2500, 'top-center');
        } finally {
            setSavingInkittCookies(false);
        }
    };

    const handleCheckInkittCookies = async () => {
        setCheckingInkittCookies(true);
        setInkittCookieError('');
        setInkittCookieMessage('');
        try {
            const result = await checkInkittCookies();
            if (result.valid) {
                setInkittCookieMessage(result.message);
                showToast('Inkitt cookies are working.', 'success', 2200, 'top-center');
            } else {
                setInkittCookieError(result.message);
            }
        } catch (err) {
            setInkittCookieError(err instanceof Error ? err.message : 'Failed to test Inkitt cookies.');
        } finally {
            setCheckingInkittCookies(false);
        }
    };

    const handleInkittJsonFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const text = await file.text();
            let json = JSON.parse(text);

            let extractedUA = '';
            if (json && !Array.isArray(json) && typeof json === 'object') {
                extractedUA = json.user_agent || json.userAgent || json['User-Agent'] || '';
            }

            if (Array.isArray(json)) json = json[0] || {};
            if (json.data) json = json.data;
            else if (json.config) json = json.config;
            else if (json.attributes) json = json.attributes;

            const userCred = json.user_credentials || json.userCredentials || json.user_credentials_cookie || '';
            const cfClear = json.cf_clearance || json.cfClearance || '';
            if (!userCred || !cfClear) {
                setInkittCookieError('Missing user_credentials or cf_clearance in JSON. Received keys: ' + Object.keys(json).join(', '));
                return;
            }

            setInkittUserCredentials(userCred);
            setInkittCfClearance(cfClear);
            if (!extractedUA) {
                extractedUA = json.user_agent || json.userAgent || json['User-Agent'] || '';
            }
            if (extractedUA) {
                setInkittUserAgent(String(extractedUA));
                showToast('Inkitt cookies + User-Agent loaded from file.', 'success', 2500, 'top-center');
            } else {
                setInkittUserAgent('');
                showToast('Inkitt cookie values loaded from file. User-Agent not found — please enter it manually.', 'info', 3000, 'top-center');
            }
            setInkittCookieError('');
        } catch (err) {
            setInkittCookieError(`Invalid JSON: ${err instanceof Error ? err.message : 'Parse error'}`);
        } finally {
            e.target.value = '';
        }
    };

    const handleInkittJsonPaste = () => {
        if (!inkittJsonText.trim()) {
            setInkittCookieError('Please paste JSON first.');
            return;
        }

        try {
            let json = JSON.parse(inkittJsonText);
            let extractedUA = '';
            if (json && !Array.isArray(json) && typeof json === 'object') {
                extractedUA = json.user_agent || json.userAgent || json['User-Agent'] || '';
            }

            if (Array.isArray(json)) json = json[0] || {};
            if (json.data) json = json.data;
            else if (json.config) json = json.config;
            else if (json.attributes) json = json.attributes;

            const userCred = json.user_credentials || json.userCredentials || json.user_credentials_cookie || '';
            const cfClear = json.cf_clearance || json.cfClearance || '';
            if (!userCred || !cfClear) {
                setInkittCookieError('Missing user_credentials or cf_clearance in JSON. Received keys: ' + Object.keys(json).join(', '));
                return;
            }

            setInkittUserCredentials(userCred);
            setInkittCfClearance(cfClear);
            if (!extractedUA) {
                extractedUA = json.user_agent || json.userAgent || json['User-Agent'] || '';
            }
            if (extractedUA) {
                setInkittUserAgent(String(extractedUA));
                showToast('Inkitt cookie values + User-Agent loaded.', 'success', 2000, 'top-center');
            } else {
                setInkittUserAgent('');
                showToast('Inkitt cookie values loaded. User-Agent not found — please enter it manually.', 'info', 3000, 'top-center');
            }
            setInkittJsonText('');
            setInkittCookieError('');
        } catch (err) {
            setInkittCookieError(`Invalid JSON: ${err instanceof Error ? err.message : 'Parse error'}`);
        }
    };

    const handleSaveScribblehubCookies = async () => {
        const cookies = scribblehubCookies.trim();
        const userAgent = scribblehubUserAgent.trim();
        if (!cookies) {
            setScribblehubCookieError('Paste your ScribbleHub cookies (at least cf_clearance) before saving.');
            setScribblehubCookieMessage('');
            return;
        }
        if (!userAgent) {
            setScribblehubCookieError('Paste your browser User-Agent — cf_clearance only works with the matching User-Agent.');
            setScribblehubCookieMessage('');
            return;
        }

        setSavingScribblehubCookies(true);
        setScribblehubCookieError('');
        setScribblehubCookieMessage('');
        try {
            const result = await updateScribblehubCookies(cookies, userAgent);
            if (!result.has_cf_clearance) {
                setScribblehubCookieError('Saved, but no cf_clearance cookie was found — crawling will still be blocked by Cloudflare.');
            } else {
                const message = `Saved ${result.cookie_count} ScribbleHub cookie${result.cookie_count === 1 ? '' : 's'}.`;
                setScribblehubCookieMessage(message);
                showToast(message, 'success', 2200, 'top-center');
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to update ScribbleHub cookies.';
            setScribblehubCookieError(message);
            showToast('Failed to update ScribbleHub cookies.', 'error', 2500, 'top-center');
        } finally {
            setSavingScribblehubCookies(false);
        }
    };

    const handleCheckScribblehubCookies = async () => {
        setCheckingScribblehubCookies(true);
        setScribblehubCookieError('');
        setScribblehubCookieMessage('');
        try {
            const result = await checkScribblehubCookies();
            if (result.valid) {
                setScribblehubCookieMessage(result.message);
                showToast('ScribbleHub cookies are working.', 'success', 2200, 'top-center');
            } else {
                setScribblehubCookieError(result.message);
            }
        } catch (err) {
            setScribblehubCookieError(err instanceof Error ? err.message : 'Failed to test ScribbleHub cookies.');
        } finally {
            setCheckingScribblehubCookies(false);
        }
    };

    const handleScribblehubJsonFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            let json = JSON.parse(text);

            let extractedUA = '';
            if (json && !Array.isArray(json) && typeof json === 'object') {
                extractedUA = json.user_agent || json.userAgent || json['User-Agent'] || '';
            }

            if (json && !Array.isArray(json) && (json.cookies || json.data)) json = json.cookies || json.data;

            if (Array.isArray(json)) {
                setScribblehubCookies(JSON.stringify(json));
                if (!extractedUA) {
                    const uaEntry = json.find((c) => (c?.name || '').toLowerCase() === 'user-agent');
                    if (uaEntry?.value) extractedUA = String(uaEntry.value);
                }
            } else if (json && typeof json === 'object') {
                const cf = json.cf_clearance || json.cfClearance || '';
                if (cf) setScribblehubCookies(`cf_clearance=${cf}`);
                if (!extractedUA) extractedUA = json.user_agent || json.userAgent || json['User-Agent'] || '';
                if (!cf) setScribblehubCookies(text.trim());
            }

            if (extractedUA) {
                setScribblehubUserAgent(String(extractedUA));
                showToast('ScribbleHub cookies + User-Agent loaded from file.', 'success', 2500, 'top-center');
            } else {
                showToast('ScribbleHub cookie values loaded from file. User-Agent not found — please enter it manually.', 'info', 3500, 'top-center');
            }
            setScribblehubCookieError('');
        } catch (err) {
            setScribblehubCookieError(`Invalid JSON: ${err instanceof Error ? err.message : 'Parse error'}`);
        } finally {
            e.target.value = '';
        }
    };

    const handleSaveNovelhallCookies = async () => {
        const cookies = novelhallCookies.trim();
        const userAgent = novelhallUserAgent.trim();
        if (!cookies) {
            setNovelhallCookieError('Paste your NovelHall cookies (at least cf_clearance) before saving.');
            setNovelhallCookieMessage('');
            return;
        }
        if (!userAgent) {
            setNovelhallCookieError('Paste your browser User-Agent — cf_clearance only works with the matching User-Agent.');
            setNovelhallCookieMessage('');
            return;
        }

        setSavingNovelhallCookies(true);
        setNovelhallCookieError('');
        setNovelhallCookieMessage('');
        try {
            const result = await updateNovelHallCookies(cookies, userAgent);
            if (!result.has_cf_clearance) {
                setNovelhallCookieError('Saved, but no cf_clearance cookie was found — crawling will still be blocked by Cloudflare.');
            } else {
                const message = `Saved ${result.cookie_count} NovelHall cookie${result.cookie_count === 1 ? '' : 's'}.`;
                setNovelhallCookieMessage(message);
                showToast(message, 'success', 2200, 'top-center');
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to update NovelHall cookies.';
            setNovelhallCookieError(message);
            showToast('Failed to update NovelHall cookies.', 'error', 2500, 'top-center');
        } finally {
            setSavingNovelhallCookies(false);
        }
    };

    const handleCheckNovelhallCookies = async () => {
        setCheckingNovelhallCookies(true);
        setNovelhallCookieError('');
        setNovelhallCookieMessage('');
        try {
            const result = await checkNovelHallCookies();
            if (result.valid) {
                setNovelhallCookieMessage(result.message);
                showToast('NovelHall cookies are working.', 'success', 2200, 'top-center');
            } else {
                setNovelhallCookieError(result.message);
            }
        } catch (err) {
            setNovelhallCookieError(err instanceof Error ? err.message : 'Failed to test NovelHall cookies.');
        } finally {
            setCheckingNovelhallCookies(false);
        }
    };

    const handleNovelhallJsonFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            let json = JSON.parse(text);

            let extractedUA = '';
            if (json && !Array.isArray(json) && typeof json === 'object') {
                extractedUA = json.user_agent || json.userAgent || json['User-Agent'] || '';
            }

            if (json && !Array.isArray(json) && (json.cookies || json.data)) json = json.cookies || json.data;

            if (Array.isArray(json)) {
                setNovelhallCookies(JSON.stringify(json));
                if (!extractedUA) {
                    const uaEntry = json.find((c) => (c?.name || '').toLowerCase() === 'user-agent');
                    if (uaEntry?.value) extractedUA = String(uaEntry.value);
                }
            } else if (json && typeof json === 'object') {
                const cf = json.cf_clearance || json.cfClearance || '';
                if (cf) setNovelhallCookies(`cf_clearance=${cf}`);
                if (!extractedUA) extractedUA = json.user_agent || json.userAgent || json['User-Agent'] || '';
                if (!cf) setNovelhallCookies(text.trim());
            }

            if (extractedUA) {
                setNovelhallUserAgent(String(extractedUA));
                showToast('NovelHall cookies + User-Agent loaded from file.', 'success', 2500, 'top-center');
            } else {
                showToast('NovelHall cookie values loaded from file. User-Agent not found — please enter it manually.', 'info', 3500, 'top-center');
            }
            setNovelhallCookieError('');
        } catch (err) {
            setNovelhallCookieError(`Invalid JSON: ${err instanceof Error ? err.message : 'Parse error'}`);
        } finally {
            e.target.value = '';
        }
    };

    const handleSaveGoodnovelCookies = async () => {
        const cookies = goodnovelCookies.trim();
        const userAgent = goodnovelUserAgent.trim();
        if (!cookies) {
            setGoodnovelCookieError('Paste your GoodNovel cookies (at least the TOKEN cookie) before saving.');
            setGoodnovelCookieMessage('');
            return;
        }

        setSavingGoodnovelCookies(true);
        setGoodnovelCookieError('');
        setGoodnovelCookieMessage('');
        try {
            const result = await updateGoodnovelCookies(cookies, userAgent || undefined);
            if (!result.has_token) {
                setGoodnovelCookieError('Saved, but no TOKEN cookie was found — login may not work, so only universally-free chapters will be crawlable.');
            } else {
                const message = `Saved ${result.cookie_count} GoodNovel cookie${result.cookie_count === 1 ? '' : 's'}.`;
                setGoodnovelCookieMessage(message);
                showToast(message, 'success', 2200, 'top-center');
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to update GoodNovel cookies.';
            setGoodnovelCookieError(message);
            showToast('Failed to update GoodNovel cookies.', 'error', 2500, 'top-center');
        } finally {
            setSavingGoodnovelCookies(false);
        }
    };

    const handleCheckGoodnovelCookies = async () => {
        setCheckingGoodnovelCookies(true);
        setGoodnovelCookieError('');
        setGoodnovelCookieMessage('');
        try {
            const result = await checkGoodnovelCookies(goodnovelTestUrl.trim() || undefined);
            if (result.valid) {
                setGoodnovelCookieMessage(result.message);
                showToast('GoodNovel cookies are working.', 'success', 2200, 'top-center');
            } else if (result.valid === null) {
                setGoodnovelCookieMessage(result.message);
                showToast('Checked GoodNovel cookies.', 'info', 2500, 'top-center');
            } else {
                setGoodnovelCookieError(result.message);
            }
        } catch (err) {
            setGoodnovelCookieError(err instanceof Error ? err.message : 'Failed to test GoodNovel cookies.');
        } finally {
            setCheckingGoodnovelCookies(false);
        }
    };

    const handleGoodnovelJsonFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            let json = JSON.parse(text);

            let extractedUA = '';
            if (json && !Array.isArray(json) && typeof json === 'object') {
                extractedUA = json.user_agent || json.userAgent || json['User-Agent'] || '';
            }

            if (json && !Array.isArray(json) && (json.cookies || json.data)) json = json.cookies || json.data;

            if (Array.isArray(json)) {
                setGoodnovelCookies(JSON.stringify(json));
                if (!extractedUA) {
                    const uaEntry = json.find((c) => (c?.name || '').toLowerCase() === 'user-agent');
                    if (uaEntry?.value) extractedUA = String(uaEntry.value);
                }
            } else if (json && typeof json === 'object' && json.cookieHeader) {
                setGoodnovelCookies(String(json.cookieHeader));
            } else {
                setGoodnovelCookies(text.trim());
            }

            if (extractedUA) {
                setGoodnovelUserAgent(String(extractedUA));
                showToast('GoodNovel cookies + User-Agent loaded from file.', 'success', 2500, 'top-center');
            } else {
                showToast('GoodNovel cookies loaded from file.', 'success', 2500, 'top-center');
            }
            setGoodnovelCookieError('');
        } catch (err) {
            setGoodnovelCookieError(`Invalid JSON: ${err instanceof Error ? err.message : 'Parse error'}`);
        } finally {
            e.target.value = '';
        }
    };

    const handleSaveWebnovelCookies = async () => {
        const cookies = webnovelCookies.trim();
        const userAgent = webnovelUserAgent.trim();
        if (!cookies) {
            setWebnovelCookieError('Paste your WebNovel cookies before saving.');
            setWebnovelCookieMessage('');
            return;
        }
        if (!userAgent) {
            setWebnovelCookieError('Paste your browser User-Agent so cf_clearance matches the crawler request.');
            setWebnovelCookieMessage('');
            return;
        }

        setSavingWebnovelCookies(true);
        setWebnovelCookieError('');
        setWebnovelCookieMessage('');
        try {
            const result = await updateWebnovelCookies(cookies, userAgent);
            if (!result.has_cf_clearance) {
                setWebnovelCookieError('Saved, but no cf_clearance cookie was found. WebNovel may still return a Cloudflare challenge.');
            } else {
                const message = `Saved ${result.cookie_count} WebNovel cookie${result.cookie_count === 1 ? '' : 's'}.`;
                setWebnovelCookieMessage(message);
                showToast(message, 'success', 2200, 'top-center');
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to update WebNovel cookies.';
            setWebnovelCookieError(message);
            showToast('Failed to update WebNovel cookies.', 'error', 2500, 'top-center');
        } finally {
            setSavingWebnovelCookies(false);
        }
    };

    const handleCheckWebnovelCookies = async () => {
        setCheckingWebnovelCookies(true);
        setWebnovelCookieError('');
        setWebnovelCookieMessage('');
        try {
            const result = await checkWebnovelCookies(webnovelTestUrl.trim() || undefined);
            if (result.valid) {
                setWebnovelCookieMessage(result.message);
                showToast('WebNovel cookies are working.', 'success', 2200, 'top-center');
            } else if (result.valid === null) {
                setWebnovelCookieMessage(result.message);
                showToast('Checked WebNovel cookies.', 'info', 2500, 'top-center');
            } else {
                setWebnovelCookieError(result.message);
            }
        } catch (err) {
            setWebnovelCookieError(err instanceof Error ? err.message : 'Failed to test WebNovel cookies.');
        } finally {
            setCheckingWebnovelCookies(false);
        }
    };

    const handleWebnovelJsonFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            let json = JSON.parse(text);

            let extractedUA = '';
            if (json && !Array.isArray(json) && typeof json === 'object') {
                extractedUA = json.user_agent || json.userAgent || json['User-Agent'] || '';
            }

            if (json && !Array.isArray(json) && (json.cookies || json.data)) json = json.cookies || json.data;

            if (Array.isArray(json)) {
                setWebnovelCookies(JSON.stringify(json));
                if (!extractedUA) {
                    const uaEntry = json.find((c) => (c?.name || '').toLowerCase() === 'user-agent');
                    if (uaEntry?.value) extractedUA = String(uaEntry.value);
                }
            } else if (json && typeof json === 'object' && json.cookieHeader) {
                setWebnovelCookies(String(json.cookieHeader));
            } else {
                setWebnovelCookies(text.trim());
            }

            if (extractedUA) {
                setWebnovelUserAgent(String(extractedUA));
                showToast('WebNovel cookies + User-Agent loaded from file.', 'success', 2500, 'top-center');
            } else {
                showToast('WebNovel cookies loaded from file. User-Agent not found.', 'info', 3000, 'top-center');
            }
            setWebnovelCookieError('');
        } catch (err) {
            setWebnovelCookieError(`Invalid JSON: ${err instanceof Error ? err.message : 'Parse error'}`);
        } finally {
            e.target.value = '';
        }
    };

    const renderContent = () => {
        if (loading) {
            return (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Icon icon={appIcons.spinner} className="h-5 w-5 animate-spin" style={{ color: textSecondary }} />
                    <p className="text-sm" style={{ color: textSecondary }}>Loading settings...</p>
                </div>
            );
        }

        switch (activeCategory) {
            case 'profile':
                return (
                    <div className={`${sectionCard}`} style={{ background: cardBg, borderColor: cardBorder }}>
                        <div>
                            <p className="text-xs font-medium uppercase tracking-wider" style={{ color: textTertiary }}>Email</p>
                            <p className="mt-1 text-sm break-all" style={{ color: textPrimary }}>{authUser?.email || 'Unknown user'}</p>
                        </div>
                        <div>
                            <p className="text-xs font-medium uppercase tracking-wider" style={{ color: textTertiary }}>Role</p>
                            <p className="mt-1 text-sm capitalize" style={{ color: textPrimary }}>{authUser?.role || 'unknown'}</p>
                        </div>
                        <div className="pt-2">
                            <button
                                type="button"
                                onClick={async () => { await onLogout(); onClose(); }}
                                className="w-full rounded-xl py-2.5 text-sm font-semibold"
                                style={{ background: isDark ? 'rgba(220,38,38,0.15)' : 'rgba(220,38,38,0.06)', color: '#dc2626' }}
                            >
                                Sign out
                            </button>
                        </div>
                    </div>
                );
            case 'appearance':
                return (
                    <div className={`${sectionCard}`} style={{ background: cardBg, borderColor: cardBorder }}>
                        <div>
                            <p className={`text-sm font-semibold mb-0.5`} style={{ color: textPrimary }}>Theme</p>
                            <p className="text-xs" style={{ color: textSecondary }}>Choose how the app looks.</p>
                        </div>
                        <div className="flex gap-2">
                            {(['light', 'dark'] as const).map((mode) => {
                                const active = localTheme === mode;
                                return (
                                    <button
                                        key={mode}
                                        type="button"
                                        onClick={() => setLocalTheme(mode)}
                                        className="flex-1 flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-medium transition-all"
                                        style={{
                                            background: active ? (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)') : 'transparent',
                                            border: `1.5px solid ${active ? (isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)') : cardBorder}`,
                                            color: active ? textPrimary : textSecondary,
                                        }}
                                    >
                                        <Icon icon={appIcons[mode === 'light' ? 'themeLight' : 'themeDark']} className="h-4 w-4" />
                                        <span className="capitalize">{mode}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                );
            case 'crawler':
                return (
                    <div className="space-y-3">
                        <div className={`${sectionCard}`} style={{ background: cardBg, borderColor: cardBorder }}>
                            <p className={`text-sm font-semibold mb-0.5`} style={{ color: textPrimary }}>Default Chapters</p>
                            <p className="text-xs mb-3" style={{ color: textSecondary }}>Applied when starting a new crawl.</p>
                            <div className="flex rounded-xl p-1" style={{ background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}>
                                <button onClick={() => setCrawlMode('count')} className="flex-1 rounded-lg py-2 text-sm font-medium transition-all" style={{ background: crawlMode === 'count' ? (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)') : 'transparent', color: textPrimary }}>Count</button>
                                <button onClick={() => setCrawlMode('range')} className="flex-1 rounded-lg py-2 text-sm font-medium transition-all" style={{ background: crawlMode === 'range' ? (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)') : 'transparent', color: textPrimary }}>Range</button>
                            </div>
                            {crawlMode === 'count' ? (
                                <div>
                                    <label htmlFor="mob-crawl-count" className={labelCls}>Chapter count</label>
                                    <input id="mob-crawl-count" type="number" min={1} value={count} onChange={(e) => setCount(Math.max(1, Number.parseInt(e.target.value, 10) || 1))} className={inputCls} style={{ background: inputBg, borderColor: inputBorder }} />
                                    <p className="mt-1.5 text-xs" style={{ color: textSecondary }}>Crawl up to {count} chapter{count === 1 ? '' : 's'}.</p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <label htmlFor="mob-crawl-from" className={labelCls}>From</label>
                                        <input id="mob-crawl-from" type="number" min={1} value={rangeFrom} onChange={(e) => setRangeFrom(Math.max(1, Number.parseInt(e.target.value, 10) || 1))} className={inputCls} style={{ background: inputBg, borderColor: inputBorder }} />
                                    </div>
                                    <div>
                                        <label htmlFor="mob-crawl-to" className={labelCls}>To</label>
                                        <input id="mob-crawl-to" type="number" min={1} value={rangeTo} onChange={(e) => setRangeTo(Math.max(1, Number.parseInt(e.target.value, 10) || 1))} className={inputCls} style={{ background: inputBg, borderColor: inputBorder }} />
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className={`${sectionCard}`} style={{ background: cardBg, borderColor: cardBorder }}>
                            <div className="flex items-center justify-between">
                                <div className="pr-4">
                                    <p className={`text-sm font-medium mb-0.5`} style={{ color: textPrimary }}>Auto-fill chapters</p>
                                    <p className="text-xs" style={{ color: textSecondary }}>Fill to max available after URL detection.</p>
                                </div>
                                <button
                                    onClick={() => setCrawlAutoMaxChapters((v) => !v)}
                                    className="relative inline-flex h-7 w-12 items-center rounded-full transition-colors flex-shrink-0"
                                    style={{ background: crawlAutoMaxChapters ? primary : (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)') }}
                                >
                                    <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${crawlAutoMaxChapters ? 'translate-x-6' : 'translate-x-1'}`} />
                                </button>
                            </div>
                        </div>
                    </div>
                );
            case 'audio':
                return (
                    <div className="space-y-3">
                        <div className={`${sectionCard}`} style={{ background: cardBg, borderColor: cardBorder }}>
                            <p className={`text-sm font-semibold mb-0.5`} style={{ color: textPrimary }}>Auto Audio</p>
                            <p className="text-xs mb-4" style={{ color: textSecondary }}>Pipeline backoff after a failed story.</p>
                            <div className="space-y-4">
                                <div>
                                    <label htmlFor="mob-audio-rest" className={labelCls}>Backoff after failed story (seconds)</label>
                                    <input id="mob-audio-rest" type="number" min={0} max={600} value={autoAudioRestSeconds} onChange={(e) => setAutoAudioRestSeconds(Math.max(0, Number.parseInt(e.target.value, 10) || 0))} className={inputCls} style={{ background: inputBg, borderColor: inputBorder }} />
                                </div>
                            </div>
                        </div>
                        <div className={`${sectionCard}`} style={{ background: cardBg, borderColor: cardBorder }}>
                            <div>
                                <label htmlFor="mob-test-ids" className={labelCls}>Test Story IDs</label>
                                <textarea id="mob-test-ids" value={autoAudioTestIdsText} onChange={(e) => { setAutoAudioTestIdsText(e.target.value); setAutoAudioTestStoryIds(e.target.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)); }} rows={3} className={`${inputCls} resize-none font-mono text-xs`} style={{ background: inputBg, borderColor: inputBorder }} />
                            </div>
                        </div>
                    </div>
                );
            case 'inkitt':
                return (
                    <div className={`${sectionCard}`} style={{ background: cardBg, borderColor: cardBorder }}>
                        <div>
                            <p className={`text-sm font-semibold mb-0.5`} style={{ color: textPrimary }}>Inkitt Cookies</p>
                            <p className="text-xs" style={{ color: textSecondary }}>Login cookies for Inkitt chapter crawling.</p>
                        </div>
                        <div>
                            <label htmlFor="mob-inkitt-user" className={labelCls}>user_credentials</label>
                            <textarea id="mob-inkitt-user" value={inkittUserCredentials} onChange={(e) => { setInkittUserCredentials(e.target.value); setInkittCookieError(''); setInkittCookieMessage(''); }} rows={3} className={`${inputCls} min-h-[90px] resize-y font-mono text-xs`} style={{ background: inputBg, borderColor: inputBorder }} />
                        </div>
                        <div>
                            <label htmlFor="mob-inkitt-cf" className={labelCls}>cf_clearance</label>
                            <textarea id="mob-inkitt-cf" value={inkittCfClearance} onChange={(e) => { setInkittCfClearance(e.target.value); setInkittCookieError(''); setInkittCookieMessage(''); }} rows={3} className={`${inputCls} min-h-[90px] resize-y font-mono text-xs`} style={{ background: inputBg, borderColor: inputBorder }} />
                        </div>
                        <div>
                            <label htmlFor="mob-inkitt-ua" className={labelCls}>Browser User-Agent (auto-extracted if upload/paste JSON)</label>
                            <textarea id="mob-inkitt-ua" value={inkittUserAgent} onChange={(e) => { setInkittUserAgent(e.target.value); setInkittCookieError(''); setInkittCookieMessage(''); }} rows={2} className={`${inputCls} resize-y font-mono text-xs`} placeholder={'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/... Safari/537.36'} style={{ background: inputBg, borderColor: inputBorder }} />
                        </div>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={handleSaveInkittCookies}
                                disabled={savingInkittCookies || !inkittUserCredentials.trim() || !inkittCfClearance.trim()}
                                className="flex-1 rounded-xl py-2.5 text-sm font-semibold disabled:cursor-not-allowed"
                                style={{ background: savingInkittCookies || !inkittUserCredentials.trim() || !inkittCfClearance.trim() ? (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)') : primary, color: savingInkittCookies || !inkittUserCredentials.trim() || !inkittCfClearance.trim() ? textTertiary : '#fff' }}
                            >
                                {savingInkittCookies ? 'Saving...' : 'Save Cookies'}
                            </button>
                            <button
                                type="button"
                                onClick={handleCheckInkittCookies}
                                disabled={checkingInkittCookies}
                                className="flex-1 rounded-xl border py-2.5 text-sm font-semibold disabled:cursor-not-allowed"
                                style={{ borderColor: cardBorder, background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', color: textPrimary }}
                            >
                                {checkingInkittCookies ? 'Testing...' : 'Test Cookies'}
                            </button>
                        </div>
                        <div className="pt-2">
                            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border py-2.5 text-sm font-medium" style={{ borderColor: cardBorder, background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', color: textPrimary }}>
                                <span>Upload Cookies JSON</span>
                                <input type="file" accept="application/json" onChange={handleInkittJsonFileUpload} className="hidden" />
                            </label>
                        </div>
                        <div className="flex items-center gap-2 pt-2">
                            <textarea value={inkittJsonText} onChange={(e) => setInkittJsonText(e.target.value)} rows={2} placeholder={'{\n  "user_credentials": "...",\n  "cf_clearance": "...",\n  "user_agent": "..."\n}'} className={`${inputCls} resize-none font-mono text-xs`} style={{ background: inputBg, borderColor: inputBorder }} />
                            <button onClick={handleInkittJsonPaste} disabled={!inkittJsonText.trim()} className="rounded-xl px-3 py-3 text-sm font-semibold disabled:cursor-not-allowed" style={{ background: inkittJsonText.trim() ? primary : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'), color: inkittJsonText.trim() ? '#fff' : textTertiary }}>Apply</button>
                        </div>
                        <p className="text-xs" style={{ color: textTertiary }}>Get these from Chrome DevTools → Application → Cookies for inkitt.com.</p>
                        {inkittCookieMessage && <p className="text-sm" style={{ color: success }}>{inkittCookieMessage}</p>}
                        {inkittCookieError && <p className="text-sm" style={{ color: danger }}>{inkittCookieError}</p>}
                    </div>
                );
            case 'scribblehub':
                return (
                    <div className={`${sectionCard}`} style={{ background: cardBg, borderColor: cardBorder }}>
                        <div>
                            <p className={`text-sm font-semibold mb-0.5`} style={{ color: textPrimary }}>ScribbleHub Cookies</p>
                            <p className="text-xs" style={{ color: textSecondary }}>Cloudflare bypass cookies.</p>
                        </div>
                        <div>
                            <label htmlFor="mob-scribblehub-cookies" className={labelCls}>Cookies — `cf_clearance=...`, Cookie header, or JSON cookie array</label>
                            <textarea id="mob-scribblehub-cookies" value={scribblehubCookies} onChange={(e) => { setScribblehubCookies(e.target.value); setScribblehubCookieError(''); setScribblehubCookieMessage(''); }} rows={3} className={`${inputCls} min-h-[90px] resize-y font-mono text-xs`} style={{ background: inputBg, borderColor: inputBorder }} />
                        </div>
                        <div>
                            <label htmlFor="mob-scribblehub-ua" className={labelCls}>Browser User-Agent (run `navigator.userAgent` in DevTools)</label>
                            <textarea id="mob-scribblehub-ua" value={scribblehubUserAgent} onChange={(e) => { setScribblehubUserAgent(e.target.value); setScribblehubCookieError(''); setScribblehubCookieMessage(''); }} rows={2} className={`${inputCls} resize-y font-mono text-xs`} style={{ background: inputBg, borderColor: inputBorder }} />
                        </div>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={handleSaveScribblehubCookies}
                                disabled={savingScribblehubCookies || !scribblehubCookies.trim() || !scribblehubUserAgent.trim()}
                                className="flex-1 rounded-xl py-2.5 text-sm font-semibold disabled:cursor-not-allowed"
                                style={{ background: savingScribblehubCookies || !scribblehubCookies.trim() || !scribblehubUserAgent.trim() ? (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)') : primary, color: savingScribblehubCookies || !scribblehubCookies.trim() || !scribblehubUserAgent.trim() ? textTertiary : '#fff' }}
                            >
                                {savingScribblehubCookies ? 'Saving...' : 'Save Cookies'}
                            </button>
                            <button
                                type="button"
                                onClick={handleCheckScribblehubCookies}
                                disabled={checkingScribblehubCookies}
                                className="flex-1 rounded-xl border py-2.5 text-sm font-semibold disabled:cursor-not-allowed"
                                style={{ borderColor: cardBorder, background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', color: textPrimary }}
                            >
                                {checkingScribblehubCookies ? 'Testing...' : 'Test Cookies'}
                            </button>
                        </div>
                        <div className="pt-2">
                            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border py-2.5 text-sm font-medium animate-transition" style={{ borderColor: cardBorder, background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', color: textPrimary }}>
                                <span>Upload Cookies JSON</span>
                                <input type="file" accept="application/json" onChange={handleScribblehubJsonFileUpload} className="hidden" />
                            </label>
                        </div>
                        <p className="text-xs" style={{ color: textTertiary }}>Cookies expire every ~30-60 min. Re-paste when crawls fail.</p>
                        {scribblehubCookieMessage && <p className="text-sm" style={{ color: success }}>{scribblehubCookieMessage}</p>}
                        {scribblehubCookieError && <p className="text-sm" style={{ color: danger }}>{scribblehubCookieError}</p>}
                    </div>
                );
            case 'novelhall':
                return (
                    <div className={`${sectionCard}`} style={{ background: cardBg, borderColor: cardBorder }}>
                        <div>
                            <p className={`text-sm font-semibold mb-0.5`} style={{ color: textPrimary }}>NovelHall Cookies</p>
                            <p className="text-xs" style={{ color: textSecondary }}>Cloudflare bypass cookies.</p>
                        </div>
                        <div>
                            <label htmlFor="mob-novelhall-cookies" className={labelCls}>Cookies — `cf_clearance=...`, Cookie header, or JSON cookie array</label>
                            <textarea id="mob-novelhall-cookies" value={novelhallCookies} onChange={(e) => { setNovelhallCookies(e.target.value); setNovelhallCookieError(''); setNovelhallCookieMessage(''); }} rows={3} className={`${inputCls} min-h-[90px] resize-y font-mono text-xs`} style={{ background: inputBg, borderColor: inputBorder }} />
                        </div>
                        <div>
                            <label htmlFor="mob-novelhall-ua" className={labelCls}>Browser User-Agent (run `navigator.userAgent` in DevTools)</label>
                            <textarea id="mob-novelhall-ua" value={novelhallUserAgent} onChange={(e) => { setNovelhallUserAgent(e.target.value); setNovelhallCookieError(''); setNovelhallCookieMessage(''); }} rows={2} className={`${inputCls} resize-y font-mono text-xs`} style={{ background: inputBg, borderColor: inputBorder }} />
                        </div>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={handleSaveNovelhallCookies}
                                disabled={savingNovelhallCookies || !novelhallCookies.trim() || !novelhallUserAgent.trim()}
                                className="flex-1 rounded-xl py-2.5 text-sm font-semibold disabled:cursor-not-allowed"
                                style={{ background: savingNovelhallCookies || !novelhallCookies.trim() || !novelhallUserAgent.trim() ? (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)') : primary, color: savingNovelhallCookies || !novelhallCookies.trim() || !novelhallUserAgent.trim() ? textTertiary : '#fff' }}
                            >
                                {savingNovelhallCookies ? 'Saving...' : 'Save Cookies'}
                            </button>
                            <button
                                type="button"
                                onClick={handleCheckNovelhallCookies}
                                disabled={checkingNovelhallCookies}
                                className="flex-1 rounded-xl border py-2.5 text-sm font-semibold disabled:cursor-not-allowed"
                                style={{ borderColor: cardBorder, background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', color: textPrimary }}
                            >
                                {checkingNovelhallCookies ? 'Testing...' : 'Test Cookies'}
                            </button>
                        </div>
                        <div className="pt-2">
                            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border py-2.5 text-sm font-medium animate-transition" style={{ borderColor: cardBorder, background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', color: textPrimary }}>
                                <span>Upload Cookies JSON</span>
                                <input type="file" accept="application/json" onChange={handleNovelhallJsonFileUpload} className="hidden" />
                            </label>
                        </div>
                        <p className="text-xs" style={{ color: textTertiary }}>Cookies expire every ~30-60 min. Re-paste when crawls fail.</p>
                        {novelhallCookieMessage && <p className="text-sm" style={{ color: success }}>{novelhallCookieMessage}</p>}
                        {novelhallCookieError && <p className="text-sm" style={{ color: danger }}>{novelhallCookieError}</p>}
                    </div>
                );
            case 'goodnovel':
                return (
                    <div className={`${sectionCard}`} style={{ background: cardBg, borderColor: cardBorder }}>
                        <div>
                            <p className={`text-sm font-semibold mb-0.5`} style={{ color: textPrimary }}>GoodNovel Cookies</p>
                            <p className="text-xs" style={{ color: textSecondary }}>Login cookies to unlock chapters.</p>
                        </div>
                        <div>
                            <label htmlFor="mob-goodnovel-cookies" className={labelCls}>Cookies — full Cookie header (`TOKEN=...; ...`) or JSON cookie array</label>
                            <textarea id="mob-goodnovel-cookies" value={goodnovelCookies} onChange={(e) => { setGoodnovelCookies(e.target.value); setGoodnovelCookieError(''); setGoodnovelCookieMessage(''); }} rows={3} className={`${inputCls} min-h-[90px] resize-y font-mono text-xs`} style={{ background: inputBg, borderColor: inputBorder }} />
                        </div>
                        <div>
                            <label htmlFor="mob-goodnovel-ua" className={labelCls}>Browser User-Agent (optional)</label>
                            <textarea id="mob-goodnovel-ua" value={goodnovelUserAgent} onChange={(e) => { setGoodnovelUserAgent(e.target.value); setGoodnovelCookieError(''); setGoodnovelCookieMessage(''); }} rows={2} className={`${inputCls} resize-y font-mono text-xs`} style={{ background: inputBg, borderColor: inputBorder }} />
                        </div>
                        <div>
                            <label htmlFor="mob-goodnovel-test-url" className={labelCls}>Book URL to test against (optional)</label>
                            <input id="mob-goodnovel-test-url" value={goodnovelTestUrl} onChange={(e) => { setGoodnovelTestUrl(e.target.value); setGoodnovelCookieError(''); setGoodnovelCookieMessage(''); }} className={`${inputCls} font-mono text-xs`} placeholder={'https://www.goodnovel.com/book/Title_31000725726'} style={{ background: inputBg, borderColor: inputBorder }} />
                        </div>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={handleSaveGoodnovelCookies}
                                disabled={savingGoodnovelCookies || !goodnovelCookies.trim()}
                                className="flex-1 rounded-xl py-2.5 text-sm font-semibold disabled:cursor-not-allowed"
                                style={{ background: savingGoodnovelCookies || !goodnovelCookies.trim() ? (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)') : primary, color: savingGoodnovelCookies || !goodnovelCookies.trim() ? textTertiary : '#fff' }}
                            >
                                {savingGoodnovelCookies ? 'Saving...' : 'Save Cookies'}
                            </button>
                            <button
                                type="button"
                                onClick={handleCheckGoodnovelCookies}
                                disabled={checkingGoodnovelCookies}
                                className="flex-1 rounded-xl border py-2.5 text-sm font-semibold disabled:cursor-not-allowed"
                                style={{ borderColor: cardBorder, background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', color: textPrimary }}
                            >
                                {checkingGoodnovelCookies ? 'Testing...' : 'Test Cookies'}
                            </button>
                        </div>
                        <div className="pt-2">
                            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border py-2.5 text-sm font-medium" style={{ borderColor: cardBorder, background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', color: textPrimary }}>
                                <span>Upload goodnovel.json</span>
                                <input type="file" accept="application/json" onChange={handleGoodnovelJsonFileUpload} className="hidden" />
                            </label>
                        </div>
                        <p className="text-xs" style={{ color: textTertiary }}>TOKEN cookie expires — upload goodnovel.json or paste TOKEN cookie directly.</p>
                        {goodnovelCookieMessage && <p className="text-sm" style={{ color: success }}>{goodnovelCookieMessage}</p>}
                        {goodnovelCookieError && <p className="text-sm" style={{ color: danger }}>{goodnovelCookieError}</p>}
                    </div>
                );
            case 'webnovel':
                return (
                    <div className={`${sectionCard}`} style={{ background: cardBg, borderColor: cardBorder }}>
                        <div>
                            <p className={`text-sm font-semibold mb-0.5`} style={{ color: textPrimary }}>WebNovel Cookies</p>
                            <p className="text-xs" style={{ color: textSecondary }}>Cloudflare and login cookies for WebNovel crawling.</p>
                        </div>
                        <div>
                            <label htmlFor="mob-webnovel-cookies" className={labelCls}>Cookies - `cf_clearance=...`, Cookie header, or JSON cookie array</label>
                            <textarea id="mob-webnovel-cookies" value={webnovelCookies} onChange={(e) => { setWebnovelCookies(e.target.value); setWebnovelCookieError(''); setWebnovelCookieMessage(''); }} rows={3} className={`${inputCls} min-h-[90px] resize-y font-mono text-xs`} style={{ background: inputBg, borderColor: inputBorder }} />
                        </div>
                        <div>
                            <label htmlFor="mob-webnovel-ua" className={labelCls}>Browser User-Agent</label>
                            <textarea id="mob-webnovel-ua" value={webnovelUserAgent} onChange={(e) => { setWebnovelUserAgent(e.target.value); setWebnovelCookieError(''); setWebnovelCookieMessage(''); }} rows={2} className={`${inputCls} resize-y font-mono text-xs`} style={{ background: inputBg, borderColor: inputBorder }} />
                        </div>
                        <div>
                            <label htmlFor="mob-webnovel-test-url" className={labelCls}>WebNovel URL to test against (optional)</label>
                            <input id="mob-webnovel-test-url" value={webnovelTestUrl} onChange={(e) => { setWebnovelTestUrl(e.target.value); setWebnovelCookieError(''); setWebnovelCookieMessage(''); }} className={`${inputCls} font-mono text-xs`} placeholder={'https://www.webnovel.com/book/title_123'} style={{ background: inputBg, borderColor: inputBorder }} />
                        </div>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={handleSaveWebnovelCookies}
                                disabled={savingWebnovelCookies || !webnovelCookies.trim() || !webnovelUserAgent.trim()}
                                className="flex-1 rounded-xl py-2.5 text-sm font-semibold disabled:cursor-not-allowed"
                                style={{ background: savingWebnovelCookies || !webnovelCookies.trim() || !webnovelUserAgent.trim() ? (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)') : primary, color: savingWebnovelCookies || !webnovelCookies.trim() || !webnovelUserAgent.trim() ? textTertiary : '#fff' }}
                            >
                                {savingWebnovelCookies ? 'Saving...' : 'Save Cookies'}
                            </button>
                            <button
                                type="button"
                                onClick={handleCheckWebnovelCookies}
                                disabled={checkingWebnovelCookies}
                                className="flex-1 rounded-xl border py-2.5 text-sm font-semibold disabled:cursor-not-allowed"
                                style={{ borderColor: cardBorder, background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', color: textPrimary }}
                            >
                                {checkingWebnovelCookies ? 'Testing...' : 'Test Cookies'}
                            </button>
                        </div>
                        <div className="pt-2">
                            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border py-2.5 text-sm font-medium" style={{ borderColor: cardBorder, background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', color: textPrimary }}>
                                <span>Upload Cookies JSON</span>
                                <input type="file" accept="application/json" onChange={handleWebnovelJsonFileUpload} className="hidden" />
                            </label>
                        </div>
                        <p className="text-xs" style={{ color: textTertiary }}>Save cf_clearance and the same browser User-Agent. Locked chapters still require account access.</p>
                        {webnovelCookieMessage && <p className="text-sm" style={{ color: success }}>{webnovelCookieMessage}</p>}
                        {webnovelCookieError && <p className="text-sm" style={{ color: danger }}>{webnovelCookieError}</p>}
                    </div>
                );
            case 'driveSync':
                return (
                    <div className="space-y-4">
                        <div className={`${sectionCard}`} style={{ background: cardBg, borderColor: cardBorder }}>
                            <div>
                                <p className={`text-sm font-semibold mb-0.5`} style={{ color: textPrimary }}>Drive Sync Configuration</p>
                                <p className="text-xs" style={{ color: textSecondary }}>Configure Google Drive sync and backend API details.</p>
                            </div>
                            <div className="pt-2">
                                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border py-2.5 text-sm font-medium" style={{ borderColor: cardBorder, background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', color: textPrimary }}>
                                    <span>Upload JSON</span>
                                    <input type="file" accept="application/json" onChange={handleJsonFileUpload} className="hidden" />
                                </label>
                            </div>
                            {uploadError && <p className="text-sm" style={{ color: danger }}>{uploadError}</p>}
                        </div>
                        <DriveConfig
                            embedded
                            configForm={configForm}
                            onFormChange={handleConfigFormChange}
                            onSave={handleSaveConfig}
                            savingConfig={savingConfig}
                            savingConfigError={savingConfigError}
                            isInitialSetup={isInitialSetup}
                            themeMode={themeMode}
                            credentialFileExists={credentialFileExists}
                            onCredentialUploadSuccess={() => setCredentialFileExists(true)}
                        />
                        {config && (
                            <div className="rounded-xl border p-4 space-y-2 text-xs" style={{ borderColor: cardBorder, background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' }}>
                                <p className="font-semibold text-sm" style={{ color: textPrimary }}>Current configuration</p>
                                <div className="space-y-1">
                                    <div><span style={{ color: textTertiary }}>API URL:</span><span className="ml-2 break-all font-mono" style={{ color: textPrimary }}>{config.main_be_api_base_url || 'Not configured'}</span></div>
                                    <div><span style={{ color: textTertiary }}>User ID:</span><span className="ml-2 break-all font-mono" style={{ color: textPrimary }}>{config.main_be_user_id ? `${config.main_be_user_id.slice(0, 8)}...` : 'Not configured'}</span></div>
                                    <div><span style={{ color: textTertiary }}>Folder ID:</span><span className="ml-2 break-all font-mono" style={{ color: textPrimary }}>{config.folder_id ? `${config.folder_id.slice(0, 12)}...` : 'Not configured'}</span></div>
                                    <div><span style={{ color: textTertiary }}>Service Account:</span><span className="ml-2 font-mono" style={{ color: textPrimary }}>{config.service_account_json_name || 'Not configured'}</span></div>
                                </div>
                            </div>
                        )}
                    </div>
                );
            case 'danger':
                return (
                    <div className={`${sectionCard}`} style={{ background: cardBg, borderColor: isDark ? 'rgba(220,38,38,0.2)' : 'rgba(220,38,38,0.12)' }}>
                        <p className={`text-sm font-semibold mb-0.5`} style={{ color: danger }}>Advanced Cleanup</p>
                        <p className="text-xs mb-3" style={{ color: textSecondary }}>Clear runtime histories, outputs, sessions, jobs, logs, settings, and Drive credentials.</p>
                        {isAdmin ? (
                            <>
                                <div className="mb-3">
                                    <label htmlFor="mob-clear-confirm" className={labelCls}>Type CLEAR_BACKEND_DATA to confirm</label>
                                    <input
                                        id="mob-clear-confirm"
                                        type="text"
                                        value={clearConfirm}
                                        onChange={(e) => setClearConfirm(e.target.value)}
                                        placeholder="CLEAR_BACKEND_DATA"
                                        className={`${inputCls} font-mono text-sm`}
                                        style={{ background: inputBg, borderColor: inputBorder }}
                                    />
                                </div>
                                <button
                                    type="button"
                                    onClick={handleClearBackendData}
                                    disabled={clearState === 'clearing' || clearConfirm.trim() !== 'CLEAR_BACKEND_DATA'}
                                    className="w-full rounded-xl py-3 text-sm font-semibold disabled:cursor-not-allowed"
                                    style={{ background: clearState === 'clearing' || clearConfirm.trim() !== 'CLEAR_BACKEND_DATA' ? (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)') : danger, color: clearState === 'clearing' || clearConfirm.trim() !== 'CLEAR_BACKEND_DATA' ? textTertiary : '#fff' }}
                                >
                                    {clearState === 'clearing' ? 'Clearing...' : 'Clear Backend Data'}
                                </button>
                            </>
                        ) : (
                            <div className="rounded-xl border px-4 py-3 text-sm" style={{ borderColor: cardBorder, background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)', color: textSecondary }}>
                                Admin access is required.
                            </div>
                        )}
                    </div>
                );
            default:
                return null;
        }
    };

    const activeCategoryItem = activeCategory ? CATEGORIES.find((c) => c.id === activeCategory) : null;

    return (
        <div className="fixed inset-0 z-[90] flex flex-col lg:hidden" style={{ background: bg }}>
            {/* Header */}
            <header
                className="flex items-center gap-3 px-4 pt-3 pb-3"
                style={{ borderBottom: `1px solid ${cardBorder}`, paddingTop: `max(env(safe-area-inset-top), 12px)` }}
            >
                {activeCategory !== null && (
                    <button
                        type="button"
                        onClick={() => setActiveCategory(null)}
                        className="flex h-9 w-9 items-center justify-center rounded-xl transition-colors"
                        style={{ color: textSecondary, background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                        aria-label="Back"
                    >
                        <Icon icon={appIcons.chevronLeft} className="h-5 w-5" />
                    </button>
                )}
                {activeCategory === null && (
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex h-9 w-9 items-center justify-center rounded-xl transition-colors"
                        style={{ color: textSecondary, background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                        aria-label="Close settings"
                    >
                        <Icon icon={appIcons.close} className="h-4 w-4" />
                    </button>
                )}
                <div className="flex-1 min-w-0">
                    <h1 className="text-base font-semibold truncate" style={{ color: textPrimary }}>
                        Settings
                    </h1>
                    {activeCategory !== null && (
                        <p className="text-xs truncate" style={{ color: textSecondary }}>
                            {activeCategoryItem?.label}
                        </p>
                    )}
                </div>
                {activeCategory !== null && (
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex h-9 w-9 items-center justify-center rounded-xl transition-colors"
                        style={{ color: textSecondary, background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                        aria-label="Close"
                    >
                        <Icon icon={appIcons.close} className="h-4 w-4" />
                    </button>
                )}
            </header>

            {activeCategory === null ? (
                /* Category list */
                <div className="flex-1 overflow-y-auto px-4 py-3">
                    <div className="space-y-2 pb-4">
                        {CATEGORIES.map((cat) => (
                            <button
                                key={cat.id}
                                type="button"
                                onClick={() => setActiveCategory(cat.id)}
                                className="w-full flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition-colors"
                                style={{ background: cardBg, borderColor: cardBorder }}
                            >
                                <span
                                    className="flex h-10 w-10 items-center justify-center rounded-xl"
                                    style={{ background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', color: textSecondary }}
                                >
                                    <Icon icon={appIcons[cat.icon]} className="h-5 w-5" />
                                </span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-sm font-medium" style={{ color: textPrimary }}>{cat.label}</span>
                                    <span className="block text-xs" style={{ color: textSecondary }}>{cat.description}</span>
                                </span>
                                <Icon icon={appIcons.chevronRight} className="h-4 w-4 flex-shrink-0" style={{ color: textTertiary }} />
                            </button>
                        ))}
                    </div>
                </div>
            ) : (
                /* Category content */
                <div className="flex-1 overflow-y-auto px-4 py-4">
                    {error && (
                        <div className="mb-3 rounded-xl border px-4 py-3 text-sm transition-opacity duration-300" style={{ opacity: errorBannerVisible ? 1 : 0, borderColor: isDark ? 'rgba(220,38,38,0.3)' : 'rgba(220,38,38,0.2)', background: isDark ? 'rgba(220,38,38,0.08)' : 'rgba(254,242,242,0.95)', color: isDark ? 'rgb(252,165,165)' : 'rgb(185,28,28)' }}>
                            {error}
                        </div>
                    )}
                    {renderContent()}
                </div>
            )}

            {/* Save footer */}
            {(activeCategory === 'appearance' || activeCategory === 'crawler' || activeCategory === 'audio') && (
                <div
                    className="px-4 py-3"
                    style={{ borderTop: `1px solid ${cardBorder}`, paddingBottom: `max(env(safe-area-inset-top), 12px)`, background: bg }}
                >
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={saveState === 'saving' || saveState === 'saved'}
                        className="w-full rounded-xl py-3 text-sm font-semibold"
                        style={{
                            background: saveState === 'saved' ? success : saveState === 'saving' ? (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)') : primary,
                            color: saveState === 'saved' ? '#fff' : saveState === 'saving' ? textTertiary : '#fff',
                        }}
                    >
                        {saveState === 'saving' ? 'Saving...' : saveState === 'saved' ? 'Saved' : 'Save Changes'}
                    </button>
                </div>
            )}
        </div>
    );
}

export default MobileSettingsPage;
