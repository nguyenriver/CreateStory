import { useEffect, useMemo, useState } from 'react';
import {
  clearBackendData,
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
  updateJobnibCookies,
  checkJobnibCookies,
  getSettings,
  updateSettings,
  getDriveSyncConfig,
  initDriveSyncConfig,
  checkCredentialsExists,
  getStoredAuthUser,
  type SettingsResponse,
  type DriveSyncConfig,
  FIXED_JSON_PREFIX,
} from '../../api';
import { DriveConfig, type ConfigFormData } from '../../components/Shared/DriveConfig';
import { Icon, appIcons } from '../../components/Shared/Icon';
import type { ThemeMode } from '../../types/theme';
import { showToast } from '../../components/Shared/Toast';

type SettingsCategory = 'profile' | 'appearance' | 'driveSync' | 'inkitt' | 'scribblehub' | 'novelhall' | 'goodnovel' | 'webnovel' | 'jobnib' | 'crawler' | 'audio' | 'danger';

interface SettingsPageProps {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  onClose: () => void;
  onLogout: () => void | Promise<void>;
}

interface CategoryItem {
  id: SettingsCategory;
  label: string;
  description: string;
  icon: keyof typeof appIcons;
}

const CATEGORY_ITEMS: CategoryItem[] = [
  { id: 'profile', label: 'Profile', description: 'Account information', icon: 'user' },
  { id: 'appearance', label: 'Appearance', description: 'Theme and display', icon: 'moon' },
  { id: 'driveSync', label: 'Drive Sync', description: 'Google Drive and API', icon: 'sync' },
  { id: 'inkitt', label: 'Inkitt Cookies', description: 'Crawler login cookies', icon: 'shield' },
  { id: 'scribblehub', label: 'ScribbleHub Cookies', description: 'Cloudflare bypass cookies', icon: 'shield' },
  { id: 'novelhall', label: 'NovelHall Cookies', description: 'Cloudflare bypass cookies', icon: 'shield' },
  { id: 'goodnovel', label: 'GoodNovel Cookies', description: 'Login cookies to unlock chapters', icon: 'shield' },
  { id: 'webnovel', label: 'WebNovel Cookies', description: 'Cloudflare and login cookies', icon: 'shield' },
  { id: 'jobnib', label: 'Jobnib Session', description: 'Cloudflare cookies and User-Agent', icon: 'shield' },
  { id: 'crawler', label: 'Crawler', description: 'Default crawl behavior', icon: 'settings' },
  { id: 'audio', label: 'Audio Pipeline', description: 'Auto Audio and TTS', icon: 'music' },
  { id: 'danger', label: 'Advanced', description: 'Cleanup actions', icon: 'delete' },
];

function SectionTitle({
  title,
  description,
  pageText,
  secondaryText,
}: Readonly<{
  title: string;
  description: string;
  pageText: string;
  secondaryText: string;
}>) {
  return (
    <div className="space-y-1">
      <h2 className="text-sm font-semibold" style={{ color: pageText }}>{title}</h2>
      <p className="text-xs leading-5" style={{ color: secondaryText }}>{description}</p>
    </div>
  );
}

export function SettingsPage({ themeMode, onThemeChange, onClose, onLogout }: Readonly<SettingsPageProps>) {
  const isDark = themeMode === 'dark';
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState('');
  const [errorBannerVisible, setErrorBannerVisible] = useState(false);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('appearance');

  const [localTheme, setLocalTheme] = useState<'light' | 'dark'>(themeMode === 'dark' ? 'dark' : 'light');
  const [crawlMode, setCrawlMode] = useState<'count' | 'range'>('count');
  const [count, setCount] = useState(10);
  const [rangeFrom, setRangeFrom] = useState(1);
  const [rangeTo, setRangeTo] = useState(10);
  const [crawlAutoMaxChapters, setCrawlAutoMaxChapters] = useState(false);
  const [autoAudioRestSeconds, setAutoAudioRestSeconds] = useState(0);
  const [autoAudioTestStoryIds, setAutoAudioTestStoryIds] = useState<string[]>([]);
  const [autoAudioTestIdsText, setAutoAudioTestIdsText] = useState('');
  const [clearState, setClearState] = useState<'idle' | 'clearing'>('idle');
  const [clearConfirm, setClearConfirm] = useState('');
  const authUser = getStoredAuthUser();
  const isAdmin = authUser?.role === 'admin';

  const pageText = isDark ? 'rgba(255,255,255,0.92)' : '#37352f';
  const secondaryText = isDark ? 'rgba(255,255,255,0.48)' : 'rgba(55,53,47,0.64)';
  const tertiaryText = isDark ? 'rgba(255,255,255,0.32)' : 'rgba(55,53,47,0.46)';
  const shellBackground = isDark ? 'rgba(18,18,17,0.96)' : 'rgba(251,251,250,0.96)';
  const panelBackground = isDark ? 'rgba(28,28,27,0.96)' : 'rgba(255,255,255,0.96)';
  const panelBorder = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(17,17,17,0.09)';
  const subtleSurface = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(55,53,47,0.05)';
  const subtleSurfaceHover = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(55,53,47,0.08)';
  const activeSurface = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(55,53,47,0.1)';
  const inputBackground = isDark ? '#232323' : '#ffffff';
  const inputBorder = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(55,53,47,0.16)';
  const primaryButton = '#ff5b00';

  const sectionClassName = 'rounded-2xl border p-4 space-y-4 shadow-sm';
  const labelClassName = `block text-xs mb-1.5 ${isDark ? 'text-white/55' : 'text-[rgba(55,53,47,0.68)]'}`;
  const fieldClassName = `w-full rounded-md border px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent ${isDark ? 'text-white/90 placeholder:text-white/25' : 'text-[rgba(55,53,47,0.92)] placeholder:text-[rgba(55,53,47,0.35)]'}`;

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
  const [inkittUserCredentials, setInkittUserCredentials] = useState('');
  const [inkittCfClearance, setInkittCfClearance] = useState('');
  const [inkittUserAgent, setInkittUserAgent] = useState('');
  const [savingInkittCookies, setSavingInkittCookies] = useState(false);
  const [checkingInkittCookies, setCheckingInkittCookies] = useState(false);
  const [inkittCookieError, setInkittCookieError] = useState('');
  const [inkittCookieMessage, setInkittCookieMessage] = useState('');
  const [inkittJsonText, setInkittJsonText] = useState('');
  const [scribblehubCookies, setScribblehubCookies] = useState('');
  const [scribblehubUserAgent, setScribblehubUserAgent] = useState('');
  const [savingScribblehubCookies, setSavingScribblehubCookies] = useState(false);
  const [checkingScribblehubCookies, setCheckingScribblehubCookies] = useState(false);
  const [scribblehubCookieError, setScribblehubCookieError] = useState('');
  const [scribblehubCookieMessage, setScribblehubCookieMessage] = useState('');
  const [novelhallCookies, setNovelhallCookies] = useState('');
  const [novelhallUserAgent, setNovelhallUserAgent] = useState('');
  const [savingNovelhallCookies, setSavingNovelhallCookies] = useState(false);
  const [checkingNovelhallCookies, setCheckingNovelhallCookies] = useState(false);
  const [novelhallCookieError, setNovelhallCookieError] = useState('');
  const [novelhallCookieMessage, setNovelhallCookieMessage] = useState('');
  const [goodnovelCookies, setGoodnovelCookies] = useState('');
  const [goodnovelUserAgent, setGoodnovelUserAgent] = useState('');
  const [goodnovelTestUrl, setGoodnovelTestUrl] = useState('');
  const [savingGoodnovelCookies, setSavingGoodnovelCookies] = useState(false);
  const [checkingGoodnovelCookies, setCheckingGoodnovelCookies] = useState(false);
  const [goodnovelCookieError, setGoodnovelCookieError] = useState('');
  const [goodnovelCookieMessage, setGoodnovelCookieMessage] = useState('');
  const [webnovelCookies, setWebnovelCookies] = useState('');
  const [webnovelUserAgent, setWebnovelUserAgent] = useState('');
  const [webnovelTestUrl, setWebnovelTestUrl] = useState('');
  const [savingWebnovelCookies, setSavingWebnovelCookies] = useState(false);
  const [checkingWebnovelCookies, setCheckingWebnovelCookies] = useState(false);
  const [webnovelCookieError, setWebnovelCookieError] = useState('');
  const [webnovelCookieMessage, setWebnovelCookieMessage] = useState('');
  const [jobnibCookies, setJobnibCookies] = useState('');
  const [jobnibUserAgent, setJobnibUserAgent] = useState('');
  const [jobnibTestUrl, setJobnibTestUrl] = useState('');
  const [savingJobnibCookies, setSavingJobnibCookies] = useState(false);
  const [checkingJobnibCookies, setCheckingJobnibCookies] = useState(false);
  const [jobnibCookieError, setJobnibCookieError] = useState('');
  const [jobnibCookieMessage, setJobnibCookieMessage] = useState('');

  useEffect(() => {
    getSettings()
      .then((s) => {
        setSettings(s);
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
  }, [themeMode, setSettings]);

  useEffect(() => {
    async function loadConfig() {
      try {
        const cfg = await getDriveSyncConfig();
        setConfig(cfg);
        if (cfg) {
          const jsonName = cfg.service_account_json_name || 'google-service-account.json';
          setConfigForm({
            folder_id: cfg.folder_id || '',
            service_account_json_name: jsonName,
            main_be_api_base_url: cfg.main_be_api_base_url || '',
            main_be_bearer_token: cfg.main_be_bearer_token || '',
            main_be_user_id: cfg.main_be_user_id || '',
          });
          const exists = await checkCredentialsExists(jsonName);
          setCredentialFileExists(exists);
        } else {
          setIsInitialSetup(true);
        }
      } catch {
        // ignore
      }
    }
    loadConfig();
  }, []);

  const handleClose = onClose;

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleClose();
      }
    };

    document.body.style.overflow = 'hidden';
    globalThis.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = '';
      globalThis.removeEventListener('keydown', onKeyDown);
    };
  }, [handleClose]);

  const categories = useMemo(() => CATEGORY_ITEMS, []);

  const handleConfigFormChange = (data: Partial<ConfigFormData>) => {
    setConfigForm((prev) => ({ ...prev, ...data }));
  };

  const handleSaveConfig = async () => {
    setSavingConfigError('');
    if (!configForm.folder_id.trim()) {
      setSavingConfigError('Folder ID is required.');
      return;
    }
    setSavingConfig(true);

    try {
      const cfg = await initDriveSyncConfig({
        folder_id: configForm.folder_id,
        service_account_json_path: FIXED_JSON_PREFIX + configForm.service_account_json_name,
        main_be_api_base_url: configForm.main_be_api_base_url,
        main_be_bearer_token: configForm.main_be_bearer_token,
        main_be_user_id: configForm.main_be_user_id,
      });
      setConfig(cfg);
      showToast('Drive Sync configuration saved successfully.', 'success', 2000, 'top-center');
    } catch (e) {
      setSavingConfigError(e instanceof Error ? e.message : 'Failed to save config.');
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
      const updated = await updateSettings({
        theme: localTheme,
        crawl_mode: crawlMode,
        crawl_default_count: count,
        crawl_default_range_from: rangeFrom,
        crawl_default_range_to: rangeTo,
        crawl_auto_max_chapters: crawlAutoMaxChapters,
        auto_audio_rest_seconds: autoAudioRestSeconds,
        auto_audio_test_story_ids: autoAudioTestStoryIds,
      });
      setSettings(updated);
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
        'success',
        3500,
        'top-center',
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

      // Extract user_agent from wrapper object before unwrapping
      let extractedUA = '';
      if (json && !Array.isArray(json) && typeof json === 'object') {
        extractedUA = json.user_agent || json.userAgent || json['User-Agent'] || '';
      }

      // Unwrap wrapper objects (our extractor saves { cookies: [...], user_agent: "..." })
      if (json && !Array.isArray(json) && (json.cookies || json.data)) json = json.cookies || json.data;

      // Array of cookie objects (Selenium / EditThisCookie export) → keep as JSON for the backend parser.
      if (Array.isArray(json)) {
        setScribblehubCookies(JSON.stringify(json));
        // Also check if any cookie entry is named 'user-agent' (EditThisCookie style)
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

      // Auto-populate User-Agent if found
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

      // Extract user_agent from wrapper object before unwrapping
      let extractedUA = '';
      if (json && !Array.isArray(json) && typeof json === 'object') {
        extractedUA = json.user_agent || json.userAgent || json['User-Agent'] || '';
      }

      // Unwrap wrapper objects (our extractor saves { cookies: [...], user_agent: "..." })
      if (json && !Array.isArray(json) && (json.cookies || json.data)) json = json.cookies || json.data;

      // Array of cookie objects (Selenium / EditThisCookie export) → keep as JSON for the backend parser.
      if (Array.isArray(json)) {
        setNovelhallCookies(JSON.stringify(json));
        // Also check if any cookie entry is named 'user-agent' (EditThisCookie style)
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

      // Auto-populate User-Agent if found
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
        // Inconclusive / no-extra — show as an informational message, not an error.
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

      // Extract user_agent from the wrapper object our extractor writes.
      let extractedUA = '';
      if (json && !Array.isArray(json) && typeof json === 'object') {
        extractedUA = json.user_agent || json.userAgent || json['User-Agent'] || '';
      }

      // Unwrap { cookies: [...] } (goodnovel.json) or { data: [...] }.
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

  const handleSaveJobnibCookies = async () => {
    if (!jobnibCookies.trim()) {
      setJobnibCookieError('Paste a raw Jobnib Cookie header or Selenium JSON first.');
      return;
    }
    setSavingJobnibCookies(true); setJobnibCookieError(''); setJobnibCookieMessage('');
    try {
      const result = await updateJobnibCookies(jobnibCookies.trim(), jobnibUserAgent.trim() || undefined);
      const message = `Saved ${result.cookie_count} Jobnib cookie${result.cookie_count === 1 ? '' : 's'}.`;
      setJobnibCookieMessage(result.has_cf_clearance ? message : `${message} No cf_clearance was present; test the session before crawling.`);
      showToast('Jobnib session saved.', 'success', 2200, 'top-center');
    } catch (err) { setJobnibCookieError(err instanceof Error ? err.message : 'Failed to save Jobnib cookies.'); }
    finally { setSavingJobnibCookies(false); }
  };

  const handleCheckJobnibCookies = async () => {
    setCheckingJobnibCookies(true); setJobnibCookieError(''); setJobnibCookieMessage('');
    try {
      const result = await checkJobnibCookies(jobnibTestUrl.trim() || undefined);
      if (result.valid) { setJobnibCookieMessage(result.message); showToast('Jobnib session is working.', 'success', 2200, 'top-center'); }
      else if (result.valid === null) setJobnibCookieMessage(result.message);
      else setJobnibCookieError(result.message);
    } catch (err) { setJobnibCookieError(err instanceof Error ? err.message : 'Failed to test Jobnib cookies.'); }
    finally { setCheckingJobnibCookies(false); }
  };

  const handleJobnibJsonFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed) && typeof parsed === 'object' && parsed?.reader_verified === false) {
        const unlocked = Number(parsed?.reader_state?.unlocked_segments || 0);
        setJobnibCookieError(`This collector file is not verified (${unlocked}/2 chapter segments unlocked). Open both parts in the collector Chrome window and collect again.`);
        return;
      }
      const userAgent = !Array.isArray(parsed) && typeof parsed === 'object' && parsed
        ? String(parsed.user_agent || parsed.userAgent || parsed['User-Agent'] || '') : '';
      const cookies = !Array.isArray(parsed) && typeof parsed === 'object' && parsed && (parsed.cookies || parsed.data)
        ? parsed.cookies || parsed.data : parsed;
      setJobnibCookies(JSON.stringify(cookies));
      if (userAgent) setJobnibUserAgent(userAgent);
      setJobnibCookieError('');
      showToast('Jobnib session JSON loaded.', 'success', 2200, 'top-center');
    } catch (err) { setJobnibCookieError(`Invalid JSON: ${err instanceof Error ? err.message : 'Parse error'}`); }
    finally { event.target.value = ''; }
  };

  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex min-h-[420px] items-center justify-center text-sm" style={{ color: secondaryText }}>
          <div className="flex items-center gap-3">
            <Icon icon={appIcons.spinner} className="h-4 w-4 animate-spin" />
            <span>Loading settings...</span>
          </div>
        </div>
      );
    }

    switch (activeCategory) {
      case 'profile':
        return (
          <section className={sectionClassName} style={{ background: panelBackground, borderColor: panelBorder }}>
            <SectionTitle title="Profile" description="Basic account information for this workspace session." pageText={pageText} secondaryText={secondaryText} />
            <div className="rounded-lg border px-4 py-3" style={{ borderColor: panelBorder, background: subtleSurface }}>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.12em]" style={{ color: tertiaryText }}>Email</p>
                  <p className="mt-1 text-sm font-medium break-all" style={{ color: pageText }}>{authUser?.email || 'Unknown user'}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-[0.12em]" style={{ color: tertiaryText }}>Role</p>
                  <p className="mt-1 text-sm font-medium capitalize" style={{ color: pageText }}>{authUser?.role || 'unknown'}</p>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3" style={{ borderColor: panelBorder, background: subtleSurface }}>
              <div>
                <p className="text-sm font-medium" style={{ color: pageText }}>Session</p>
                <p className="text-xs" style={{ color: tertiaryText }}>Sign out of this account on this device.</p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  await onLogout();
                  handleClose();
                }}
                className="rounded-md px-3 py-2 text-sm font-medium"
                style={{ background: isDark ? 'rgba(239,68,68,0.14)' : 'rgba(220,38,38,0.08)', color: isDark ? 'rgb(252 165 165)' : 'rgb(220 38 38)' }}
              >
                Logout
              </button>
            </div>
          </section>
        );
      case 'appearance':
        return (
          <section className={sectionClassName} style={{ background: panelBackground, borderColor: panelBorder }}>
            <SectionTitle title="Appearance" description="Choose the theme used across the app." pageText={pageText} secondaryText={secondaryText} />
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5" style={{ borderColor: panelBorder, background: subtleSurface }}>
              <div className="min-w-0">
                <p className="text-sm font-medium" style={{ color: pageText }}>Theme</p>
                <p className="text-xs" style={{ color: tertiaryText }}>Switch between light and dark mode.</p>
              </div>
              <div className="inline-flex items-center gap-1 rounded-full p-0.5" style={{ background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(55,53,47,0.06)' }}>
                {(['light', 'dark'] as const).map((mode) => {
                  const active = localTheme === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setLocalTheme(mode)}
                      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition-colors"
                      style={{
                        background: active ? activeSurface : 'transparent',
                        color: active ? pageText : tertiaryText,
                        boxShadow: active ? (isDark ? '0 1px 2px rgba(0,0,0,0.35)' : '0 1px 2px rgba(15,23,42,0.08)') : 'none',
                      }}
                    >
                      <Icon icon={appIcons[mode === 'light' ? 'themeLight' : 'themeDark']} className="h-3.5 w-3.5" />
                      <span className="capitalize">{mode}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
        );
      case 'driveSync':
        return (
          <section className={sectionClassName} style={{ background: panelBackground, borderColor: panelBorder }}>
            <SectionTitle title="Drive Sync Configuration" description="Configure Google Drive sync and backend API connection details." pageText={pageText} secondaryText={secondaryText} />
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium" style={{ borderColor: panelBorder, background: subtleSurface, color: pageText }}>
                <span>Upload JSON</span>
                <input type="file" accept="application/json" onChange={handleJsonFileUpload} className="hidden" />
              </label>
            </div>
            {uploadError && <div className="text-sm" style={{ color: isDark ? 'rgb(248 113 113)' : 'rgb(220 38 38)' }}>{uploadError}</div>}
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
              <div className="rounded-lg border p-4" style={{ borderColor: panelBorder, background: subtleSurface }}>
                <h3 className="mb-3 text-sm font-medium" style={{ color: pageText }}>Current configuration</h3>
                <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                  <div><span style={{ color: tertiaryText }}>API URL:</span><span className="ml-2 break-all font-mono text-xs" style={{ color: pageText }}>{config.main_be_api_base_url || 'Not configured'}</span></div>
                  <div><span style={{ color: tertiaryText }}>User ID:</span><span className="ml-2 break-all font-mono text-xs" style={{ color: pageText }}>{config.main_be_user_id ? `${config.main_be_user_id.slice(0, 8)}...` : 'Not configured'}</span></div>
                  <div><span style={{ color: tertiaryText }}>Folder ID:</span><span className="ml-2 break-all font-mono text-xs" style={{ color: pageText }}>{config.folder_id ? `${config.folder_id.slice(0, 12)}...` : 'Not configured'}</span></div>
                  <div><span style={{ color: tertiaryText }}>Service Account:</span><span className="ml-2 font-mono text-xs" style={{ color: pageText }}>{config.service_account_json_name || 'Not configured'}</span></div>
                </div>
              </div>
            )}
          </section>
        );
      case 'inkitt':
        return (
          <section className={sectionClassName} style={{ background: panelBackground, borderColor: panelBorder }}>
            <SectionTitle title="Inkitt Cookies" description="Update login cookies for Inkitt chapter crawling." pageText={pageText} secondaryText={secondaryText} />
            <div className="grid grid-cols-1 gap-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div>
                  <label htmlFor="settings-inkitt-user-credentials" className={labelClassName}>`user_credentials` value</label>
                  <textarea id="settings-inkitt-user-credentials" value={inkittUserCredentials} onChange={(e) => { setInkittUserCredentials(e.target.value); setInkittCookieError(''); setInkittCookieMessage(''); }} rows={4} className={`${fieldClassName} min-h-[110px] resize-y font-mono text-xs`} style={{ background: inputBackground, borderColor: inputBorder }} />
                </div>
                <div>
                  <label htmlFor="settings-inkitt-cf-clearance" className={labelClassName}>`cf_clearance` value</label>
                  <textarea id="settings-inkitt-cf-clearance" value={inkittCfClearance} onChange={(e) => { setInkittCfClearance(e.target.value); setInkittCookieError(''); setInkittCookieMessage(''); }} rows={4} className={`${fieldClassName} min-h-[110px] resize-y font-mono text-xs`} style={{ background: inputBackground, borderColor: inputBorder }} />
                </div>
              </div>
              <div>
                <label htmlFor="settings-inkitt-ua" className={labelClassName}>Browser User-Agent (will be auto-extracted if you upload or paste JSON)</label>
                <textarea id="settings-inkitt-ua" value={inkittUserAgent} onChange={(e) => { setInkittUserAgent(e.target.value); setInkittCookieError(''); setInkittCookieMessage(''); }} rows={2} className={`${fieldClassName} resize-y font-mono text-xs`} placeholder={'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/... Safari/537.36'} style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={handleSaveInkittCookies} disabled={savingInkittCookies || !inkittUserCredentials.trim() || !inkittCfClearance.trim()} className="rounded-lg px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed" style={{ background: savingInkittCookies || !inkittUserCredentials.trim() || !inkittCfClearance.trim() ? subtleSurface : primaryButton, color: savingInkittCookies || !inkittUserCredentials.trim() || !inkittCfClearance.trim() ? tertiaryText : '#fff' }}>
                {savingInkittCookies ? 'Saving...' : 'Save Cookies'}
              </button>
              <button type="button" onClick={handleCheckInkittCookies} disabled={checkingInkittCookies} className="rounded-lg border px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed" style={{ borderColor: panelBorder, background: subtleSurface, color: pageText }}>
                {checkingInkittCookies ? 'Testing...' : 'Test Cookies'}
              </button>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium" style={{ borderColor: panelBorder, background: subtleSurface, color: pageText }}>
                <span>Upload Cookies JSON</span>
                <input type="file" accept="application/json" onChange={handleInkittJsonFileUpload} className="hidden" />
              </label>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <textarea value={inkittJsonText} onChange={(e) => setInkittJsonText(e.target.value)} rows={2} placeholder={'{\n  "user_credentials": "...",\n  "cf_clearance": "...",\n  "user_agent": "..."\n}'} className={`${fieldClassName} min-w-0 flex-1 resize-none font-mono text-xs`} style={{ background: inputBackground, borderColor: inputBorder }} />
              <button onClick={handleInkittJsonPaste} disabled={!inkittJsonText.trim()} className="rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-not-allowed" style={{ background: inkittJsonText.trim() ? primaryButton : subtleSurface, color: inkittJsonText.trim() ? '#fff' : tertiaryText }}>Apply</button>
            </div>
            <p className="text-xs" style={{ color: tertiaryText }}>Copy these from Chrome DevTools under Application → Cookies for `https://www.inkitt.com`.</p>
            {inkittCookieMessage && <div className="text-sm" style={{ color: isDark ? 'rgb(74 222 128)' : 'rgb(21 128 61)' }}>{inkittCookieMessage}</div>}
            {inkittCookieError && <div className="text-sm" style={{ color: isDark ? 'rgb(248 113 113)' : 'rgb(220 38 38)' }}>{inkittCookieError}</div>}
          </section>
        );
      case 'scribblehub':
        return (
          <section className={sectionClassName} style={{ background: panelBackground, borderColor: panelBorder }}>
            <SectionTitle title="ScribbleHub Cookies" description="ScribbleHub is behind a Cloudflare challenge. Paste a browser session cookie (cf_clearance) and its matching User-Agent so the crawler can read pages directly." pageText={pageText} secondaryText={secondaryText} />
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label htmlFor="settings-scribblehub-cookies" className={labelClassName}>Cookies — `cf_clearance=...`, a full Cookie header, or a JSON cookie array</label>
                <textarea id="settings-scribblehub-cookies" value={scribblehubCookies} onChange={(e) => { setScribblehubCookies(e.target.value); setScribblehubCookieError(''); setScribblehubCookieMessage(''); }} rows={4} className={`${fieldClassName} min-h-[110px] resize-y font-mono text-xs`} placeholder={'cf_clearance=AbCd...'} style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
              <div>
                <label htmlFor="settings-scribblehub-ua" className={labelClassName}>Browser User-Agent (run `navigator.userAgent` in the DevTools console)</label>
                <textarea id="settings-scribblehub-ua" value={scribblehubUserAgent} onChange={(e) => { setScribblehubUserAgent(e.target.value); setScribblehubCookieError(''); setScribblehubCookieMessage(''); }} rows={2} className={`${fieldClassName} resize-y font-mono text-xs`} placeholder={'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/... Safari/537.36'} style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={handleSaveScribblehubCookies} disabled={savingScribblehubCookies || !scribblehubCookies.trim() || !scribblehubUserAgent.trim()} className="rounded-lg px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed" style={{ background: savingScribblehubCookies || !scribblehubCookies.trim() || !scribblehubUserAgent.trim() ? subtleSurface : primaryButton, color: savingScribblehubCookies || !scribblehubCookies.trim() || !scribblehubUserAgent.trim() ? tertiaryText : '#fff' }}>
                {savingScribblehubCookies ? 'Saving...' : 'Save Cookies'}
              </button>
              <button type="button" onClick={handleCheckScribblehubCookies} disabled={checkingScribblehubCookies} className="rounded-lg border px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed" style={{ borderColor: panelBorder, background: subtleSurface, color: pageText }}>
                {checkingScribblehubCookies ? 'Testing...' : 'Test Cookies'}
              </button>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium" style={{ borderColor: panelBorder, background: subtleSurface, color: pageText }}>
                <span>Upload Cookies JSON</span>
                <input type="file" accept="application/json" onChange={handleScribblehubJsonFileUpload} className="hidden" />
              </label>
            </div>
            <p className="text-xs" style={{ color: tertiaryText }}>In Chrome at `https://www.scribblehub.com`: DevTools → Application → Cookies → copy `cf_clearance`. cf_clearance is tied to your IP + User-Agent, so the crawler must run on this machine and the User-Agent must match. It expires every ~30–60 min — re-paste when crawls start failing.</p>
            {scribblehubCookieMessage && <div className="text-sm" style={{ color: isDark ? 'rgb(74 222 128)' : 'rgb(21 128 61)' }}>{scribblehubCookieMessage}</div>}
            {scribblehubCookieError && <div className="text-sm" style={{ color: isDark ? 'rgb(248 113 113)' : 'rgb(220 38 38)' }}>{scribblehubCookieError}</div>}
          </section>
        );
      case 'novelhall':
        return (
          <section className={sectionClassName} style={{ background: panelBackground, borderColor: panelBorder }}>
            <SectionTitle title="NovelHall Cookies" description="NovelHall is behind a Cloudflare challenge. Paste a browser session cookie (cf_clearance) and its matching User-Agent so the crawler can read pages directly." pageText={pageText} secondaryText={secondaryText} />
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label htmlFor="settings-novelhall-cookies" className={labelClassName}>Cookies — `cf_clearance=...`, a full Cookie header, or a JSON cookie array</label>
                <textarea id="settings-novelhall-cookies" value={novelhallCookies} onChange={(e) => { setNovelhallCookies(e.target.value); setNovelhallCookieError(''); setNovelhallCookieMessage(''); }} rows={4} className={`${fieldClassName} min-h-[110px] resize-y font-mono text-xs`} placeholder={'cf_clearance=AbCd...'} style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
              <div>
                <label htmlFor="settings-novelhall-ua" className={labelClassName}>Browser User-Agent (run `navigator.userAgent` in the DevTools console)</label>
                <textarea id="settings-novelhall-ua" value={novelhallUserAgent} onChange={(e) => { setNovelhallUserAgent(e.target.value); setNovelhallCookieError(''); setNovelhallCookieMessage(''); }} rows={2} className={`${fieldClassName} resize-y font-mono text-xs`} placeholder={'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/... Safari/537.36'} style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={handleSaveNovelhallCookies} disabled={savingNovelhallCookies || !novelhallCookies.trim() || !novelhallUserAgent.trim()} className="rounded-lg px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed" style={{ background: savingNovelhallCookies || !novelhallCookies.trim() || !novelhallUserAgent.trim() ? subtleSurface : primaryButton, color: savingNovelhallCookies || !novelhallCookies.trim() || !novelhallUserAgent.trim() ? tertiaryText : '#fff' }}>
                {savingNovelhallCookies ? 'Saving...' : 'Save Cookies'}
              </button>
              <button type="button" onClick={handleCheckNovelhallCookies} disabled={checkingNovelhallCookies} className="rounded-lg border px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed" style={{ borderColor: panelBorder, background: subtleSurface, color: pageText }}>
                {checkingNovelhallCookies ? 'Testing...' : 'Test Cookies'}
              </button>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium" style={{ borderColor: panelBorder, background: subtleSurface, color: pageText }}>
                <span>Upload Cookies JSON</span>
                <input type="file" accept="application/json" onChange={handleNovelhallJsonFileUpload} className="hidden" />
              </label>
            </div>
            <p className="text-xs" style={{ color: tertiaryText }}>In Chrome at `https://www.novelhall.com`: DevTools → Application → Cookies → copy `cf_clearance`. cf_clearance is tied to your IP + User-Agent, so the crawler must run on this machine and the User-Agent must match. It expires every ~30–60 min — re-paste when crawls start failing.</p>
            {novelhallCookieMessage && <div className="text-sm" style={{ color: isDark ? 'rgb(74 222 128)' : 'rgb(21 128 61)' }}>{novelhallCookieMessage}</div>}
            {novelhallCookieError && <div className="text-sm" style={{ color: isDark ? 'rgb(248 113 113)' : 'rgb(220 38 38)' }}>{novelhallCookieError}</div>}
          </section>
        );
      case 'goodnovel':
        return (
          <section className={sectionClassName} style={{ background: panelBackground, borderColor: panelBorder }}>
            <SectionTitle title="GoodNovel Cookies" description="Log in to GoodNovel and paste your session cookies so the crawler can read every chapter your account can access for free (free chapters plus any you've unlocked with bonus/earned coins)." pageText={pageText} secondaryText={secondaryText} />
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label htmlFor="settings-goodnovel-cookies" className={labelClassName}>Cookies — a full Cookie header (`TOKEN=...; ...`) or a JSON cookie array</label>
                <textarea id="settings-goodnovel-cookies" value={goodnovelCookies} onChange={(e) => { setGoodnovelCookies(e.target.value); setGoodnovelCookieError(''); setGoodnovelCookieMessage(''); }} rows={4} className={`${fieldClassName} min-h-[110px] resize-y font-mono text-xs`} placeholder={'TOKEN=AbCd...; uid=...'} style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
              <div>
                <label htmlFor="settings-goodnovel-ua" className={labelClassName}>Browser User-Agent (optional — auto-extracted when you upload goodnovel.json)</label>
                <textarea id="settings-goodnovel-ua" value={goodnovelUserAgent} onChange={(e) => { setGoodnovelUserAgent(e.target.value); setGoodnovelCookieError(''); setGoodnovelCookieMessage(''); }} rows={2} className={`${fieldClassName} resize-y font-mono text-xs`} placeholder={'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/... Safari/537.36'} style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
              <div>
                <label htmlFor="settings-goodnovel-test-url" className={labelClassName}>Book URL to test against (optional — shows how many extra chapters the login unlocks)</label>
                <input id="settings-goodnovel-test-url" value={goodnovelTestUrl} onChange={(e) => { setGoodnovelTestUrl(e.target.value); setGoodnovelCookieError(''); setGoodnovelCookieMessage(''); }} className={`${fieldClassName} font-mono text-xs`} placeholder={'https://www.goodnovel.com/book/Title_31000725726'} style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={handleSaveGoodnovelCookies} disabled={savingGoodnovelCookies || !goodnovelCookies.trim()} className="rounded-lg px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed" style={{ background: savingGoodnovelCookies || !goodnovelCookies.trim() ? subtleSurface : primaryButton, color: savingGoodnovelCookies || !goodnovelCookies.trim() ? tertiaryText : '#fff' }}>
                {savingGoodnovelCookies ? 'Saving...' : 'Save Cookies'}
              </button>
              <button type="button" onClick={handleCheckGoodnovelCookies} disabled={checkingGoodnovelCookies} className="rounded-lg border px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed" style={{ borderColor: panelBorder, background: subtleSurface, color: pageText }}>
                {checkingGoodnovelCookies ? 'Testing...' : 'Test Cookies'}
              </button>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium" style={{ borderColor: panelBorder, background: subtleSurface, color: pageText }}>
                <span>Upload goodnovel.json</span>
                <input type="file" accept="application/json" onChange={handleGoodnovelJsonFileUpload} className="hidden" />
              </label>
            </div>
            <p className="text-xs" style={{ color: tertiaryText }}>Easiest way: run `miscellaneous/GoodNovel Cookies/update_goodnovel_cookies.bat`, log in to GoodNovel in the Chrome window it opens, and it writes `goodnovel.json` — then upload that file here. Or in Chrome at `https://www.goodnovel.com` (logged in): DevTools → Application → Cookies → copy the `TOKEN` cookie (or the whole Cookie header). Cookies expire — re-paste when the test shows the login no longer unlocks extra chapters.</p>
            {goodnovelCookieMessage && <div className="text-sm" style={{ color: isDark ? 'rgb(74 222 128)' : 'rgb(21 128 61)' }}>{goodnovelCookieMessage}</div>}
            {goodnovelCookieError && <div className="text-sm" style={{ color: isDark ? 'rgb(248 113 113)' : 'rgb(220 38 38)' }}>{goodnovelCookieError}</div>}
          </section>
        );
      case 'webnovel':
        return (
          <section className={sectionClassName} style={{ background: panelBackground, borderColor: panelBorder }}>
            <SectionTitle title="WebNovel Cookies" description="Paste WebNovel browser cookies and the matching User-Agent so the crawler can read pages that Cloudflare allows for that session." pageText={pageText} secondaryText={secondaryText} />
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label htmlFor="settings-webnovel-cookies" className={labelClassName}>Cookies - `cf_clearance=...`, a full Cookie header, or a JSON cookie array</label>
                <textarea id="settings-webnovel-cookies" value={webnovelCookies} onChange={(e) => { setWebnovelCookies(e.target.value); setWebnovelCookieError(''); setWebnovelCookieMessage(''); }} rows={4} className={`${fieldClassName} min-h-[110px] resize-y font-mono text-xs`} placeholder={'cf_clearance=AbCd...; uid=...'} style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
              <div>
                <label htmlFor="settings-webnovel-ua" className={labelClassName}>Browser User-Agent (run `navigator.userAgent` in the same browser session)</label>
                <textarea id="settings-webnovel-ua" value={webnovelUserAgent} onChange={(e) => { setWebnovelUserAgent(e.target.value); setWebnovelCookieError(''); setWebnovelCookieMessage(''); }} rows={2} className={`${fieldClassName} resize-y font-mono text-xs`} placeholder={'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/... Safari/537.36'} style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
              <div>
                <label htmlFor="settings-webnovel-test-url" className={labelClassName}>WebNovel URL to test against (optional)</label>
                <input id="settings-webnovel-test-url" value={webnovelTestUrl} onChange={(e) => { setWebnovelTestUrl(e.target.value); setWebnovelCookieError(''); setWebnovelCookieMessage(''); }} className={`${fieldClassName} font-mono text-xs`} placeholder={'https://www.webnovel.com/book/title_123/chapter-1_456'} style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={handleSaveWebnovelCookies} disabled={savingWebnovelCookies || !webnovelCookies.trim() || !webnovelUserAgent.trim()} className="rounded-lg px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed" style={{ background: savingWebnovelCookies || !webnovelCookies.trim() || !webnovelUserAgent.trim() ? subtleSurface : primaryButton, color: savingWebnovelCookies || !webnovelCookies.trim() || !webnovelUserAgent.trim() ? tertiaryText : '#fff' }}>
                {savingWebnovelCookies ? 'Saving...' : 'Save Cookies'}
              </button>
              <button type="button" onClick={handleCheckWebnovelCookies} disabled={checkingWebnovelCookies} className="rounded-lg border px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed" style={{ borderColor: panelBorder, background: subtleSurface, color: pageText }}>
                {checkingWebnovelCookies ? 'Testing...' : 'Test Cookies'}
              </button>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium" style={{ borderColor: panelBorder, background: subtleSurface, color: pageText }}>
                <span>Upload Cookies JSON</span>
                <input type="file" accept="application/json" onChange={handleWebnovelJsonFileUpload} className="hidden" />
              </label>
            </div>
            <p className="text-xs" style={{ color: tertiaryText }}>In Chrome at `https://www.webnovel.com`: DevTools - Application - Cookies - copy `cf_clearance` or the full Cookie header. Save the same browser's User-Agent. Locked chapters still require that your account can read them.</p>
            {webnovelCookieMessage && <div className="text-sm" style={{ color: isDark ? 'rgb(74 222 128)' : 'rgb(21 128 61)' }}>{webnovelCookieMessage}</div>}
            {webnovelCookieError && <div className="text-sm" style={{ color: isDark ? 'rgb(248 113 113)' : 'rgb(220 38 38)' }}>{webnovelCookieError}</div>}
          </section>
        );
      case 'jobnib':
        return (
          <section className={sectionClassName} style={{ background: panelBackground, borderColor: panelBorder }}>
            <SectionTitle title="Jobnib Session" description="Save the browser cookies and matching User-Agent used by Jobnib Batch and single-story crawling." pageText={pageText} secondaryText={secondaryText} />
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label htmlFor="settings-jobnib-cookies" className={labelClassName}>Raw Cookie header or Selenium JSON</label>
                <textarea id="settings-jobnib-cookies" value={jobnibCookies} onChange={(event) => { setJobnibCookies(event.target.value); setJobnibCookieError(''); setJobnibCookieMessage(''); }} rows={5} className={`${fieldClassName} min-h-[130px] resize-y font-mono text-xs`} placeholder={'cf_clearance=...; PHPSESSID=...\n\nor [{"name":"cf_clearance","value":"...","domain":".jobnib.com"}]'} style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
              <div>
                <label htmlFor="settings-jobnib-ua" className={labelClassName}>Matching browser User-Agent</label>
                <textarea id="settings-jobnib-ua" value={jobnibUserAgent} onChange={(event) => { setJobnibUserAgent(event.target.value); setJobnibCookieError(''); setJobnibCookieMessage(''); }} rows={2} className={`${fieldClassName} resize-y font-mono text-xs`} placeholder="Mozilla/5.0 ... Chrome/... Safari/537.36" style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
              <div>
                <label htmlFor="settings-jobnib-test-url" className={labelClassName}>Jobnib story or chapter URL to test (optional)</label>
                <input id="settings-jobnib-test-url" value={jobnibTestUrl} onChange={(event) => { setJobnibTestUrl(event.target.value); setJobnibCookieError(''); setJobnibCookieMessage(''); }} className={`${fieldClassName} font-mono text-xs`} placeholder="https://jobnib.com/book/story-name" style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={handleSaveJobnibCookies} disabled={savingJobnibCookies || !jobnibCookies.trim()} className="rounded-lg px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed" style={{ background: savingJobnibCookies || !jobnibCookies.trim() ? subtleSurface : primaryButton, color: savingJobnibCookies || !jobnibCookies.trim() ? tertiaryText : '#fff' }}>{savingJobnibCookies ? 'Saving...' : 'Save Session'}</button>
              <button type="button" onClick={handleCheckJobnibCookies} disabled={checkingJobnibCookies} className="rounded-lg border px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed" style={{ borderColor: panelBorder, background: subtleSurface, color: pageText }}>{checkingJobnibCookies ? 'Testing...' : 'Test Session'}</button>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium" style={{ borderColor: panelBorder, background: subtleSurface, color: pageText }}><span>Upload Selenium JSON</span><input type="file" accept="application/json" onChange={handleJobnibJsonFileUpload} className="hidden" /></label>
            </div>
            <p className="text-xs" style={{ color: tertiaryText }}>Jobnib has no login. On the production server PC, run the Jobnib cookie collector, open a chapter, complete any browser verification, and confirm both chapter parts unlock. Upload its JSON here; cookies are encrypted in the crawler database.</p>
            {jobnibCookieMessage && <div className="text-sm" style={{ color: isDark ? 'rgb(74 222 128)' : 'rgb(21 128 61)' }}>{jobnibCookieMessage}</div>}
            {jobnibCookieError && <div className="text-sm" style={{ color: isDark ? 'rgb(248 113 113)' : 'rgb(220 38 38)' }}>{jobnibCookieError}</div>}
          </section>
        );
      case 'crawler':
        return (
          <div className="space-y-4">
            <section className={sectionClassName} style={{ background: panelBackground, borderColor: panelBorder }}>
              <SectionTitle title="Default Crawl Settings" description="Applied automatically on the crawl page." pageText={pageText} secondaryText={secondaryText} />
              <div className="inline-flex items-center gap-1 rounded-md p-0.5" style={{ background: subtleSurface }}>
                <button onClick={() => setCrawlMode('count')} className="rounded-md px-3 py-1.5 text-sm font-medium" style={{ background: crawlMode === 'count' ? activeSurface : 'transparent', color: pageText }}>Count</button>
                <button onClick={() => setCrawlMode('range')} className="rounded-md px-3 py-1.5 text-sm font-medium" style={{ background: crawlMode === 'range' ? activeSurface : 'transparent', color: pageText }}>Range</button>
              </div>
              {crawlMode === 'count' ? (
                <div className="max-w-xs">
                  <label htmlFor="settings-default-chapter-count" className={labelClassName}>Default chapter count</label>
                  <input id="settings-default-chapter-count" type="number" min={1} max={100000} value={count} onChange={(e) => setCount(Math.max(1, Number.parseInt(e.target.value, 10) || 1))} className={fieldClassName} style={{ background: inputBackground, borderColor: inputBorder }} />
                </div>
              ) : (
                <div className="flex max-w-sm items-end gap-3">
                  <div className="flex-1">
                    <label htmlFor="settings-range-from" className={labelClassName}>From chapter</label>
                    <input id="settings-range-from" type="number" min={1} value={rangeFrom} onChange={(e) => setRangeFrom(Math.max(1, Number.parseInt(e.target.value, 10) || 1))} className={fieldClassName} style={{ background: inputBackground, borderColor: inputBorder }} />
                  </div>
                  <span className="pb-3 text-sm font-medium" style={{ color: tertiaryText }}>to</span>
                  <div className="flex-1">
                    <label htmlFor="settings-range-to" className={labelClassName}>To chapter</label>
                    <input id="settings-range-to" type="number" min={1} value={rangeTo} onChange={(e) => setRangeTo(Math.max(1, Number.parseInt(e.target.value, 10) || 1))} className={fieldClassName} style={{ background: inputBackground, borderColor: inputBorder }} />
                  </div>
                </div>
              )}
              <p className="text-sm" style={{ color: secondaryText }}>{crawlMode === 'count' ? `Default: crawl up to ${count} chapter${count === 1 ? '' : 's'}` : `Default: crawl chapters ${rangeFrom} to ${rangeTo} (${Math.max(0, rangeTo - rangeFrom + 1)} total)`}</p>
              {settings && (
                <p className="text-xs" style={{ color: tertiaryText }}>
                  Saved mode: {settings.crawl_mode === 'count' ? 'Count' : 'Range'}
                </p>
              )}
            </section>
            <section className={sectionClassName} style={{ background: panelBackground, borderColor: panelBorder }}>
              <SectionTitle title="Crawl Auto Settings" description="Auto-fill and range limits for crawl after URL detection." pageText={pageText} secondaryText={secondaryText} />
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium" style={{ color: pageText }}>Auto-fill full available chapters</p>
                  <p className="mt-0.5 text-xs" style={{ color: tertiaryText }}>Automatically fill the chapter count to the full number of available chapters after detecting a story URL.</p>
                </div>
                <button onClick={() => setCrawlAutoMaxChapters((value) => !value)} className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors" style={{ background: crawlAutoMaxChapters ? primaryButton : subtleSurfaceHover }}>
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${crawlAutoMaxChapters ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            </section>
          </div>
        );
      case 'audio':
        return (
          <div className="space-y-4">
            <section className={sectionClassName} style={{ background: panelBackground, borderColor: panelBorder }}>
              <SectionTitle title="Auto Audio Settings" description="Configure backoff and test story IDs." pageText={pageText} secondaryText={secondaryText} />
              <div className="max-w-xs">
                <label htmlFor="settings-audio-rest-seconds" className={labelClassName}>Backoff after failed story (seconds)</label>
                <input id="settings-audio-rest-seconds" type="number" min={0} max={600} value={autoAudioRestSeconds} onChange={(e) => setAutoAudioRestSeconds(Math.max(0, Number.parseInt(e.target.value, 10) || 0))} className={fieldClassName} style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
              <div className="max-w-lg">
                <label htmlFor="settings-audio-test-story-ids" className={labelClassName}>Test Story IDs</label>
                <textarea id="settings-audio-test-story-ids" value={autoAudioTestIdsText} onChange={(e) => { setAutoAudioTestIdsText(e.target.value); const ids = e.target.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean); setAutoAudioTestStoryIds(ids); }} rows={3} className={`${fieldClassName} resize-none font-mono text-sm`} style={{ background: inputBackground, borderColor: inputBorder }} />
              </div>
            </section>
          </div>
        );
      case 'danger':
        return (
          <section className={sectionClassName} style={{ background: panelBackground, borderColor: isDark ? 'rgba(248,113,113,0.25)' : 'rgba(220,38,38,0.18)' }}>
            <SectionTitle title="Development Cleanup" description="Clear runtime histories, outputs, sessions, jobs, logs, settings, Drive credentials, and saved tokens." pageText={pageText} secondaryText={secondaryText} />
            {isAdmin ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="max-w-md flex-1">
                  <label htmlFor="settings-clear-confirmation" className={labelClassName}>Confirmation</label>
                  <input id="settings-clear-confirmation" type="text" value={clearConfirm} onChange={(e) => setClearConfirm(e.target.value)} placeholder="CLEAR_BACKEND_DATA" className={`${fieldClassName} font-mono text-sm`} style={{ background: inputBackground, borderColor: inputBorder }} />
                </div>
                <button type="button" onClick={handleClearBackendData} disabled={clearState === 'clearing' || clearConfirm.trim() !== 'CLEAR_BACKEND_DATA'} className="rounded-lg px-5 py-3 text-sm font-semibold disabled:cursor-not-allowed" style={{ background: clearState === 'clearing' || clearConfirm.trim() !== 'CLEAR_BACKEND_DATA' ? subtleSurface : '#dc2626', color: clearState === 'clearing' || clearConfirm.trim() !== 'CLEAR_BACKEND_DATA' ? tertiaryText : '#fff' }}>
                  {clearState === 'clearing' ? 'Clearing...' : 'Clear Backend Data'}
                </button>
              </div>
            ) : (
              <div className="rounded-lg border px-4 py-3 text-sm" style={{ borderColor: panelBorder, background: subtleSurface, color: secondaryText }}>Admin access is required.</div>
            )}
          </section>
        );
      default:
        return null;
    }
  };

  return (
    <div className="hidden lg:block">
      <button
        type="button"
        aria-label="Close settings"
        className="fixed inset-0 z-[70]"
        style={{ background: isDark ? 'rgba(0,0,0,0.48)' : 'rgba(17,17,17,0.18)', backdropFilter: 'blur(10px)' }}
        onClick={handleClose}
      />
      <div className="fixed inset-0 z-[80] flex items-center justify-center p-2 sm:p-4 lg:p-6">
        <dialog
          open
          className="flex h-[min(88vh,820px)] w-full max-w-6xl overflow-hidden rounded-[24px] border shadow-2xl"
          style={{ background: shellBackground, borderColor: panelBorder, color: pageText, boxShadow: isDark ? '0 30px 90px rgba(0,0,0,0.58)' : '0 30px 90px rgba(17,17,17,0.18)', backdropFilter: 'blur(18px)' }}
        >
          <aside className="hidden w-[232px] shrink-0 border-r md:flex md:flex-col" style={{ borderColor: panelBorder, background: isDark ? 'rgba(20,20,19,0.78)' : 'rgba(247,246,243,0.86)' }}>
            <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
              {categories.map((category) => {
                const active = category.id === activeCategory;
                return (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => setActiveCategory(category.id)}
                    className="flex w-full items-center gap-2 rounded-full px-3 py-2 text-left transition-colors"
                    style={{ background: active ? (isDark ? '#f5f5f1' : '#111111') : 'transparent', color: active ? (isDark ? '#111111' : '#ffffff') : secondaryText }}
                  >
                    <Icon icon={appIcons[category.icon]} className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="text-sm font-medium">{category.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col" style={{ background: shellBackground }}>
            {/* Header */}
            <div className="flex items-center justify-between border-b px-4 py-3 md:px-5" style={{ borderColor: panelBorder }}>
              <p className="text-sm font-semibold md:text-base" style={{ color: pageText }}>{categories.find((item) => item.id === activeCategory)?.label}</p>
              <button onClick={handleClose} className="cs-icon-button">
                <Icon icon={appIcons.close} className="h-4 w-4" />
              </button>
            </div>

            {/* Mobile: horizontal scrollable category tabs */}
            <div className="flex md:hidden border-b overflow-x-auto" style={{ borderColor: panelBorder, scrollbarWidth: 'none' }}>
              <div className="flex">
                {categories.map((category) => {
                  const active = category.id === activeCategory;
                  return (
                    <button
                      key={category.id}
                      type="button"
                      onClick={() => setActiveCategory(category.id)}
                      className="flex items-center gap-1.5 whitespace-nowrap border-b-2 px-4 py-2.5 text-xs font-medium transition-colors"
                      style={{
                        borderColor: active ? primaryButton : 'transparent',
                        color: active ? primaryButton : secondaryText,
                      }}
                    >
                      <Icon icon={appIcons[category.icon]} className="h-3.5 w-3.5 flex-shrink-0" />
                      {category.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {error && (
              <div className="mx-4 mt-4 rounded-lg border px-4 py-3 text-sm transition-opacity duration-300 md:mx-5" style={{ opacity: errorBannerVisible ? 1 : 0, borderColor: isDark ? 'rgba(248,113,113,0.28)' : 'rgba(220,38,38,0.2)', background: isDark ? 'rgba(127,29,29,0.18)' : 'rgba(254,242,242,0.95)', color: isDark ? 'rgb(252 165 165)' : 'rgb(185 28 28)' }}>
                {error}
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5">
              <div className="mx-auto w-full max-w-5xl">
                {renderContent()}
              </div>
            </div>

            <div className="flex items-center justify-between border-t px-4 py-3 md:px-5" style={{ borderColor: panelBorder, background: isDark ? 'rgba(20,20,19,0.78)' : 'rgba(250,250,250,0.86)' }}>
              <p className="text-xs" style={{ color: tertiaryText }}>Changes apply to this workspace after saving.</p>
              <button onClick={handleSave} disabled={saveState === 'saving' || saveState === 'saved'} className="rounded-full px-5 py-2 text-sm font-semibold transition-colors" style={{ background: saveState === 'saving' || saveState === 'saved' ? (saveState === 'saved' ? '#16a34a' : subtleSurface) : primaryButton, color: saveState === 'saving' || saveState === 'saved' ? (saveState === 'saved' ? '#fff' : tertiaryText) : '#fff' }}>
                {saveState === 'saving' ? 'Saving...' : saveState === 'saved' ? 'Saved' : 'Save Settings'}
              </button>
            </div>
          </div>
        </dialog>
      </div>
    </div>
  );
}

export default SettingsPage;
