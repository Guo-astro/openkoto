import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent } from "../ui/dialog";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { Input } from "../ui/input";
import { useTheme } from "../theme-provider";
import { AppConfig, ModelConfig } from "../../lib/tauri";
import { invoke } from "@tauri-apps/api/core";
import {
    Palette,
    Sparkles,
    CheckCircle2,
    Cpu,
    Zap,
    Star,
    HelpCircle,
    MonitorSmartphone,
    Server,
    RefreshCw,
    HardDrive,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip.tsx";
import { KIMI_CHINA_PROVIDER } from "../../lib/kimiProvider";

interface OnboardingDialogProps {
    isOpen: boolean;
    onFinish: () => void;
}

type SetupMode = "global" | "china" | "local";
type LocalProvider = "ollama" | "lmstudio";

const DEFAULT_LOCAL_BASE_URLS: Record<LocalProvider, string> = {
    ollama: "http://localhost:11434/v1",
    lmstudio: "http://localhost:1234/v1",
};

interface SyncedModelOption {
    value: string;
    label: string;
}

export function OnboardingDialog({ isOpen, onFinish }: OnboardingDialogProps) {
    const { t, i18n } = useTranslation();
    const { themeName, themeMode, setThemeName, setThemeMode } = useTheme();
    const [step, setStep] = useState(1);
    const [targetLanguage, setTargetLanguage] = useState("zh-CN");
    const [apiKey, setApiKey] = useState("");
    const [cloudModel, setCloudModel] = useState("models/gemini-3-flash-preview");
    const [isFinishing, setIsFinishing] = useState(false);
    const [setupMode, setSetupMode] = useState<SetupMode>("global");
    const [chinaProvider, setChinaProvider] = useState<"302ai" | typeof KIMI_CHINA_PROVIDER>("302ai");
    const [localProvider, setLocalProvider] = useState<LocalProvider>("ollama");
    const [localBaseUrl, setLocalBaseUrl] = useState(DEFAULT_LOCAL_BASE_URLS.ollama);
    const [localPresetModel, setLocalPresetModel] = useState("");
    const [localModelInput, setLocalModelInput] = useState("");
    const [useCustomLocalModel, setUseCustomLocalModel] = useState(false);
    const [syncedLocalModels, setSyncedLocalModels] = useState<SyncedModelOption[]>([]);
    const [isSyncingLocalModels, setIsSyncingLocalModels] = useState(false);
    const [localSyncError, setLocalSyncError] = useState<string | null>(null);

    const INTERFACE_LANGUAGES = [
        { value: "en", label: "English" },
        { value: "zh", label: "中文 (简体)" },
        { value: "ja", label: "日本語" },
    ];

    const TARGET_LANGUAGES = [
        { value: "en", label: t("settings.languages.en") },
        { value: "zh-CN", label: t("settings.languages.zh-CN") },
        { value: "zh-TW", label: t("settings.languages.zh-TW") },
        { value: "ja", label: t("settings.languages.ja") },
        { value: "ko", label: t("settings.languages.ko") },
        { value: "es", label: t("settings.languages.es") },
        { value: "fr", label: t("settings.languages.fr") },
        { value: "de", label: t("settings.languages.de") },
        { value: "ru", label: t("settings.languages.ru") },
        { value: "ar", label: t("settings.languages.ar") },
    ];

    const isLocalMode = setupMode === "local";
    const isOllama = localProvider === "ollama";
    const localConfiguredModel = localProvider === "lmstudio"
        ? localModelInput.trim()
        : useCustomLocalModel
            ? localModelInput.trim()
            : localPresetModel.trim();
    const canSaveSelectedModel = isLocalMode ? !!localConfiguredModel : !!apiKey.trim();

    const handleLanguageChange = async (lng: string) => {
        await i18n.changeLanguage(lng);
    };

    const handleSetupModeChange = (mode: SetupMode) => {
        setSetupMode(mode);

        if (mode === "global") {
            setCloudModel("models/gemini-3-flash-preview");
            return;
        }

        if (mode === "china") {
            setChinaProvider("302ai");
            setCloudModel("gemini-3-flash-preview");
            return;
        }

        setLocalProvider("ollama");
        setLocalBaseUrl(DEFAULT_LOCAL_BASE_URLS.ollama);
        setUseCustomLocalModel(false);
    };

    const handleLocalProviderChange = (provider: LocalProvider) => {
        setLocalProvider(provider);
        setLocalBaseUrl(DEFAULT_LOCAL_BASE_URLS[provider]);
        setLocalSyncError(null);

        if (provider === "ollama") {
            setUseCustomLocalModel(false);
            return;
        }

        setUseCustomLocalModel(true);
        setLocalPresetModel("");
    };

    const syncOllamaModels = async () => {
        const configuredBaseUrl = localBaseUrl.trim() || DEFAULT_LOCAL_BASE_URLS.ollama;
        const trimmedBaseUrl = configuredBaseUrl.replace(/\/$/, "");
        const ollamaHost = trimmedBaseUrl.endsWith("/v1") ? trimmedBaseUrl.slice(0, -3) : trimmedBaseUrl;

        setIsSyncingLocalModels(true);
        setLocalSyncError(null);

        try {
            const response = await fetch(`${ollamaHost}/api/tags`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            const nextModels = Array.isArray(data.models)
                ? data.models
                    .map((model: { name?: string }) => model.name)
                    .filter((name: string | undefined): name is string => !!name)
                    .map((name: string) => ({ value: name, label: name }))
                : [];

            setSyncedLocalModels(nextModels);

            if (nextModels.length > 0) {
                setLocalPresetModel((current) => current || nextModels[0].value);
                setUseCustomLocalModel(false);
            } else {
                setLocalSyncError(t("onboarding.model.localNoModels"));
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLocalSyncError(`${t("onboarding.model.localSyncFailed")}: ${message}`);
        } finally {
            setIsSyncingLocalModels(false);
        }
    };

    useEffect(() => {
        if (isOpen && step === 2 && setupMode === "local" && localProvider === "ollama" && syncedLocalModels.length === 0) {
            void syncOllamaModels();
        }
    }, [isOpen, step, setupMode, localProvider, syncedLocalModels.length]);

    const handleFinish = async () => {
        setIsFinishing(true);
        try {
            const initialConfig: AppConfig = {
                onboarding_completed: true,
                model_configs: [],
                target_language: targetLanguage,
                interface_language: i18n.language,
            };

            await invoke("save_config_cmd", { config: initialConfig });

            if (canSaveSelectedModel) {
                let apiProvider: string;
                let modelId: string;
                let configName: string;
                let baseUrl: string | undefined;

                if (setupMode === "global") {
                    apiProvider = "google-ai-studio";
                    modelId = cloudModel;
                    configName = "Gemini";
                } else if (setupMode === "china") {
                    apiProvider = chinaProvider;
                    modelId = cloudModel;
                    configName = chinaProvider === "302ai" ? "302.AI" : "Kimi";
                } else {
                    apiProvider = localProvider;
                    modelId = localConfiguredModel;
                    configName = localProvider === "ollama" ? "Ollama" : "LM Studio";
                    baseUrl = localBaseUrl.trim() || DEFAULT_LOCAL_BASE_URLS[localProvider];
                }

                const modelConfig: ModelConfig = {
                    id: crypto.randomUUID(),
                    name: configName,
                    api_key: setupMode === "local" ? "" : apiKey.trim(),
                    api_provider: apiProvider,
                    model: modelId,
                    is_default: true,
                    base_url: baseUrl,
                };

                await invoke("save_model_config", { config: modelConfig });
                await invoke("set_active_model_config", { configId: modelConfig.id });
            }

            onFinish();
        } catch (error) {
            console.error("Failed to save onboarding config:", error);
        } finally {
            setIsFinishing(false);
        }
    };

    return (
        <Dialog isOpen={isOpen} onClose={() => { }}>
            <DialogContent className="max-w-lg p-0 overflow-hidden bg-card border-none shadow-2xl">
                <div className="h-2 bg-gradient-to-r from-primary via-purple-500 to-blue-500" />

                <div className="p-8">
                    <div className="flex justify-center gap-2 mb-8">
                        {[1, 2, 3].map((s) => (
                            <div
                                key={s}
                                className={`h-1.5 w-12 rounded-full transition-all duration-300 ${step >= s ? "bg-primary" : "bg-muted"}`}
                            />
                        ))}
                    </div>

                    {step === 1 && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                            <div className="text-center space-y-2">
                                <div className="inline-flex p-3 rounded-2xl bg-primary/10 text-primary mb-2">
                                    <Palette size={28} />
                                </div>
                                <h2 className="text-2xl font-bold tracking-tight">{t("onboarding.style.title")}</h2>
                                <p className="text-muted-foreground text-sm">{t("onboarding.style.desc")}</p>
                            </div>

                            <div className="space-y-4">
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-2">
                                        <label className="text-xs font-semibold uppercase text-muted-foreground">{t("settings.interfaceLanguage")}</label>
                                        <Select
                                            value={i18n.language}
                                            onChange={(e) => handleLanguageChange(e.target.value)}
                                            className="h-9 text-sm"
                                        >
                                            {INTERFACE_LANGUAGES.map((lang) => (
                                                <option key={lang.value} value={lang.value}>
                                                    {lang.label}
                                                </option>
                                            ))}
                                        </Select>
                                    </div>
                                    <div className="space-y-2">
                                        <div className="flex items-center gap-1.5">
                                            <label className="text-xs font-semibold uppercase text-muted-foreground">{t("settings.targetLanguage")}</label>
                                            <TooltipProvider>
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <HelpCircle size={12} className="text-muted-foreground hover:text-primary cursor-help" />
                                                    </TooltipTrigger>
                                                    <TooltipContent>
                                                        <p className="w-60 text-xs">{t("onboarding.style.targetLangTooltip")}</p>
                                                    </TooltipContent>
                                                </Tooltip>
                                            </TooltipProvider>
                                        </div>
                                        <Select
                                            value={targetLanguage}
                                            onChange={(e) => setTargetLanguage(e.target.value)}
                                            className="h-9 text-sm"
                                        >
                                            {TARGET_LANGUAGES.map((lang) => (
                                                <option key={lang.value} value={lang.value}>
                                                    {lang.label}
                                                </option>
                                            ))}
                                        </Select>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-xs font-semibold uppercase text-muted-foreground">{t("settings.theme.themeName")}</label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {["seoul", "tokyo", "california"].map((name) => (
                                            <Button
                                                key={name}
                                                variant={themeName === name ? "default" : "outline"}
                                                onClick={() => setThemeName(name as "seoul" | "tokyo" | "california")}
                                                size="sm"
                                                className="text-xs capitalize h-8"
                                            >
                                                {t(`settings.theme.${name}`)}
                                            </Button>
                                        ))}
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-xs font-semibold uppercase text-muted-foreground">{t("settings.theme.themeMode")}</label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {["light", "dark", "system"].map((mode) => (
                                            <Button
                                                key={mode}
                                                variant={themeMode === mode ? "default" : "outline"}
                                                onClick={() => setThemeMode(mode as "light" | "dark" | "system")}
                                                size="sm"
                                                className="text-xs h-8"
                                            >
                                                {t(`settings.theme.${mode}`)}
                                            </Button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {step === 2 && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-500">
                            <div className="text-center space-y-2">
                                <div className="inline-flex p-3 rounded-2xl bg-primary/10 text-primary mb-2">
                                    <Cpu size={28} />
                                </div>
                                <h2 className="text-2xl font-bold tracking-tight">{t("onboarding.model.title")}</h2>
                                <p className="text-muted-foreground text-sm">{t("onboarding.model.desc")}</p>
                            </div>

                            <div className="space-y-4">
                                <div className="space-y-3">
                                    <label className="text-xs font-semibold uppercase text-muted-foreground">{t("onboarding.model.regionTitle")}</label>
                                    <div className="grid gap-2 sm:grid-cols-3">
                                        <button
                                            onClick={() => handleSetupModeChange("global")}
                                            className={`flex items-center gap-2 p-3 rounded-xl border-2 transition-all ${setupMode === "global"
                                                ? "border-primary bg-primary/5 shadow-md ring-2 ring-primary/20"
                                                : "border-border hover:border-primary/50"}`}
                                        >
                                            <div className={`p-1.5 rounded-lg ${setupMode === "global" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                                                🌍
                                            </div>
                                            <div className="text-left">
                                                <div className="text-xs font-bold">{t("onboarding.model.globalUser")}</div>
                                                <div className="text-[10px] text-muted-foreground">Google AI Studio</div>
                                            </div>
                                        </button>

                                        <button
                                            onClick={() => handleSetupModeChange("china")}
                                            className={`flex items-center gap-2 p-3 rounded-xl border-2 transition-all ${setupMode === "china"
                                                ? "border-primary bg-primary/5 shadow-md ring-2 ring-primary/20"
                                                : "border-border hover:border-primary/50"}`}
                                        >
                                            <div className={`p-1.5 rounded-lg ${setupMode === "china" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                                                🇨🇳
                                            </div>
                                            <div className="text-left">
                                                <div className="text-xs font-bold">{t("onboarding.model.chinaUser")}</div>
                                                <div className="text-[10px] text-muted-foreground">302.AI / Kimi</div>
                                            </div>
                                        </button>

                                        <button
                                            onClick={() => handleSetupModeChange("local")}
                                            className={`flex items-center gap-2 p-3 rounded-xl border-2 transition-all ${setupMode === "local"
                                                ? "border-primary bg-primary/5 shadow-md ring-2 ring-primary/20"
                                                : "border-border hover:border-primary/50"}`}
                                        >
                                            <div className={`p-1.5 rounded-lg ${setupMode === "local" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                                                <MonitorSmartphone size={16} />
                                            </div>
                                            <div className="text-left">
                                                <div className="text-xs font-bold">{t("onboarding.model.localUser")}</div>
                                                <div className="text-[10px] text-muted-foreground">{t("onboarding.model.localDesc")}</div>
                                            </div>
                                        </button>
                                    </div>
                                </div>

                                {setupMode === "global" && (
                                    <div className="space-y-3">
                                        <label className="text-xs font-semibold uppercase text-muted-foreground">{t("onboarding.model.recommendTitle")}</label>
                                        <div className="space-y-2">
                                            <button
                                                onClick={() => setCloudModel("models/gemini-3-flash-preview")}
                                                className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all ${cloudModel === "models/gemini-3-flash-preview"
                                                    ? "border-primary bg-primary/5 shadow-md ring-2 ring-primary/20"
                                                    : "border-border hover:border-primary/50"}`}
                                            >
                                                <div className={`p-2 rounded-lg ${cloudModel === "models/gemini-3-flash-preview" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                                                    <Zap size={18} />
                                                </div>
                                                <div className="text-left">
                                                    <div className="text-sm font-bold flex items-center gap-1.5">
                                                        Gemini 3.0 Flash
                                                        {cloudModel === "models/gemini-3-flash-preview" && <Star size={12} className="fill-current text-yellow-500" />}
                                                    </div>
                                                    <div className="text-[11px] text-muted-foreground leading-tight">{t("onboarding.model.recommendFlash")}</div>
                                                </div>
                                            </button>

                                            <button
                                                onClick={() => setCloudModel("models/gemini-3-pro-preview")}
                                                className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all ${cloudModel === "models/gemini-3-pro-preview"
                                                    ? "border-primary bg-primary/5 shadow-md ring-2 ring-primary/20"
                                                    : "border-border hover:border-primary/50"}`}
                                            >
                                                <div className={`p-2 rounded-lg ${cloudModel === "models/gemini-3-pro-preview" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                                                    <Cpu size={18} />
                                                </div>
                                                <div className="text-left">
                                                    <div className="text-sm font-bold">Gemini 3.0 Pro</div>
                                                    <div className="text-[11px] text-muted-foreground leading-tight">{t("onboarding.model.recommendPro")}</div>
                                                </div>
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {setupMode === "china" && (
                                    <div className="space-y-3">
                                        <label className="text-xs font-semibold uppercase text-muted-foreground">{t("onboarding.model.chinaProviderTitle")}</label>
                                        <div className="grid grid-cols-2 gap-2">
                                            <button
                                                onClick={() => {
                                                    setChinaProvider("302ai");
                                                    setCloudModel("gemini-3-flash-preview");
                                                }}
                                                className={`flex items-center gap-2 p-3 rounded-xl border-2 transition-all ${chinaProvider === "302ai"
                                                    ? "border-primary bg-primary/5 shadow-md ring-2 ring-primary/20"
                                                    : "border-border hover:border-primary/50"}`}
                                            >
                                                <div className={`p-1.5 rounded-lg ${chinaProvider === "302ai" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                                                    <Zap size={16} />
                                                </div>
                                                <div className="text-left">
                                                    <div className="text-xs font-bold">302.AI</div>
                                                    <div className="text-[10px] text-muted-foreground">{t("onboarding.model.302aiDesc")}</div>
                                                </div>
                                            </button>

                                            <button
                                                onClick={() => {
                                                    setChinaProvider(KIMI_CHINA_PROVIDER);
                                                    setCloudModel("kimi-k2.6");
                                                }}
                                                className={`flex items-center gap-2 p-3 rounded-xl border-2 transition-all ${chinaProvider === KIMI_CHINA_PROVIDER
                                                    ? "border-primary bg-primary/5 shadow-md ring-2 ring-primary/20"
                                                    : "border-border hover:border-primary/50"}`}
                                            >
                                                <div className={`p-1.5 rounded-lg ${chinaProvider === KIMI_CHINA_PROVIDER ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                                                    <Sparkles size={16} />
                                                </div>
                                                <div className="text-left">
                                                    <div className="text-xs font-bold">Kimi</div>
                                                    <div className="text-[10px] text-muted-foreground">{t("onboarding.model.kimiDesc")}</div>
                                                </div>
                                            </button>
                                        </div>

                                        {chinaProvider === "302ai" && (
                                            <div className="space-y-2">
                                                <button
                                                    onClick={() => setCloudModel("gemini-3-flash-preview")}
                                                    className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all ${cloudModel === "gemini-3-flash-preview"
                                                        ? "border-primary bg-primary/5 shadow-md ring-2 ring-primary/20"
                                                        : "border-border hover:border-primary/50"}`}
                                                >
                                                    <div className={`p-2 rounded-lg ${cloudModel === "gemini-3-flash-preview" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                                                        <Zap size={18} />
                                                    </div>
                                                    <div className="text-left">
                                                        <div className="text-sm font-bold flex items-center gap-1.5">
                                                            Gemini 3.0 Flash
                                                            {cloudModel === "gemini-3-flash-preview" && <Star size={12} className="fill-current text-yellow-500" />}
                                                        </div>
                                                        <div className="text-[11px] text-muted-foreground leading-tight">{t("onboarding.model.302ai.flash")}</div>
                                                    </div>
                                                </button>

                                                <button
                                                    onClick={() => setCloudModel("gemini-3-pro-preview")}
                                                    className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all ${cloudModel === "gemini-3-pro-preview"
                                                        ? "border-primary bg-primary/5 shadow-md ring-2 ring-primary/20"
                                                        : "border-border hover:border-primary/50"}`}
                                                >
                                                    <div className={`p-2 rounded-lg ${cloudModel === "gemini-3-pro-preview" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                                                        <Cpu size={18} />
                                                    </div>
                                                    <div className="text-left">
                                                        <div className="text-sm font-bold">Gemini 3.0 Pro</div>
                                                        <div className="text-[11px] text-muted-foreground leading-tight">{t("onboarding.model.302ai.pro")}</div>
                                                    </div>
                                                </button>
                                            </div>
                                        )}

                                        {chinaProvider === KIMI_CHINA_PROVIDER && (
                                            <div className="space-y-2">
                                                <button
                                                    onClick={() => setCloudModel("kimi-k2.6")}
                                                    className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all ${cloudModel === "kimi-k2.6"
                                                        ? "border-primary bg-primary/5 shadow-md ring-2 ring-primary/20"
                                                        : "border-border hover:border-primary/50"}`}
                                                >
                                                    <div className={`p-2 rounded-lg ${cloudModel === "kimi-k2.6" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                                                        <Sparkles size={18} />
                                                    </div>
                                                    <div className="text-left">
                                                        <div className="text-sm font-bold flex items-center gap-1.5">
                                                            Kimi K2.6
                                                            {cloudModel === "kimi-k2.6" && <Star size={12} className="fill-current text-yellow-500" />}
                                                        </div>
                                                        <div className="text-[11px] text-muted-foreground leading-tight">{t("onboarding.model.kimi.k26")}</div>
                                                    </div>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {setupMode === "local" && (
                                    <div className="space-y-4">
                                        <div className="rounded-2xl border border-primary/15 bg-gradient-to-br from-primary/5 via-background to-primary/10 p-4">
                                            <div className="flex items-start gap-3">
                                                <div className="rounded-xl bg-primary/10 p-2 text-primary">
                                                    <HardDrive size={18} />
                                                </div>
                                                <div className="space-y-1">
                                                    <div className="text-sm font-semibold text-foreground">{t("onboarding.model.localIntroTitle")}</div>
                                                    <p className="text-xs leading-relaxed text-muted-foreground">
                                                        {t("onboarding.model.localIntro")}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="space-y-3">
                                            <label className="text-xs font-semibold uppercase text-muted-foreground">{t("onboarding.model.localProviderTitle")}</label>
                                            <div className="grid grid-cols-2 gap-2">
                                                <button
                                                    onClick={() => handleLocalProviderChange("ollama")}
                                                    className={`flex items-center gap-2 p-3 rounded-xl border-2 transition-all ${localProvider === "ollama"
                                                        ? "border-primary bg-primary/5 shadow-md ring-2 ring-primary/20"
                                                        : "border-border hover:border-primary/50"}`}
                                                >
                                                    <div className={`p-1.5 rounded-lg ${localProvider === "ollama" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                                                        <Server size={16} />
                                                    </div>
                                                    <div className="text-left">
                                                        <div className="text-xs font-bold">Ollama</div>
                                                        <div className="text-[10px] text-muted-foreground">{t("onboarding.model.ollamaDesc")}</div>
                                                    </div>
                                                </button>

                                                <button
                                                    onClick={() => handleLocalProviderChange("lmstudio")}
                                                    className={`flex items-center gap-2 p-3 rounded-xl border-2 transition-all ${localProvider === "lmstudio"
                                                        ? "border-primary bg-primary/5 shadow-md ring-2 ring-primary/20"
                                                        : "border-border hover:border-primary/50"}`}
                                                >
                                                    <div className={`p-1.5 rounded-lg ${localProvider === "lmstudio" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                                                        <MonitorSmartphone size={16} />
                                                    </div>
                                                    <div className="text-left">
                                                        <div className="text-xs font-bold">LM Studio</div>
                                                        <div className="text-[10px] text-muted-foreground">{t("onboarding.model.lmstudioDesc")}</div>
                                                    </div>
                                                </button>
                                            </div>
                                        </div>

                                        <div className="space-y-2">
                                            <label className="text-xs font-semibold uppercase text-muted-foreground">{t("onboarding.model.localBaseUrlLabel")}</label>
                                            <Input
                                                type="text"
                                                value={localBaseUrl}
                                                onChange={(e) => setLocalBaseUrl(e.target.value)}
                                                placeholder={t("onboarding.model.localBaseUrlPlaceholder")}
                                                className="h-10 text-sm font-mono"
                                            />
                                        </div>

                                        {isOllama ? (
                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between gap-2">
                                                    <label className="text-xs font-semibold uppercase text-muted-foreground">{t("onboarding.model.localModelLabel")}</label>
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => syncOllamaModels()}
                                                        disabled={isSyncingLocalModels}
                                                        className="h-6 px-2 text-xs"
                                                    >
                                                        <RefreshCw size={12} className={isSyncingLocalModels ? "animate-spin" : ""} />
                                                        {isSyncingLocalModels ? t("onboarding.model.syncingLocalModels") : t("onboarding.model.syncLocalModels")}
                                                    </Button>
                                                </div>

                                                {!useCustomLocalModel ? (
                                                    <Select
                                                        value={localPresetModel || ""}
                                                        onChange={(e) => {
                                                            if (e.target.value === "__custom__") {
                                                                setUseCustomLocalModel(true);
                                                            } else {
                                                                setLocalPresetModel(e.target.value);
                                                            }
                                                        }}
                                                    >
                                                        {syncedLocalModels.map((model) => (
                                                            <option key={model.value} value={model.value}>
                                                                {model.label}
                                                            </option>
                                                        ))}
                                                        <option value="__custom__">{t("onboarding.model.localCustomModel")}</option>
                                                    </Select>
                                                ) : (
                                                    <div className="space-y-2">
                                                        <Input
                                                            type="text"
                                                            value={localModelInput}
                                                            onChange={(e) => setLocalModelInput(e.target.value)}
                                                            placeholder={t("onboarding.model.localModelPlaceholder")}
                                                            className="h-10 text-sm"
                                                        />
                                                        {syncedLocalModels.length > 0 && (
                                                            <Button
                                                                type="button"
                                                                variant="ghost"
                                                                size="sm"
                                                                onClick={() => setUseCustomLocalModel(false)}
                                                                className="h-6 px-2 text-xs"
                                                            >
                                                                {t("onboarding.model.useDetectedModel")}
                                                            </Button>
                                                        )}
                                                    </div>
                                                )}

                                                <p className="text-[11px] text-muted-foreground">{t("onboarding.model.ollamaHint")}</p>
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                <label className="text-xs font-semibold uppercase text-muted-foreground">{t("onboarding.model.localModelLabel")}</label>
                                                <Input
                                                    type="text"
                                                    value={localModelInput}
                                                    onChange={(e) => setLocalModelInput(e.target.value)}
                                                    placeholder={t("onboarding.model.localModelPlaceholder")}
                                                    className="h-10 text-sm"
                                                />
                                                <p className="text-[11px] text-muted-foreground">{t("onboarding.model.lmstudioHint")}</p>
                                            </div>
                                        )}

                                        {localSyncError && (
                                            <p className="text-[11px] text-yellow-600 dark:text-yellow-400">
                                                {localSyncError}
                                            </p>
                                        )}
                                    </div>
                                )}

                                {!isLocalMode && (
                                    <div className="space-y-2">
                                        <label className="text-xs font-semibold uppercase text-muted-foreground">
                                            {t("onboarding.model.apiKeyLabel")} ({setupMode === "global" ? "Google AI Studio" : chinaProvider === "302ai" ? "302.AI" : "Kimi"})
                                        </label>
                                        <Input
                                            type="password"
                                            value={apiKey}
                                            onChange={(e) => setApiKey(e.target.value)}
                                            placeholder={t("onboarding.model.apiKeyPlaceholder")}
                                            className="h-10 text-sm font-mono"
                                        />
                                        <div className="flex flex-col gap-1">
                                            <p className="text-[10px] text-muted-foreground italic flex items-center gap-1">
                                                <Sparkles size={10} className="text-primary" />
                                                {t("onboarding.model.tip")}
                                            </p>
                                            <a
                                                href="https://openkoto.com/docs"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-[10px] text-primary/80 hover:text-primary underline decoration-dotted transition-colors self-start"
                                            >
                                                {t("onboarding.model.helpLink")}
                                            </a>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {step === 3 && (
                        <div className="space-y-6 text-center animate-in zoom-in-95 duration-500">
                            <div className="flex justify-center">
                                <div className="relative">
                                    <div className="absolute inset-0 animate-ping rounded-full bg-primary/20" />
                                    <div className="relative bg-primary/10 text-primary p-5 rounded-full">
                                        <Sparkles size={48} className="animate-pulse" />
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <h2 className="text-3xl font-extrabold tracking-tight text-primary">
                                    {t("onboarding.welcome.title")}
                                </h2>
                                <p className="text-lg font-medium text-foreground">
                                    {t("onboarding.welcome.celebration")}
                                </p>
                                <p className="text-muted-foreground max-w-xs mx-auto text-sm">
                                    {t("onboarding.welcome.desc")}
                                </p>
                            </div>

                            <div className="pt-4 flex justify-center">
                                <div className="flex items-center gap-2 text-green-500 bg-green-500/10 px-4 py-2 rounded-full text-xs font-semibold">
                                    <CheckCircle2 size={14} />
                                    {t("onboarding.welcome.ready")}
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="mt-10 flex gap-3">
                        {step === 1 && (
                            <Button onClick={() => setStep(2)} className="flex-1 shadow-lg shadow-primary/10">
                                {t("onboarding.next")}
                            </Button>
                        )}
                        {step === 2 && (
                            <>
                                <Button
                                    variant="ghost"
                                    onClick={() => setStep(1)}
                                    disabled={isFinishing}
                                    className="flex-1"
                                >
                                    {t("onboarding.back")}
                                </Button>
                                <Button
                                    onClick={() => setStep(3)}
                                    variant={canSaveSelectedModel ? "default" : "outline"}
                                    className="flex-1 shadow-lg shadow-primary/5"
                                >
                                    {canSaveSelectedModel ? t("onboarding.next") : t("onboarding.model.skipButton")}
                                </Button>
                            </>
                        )}
                        {step === 3 && (
                            <>
                                <Button
                                    variant="ghost"
                                    onClick={() => setStep(2)}
                                    disabled={isFinishing}
                                    className="flex-1"
                                >
                                    {t("onboarding.back")}
                                </Button>
                                <Button
                                    onClick={handleFinish}
                                    disabled={isFinishing}
                                    className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground shadow-xl shadow-primary/25 font-bold"
                                >
                                    {isFinishing ? (
                                        <div className="flex items-center justify-center gap-2 text-sm">
                                            <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-primary-foreground" />
                                            {t("settings.saving")}
                                        </div>
                                    ) : (
                                        t("onboarding.finish")
                                    )}
                                </Button>
                            </>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
