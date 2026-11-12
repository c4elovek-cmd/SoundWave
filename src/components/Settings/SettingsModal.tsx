import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  Check,
  Copy,
  FolderOpen,
  Gear,
  Heart,
  Microphone,
  PaintBrush,
  Plus,
  Sliders,
  SpeakerHigh,
  TextAa,
  Trash,
  X,
} from "../../lib/icons";
import { useAppStore } from "../../stores/appStore";
import { usePlayerStore } from "../../stores/playerStore";
import { DEFAULTS, useSettingsStore, UiStyle } from "../../stores/settingsStore";
import {
  BUILTIN_FONTS,
  CUSTOM_FONT_PREFIX,
  fontFamilies,
  fontStack,
  registerFont,
  syncCustomFonts,
} from "../../lib/fonts";
import { BUILTIN_THEMES, CustomTheme, themeDataId } from "../../lib/themes";
import { pushDiscordPresence } from "../../lib/discordPresence";
import { showToast } from "../../stores/toastStore";
import ThemeEditor from "../ThemeEditor/ThemeEditor";
import "./SettingsModal.css";

type TabId = "appearance" | "lyrics" | "player" | "discord" | "api" | "about";

const STYLES: {
  id: UiStyle;
  label: string;
  hint: string;
}[] = [
  { id: "classic", label: "Классический", hint: "Оформление в духе Spotify" },
  { id: "minimal", label: "Минимализм", hint: "Плоский дизайн, без теней" },
  { id: "contrast", label: "Контрастная", hint: "Чёрный фон, чёткие границы" },
  { id: "glass", label: "Глассморфизм", hint: "Полупрозрачные панели" },
  { id: "threeD", label: "3D", hint: "Объём, тени и градиенты" },
  { id: "bento", label: "Bento Grid", hint: "Модульная сетка плитками" },
  { id: "md3", label: "Material Design 3", hint: "Тональные поверхности и мягкие радиусы" },
];

const TABS: { id: TabId; label: string; icon: typeof Gear }[] = [
  { id: "appearance", label: "Внешний вид", icon: PaintBrush },
  { id: "lyrics", label: "Текст и караоке", icon: TextAa },
  { id: "player", label: "Плеер", icon: SpeakerHigh },
  { id: "discord", label: "Discord", icon: Microphone },
  { id: "api", label: "API для агентов", icon: Sliders },
  { id: "about", label: "О программе", icon: Gear },
];

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      className={`settings-switch ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
    >
      <span className="settings-switch-knob" />
    </button>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-label">{label}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

export default function SettingsModal() {
  const closeSettings = useAppStore((s) => s.closeSettings);

  // Плавное закрытие: сначала отыгрывает анимация «ухода»,
  // затем модалка размонтируется.
  const [closing, setClosing] = useState(false);
  const close = () => {
    if (closing) return;
    if (document.documentElement.classList.contains("no-animations")) {
      closeSettings();
      return;
    }
    setClosing(true);
    window.setTimeout(closeSettings, 170);
  };
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const customThemes = useAppStore((s) => s.customThemes);
  const saveCustomTheme = useAppStore((s) => s.saveCustomTheme);
  const deleteCustomTheme = useAppStore((s) => s.deleteCustomTheme);

  const settings = useSettingsStore();
  const setSetting = useSettingsStore((s) => s.set);
  const setCustomFonts = useSettingsStore((s) => s.setCustomFonts);

  const [tab, setTab] = useState<TabId>("appearance");

  /**
   * Смена вкладки через View Transitions API: окно настроек плавно
   * «перетекает» в новый размер (иная вкладка — иная высота контента),
   * а внутри окна контент кроссфейдится. Рывка высоты больше нет.
   * Без поддержки API (или при выключенных анимациях) — просто замена.
   */
  const selectTab = (next: TabId) => {
    if (next === tab) return;
    const switchTab = () => setTab(next);
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { finished: Promise<void> };
    };
    if (doc.startViewTransition && !document.documentElement.classList.contains("no-animations")) {
      doc.startViewTransition(switchTab);
    } else {
      switchTab();
    }
  };

  /**
   * Сброс одного контрола к значению по умолчанию — по средней кнопке
   * мыши (СКМ) на самом контроле. Показывает плашку с результатом.
   * `apply` нужен для контролов, которым мало `set` (громкость, порт).
   */
  const resetByDefault = (
    label: string,
    key: keyof typeof DEFAULTS,
    apply?: () => void
  ) => {
    const def = DEFAULTS[key];
    if (settings[key] === def) return; // уже дефолт — ничего не щёлкаем

    setSetting(key as never, def as never);
    apply?.();
    showToast({ title: `${label} — значение по умолчанию`, kind: "info" });
  };

  /** Атрибуты СКМ-сброса для любого контрола: auxclick с button === 1. */
  const middleReset = (
    label: string,
    key: keyof typeof DEFAULTS,
    apply?: () => void
  ) => ({
    // Автопрокрутка Chromium стартует на mousedown — гасим её сразу,
    // иначе СКМ на ползунках и списках просто прокручивает страницу.
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    },
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        resetByDefault(label, key, apply);
      }
    },
    title: `${label} — средняя кнопка мыши: вернуть по умолчанию`,
  });
  const [themeEditor, setThemeEditor] = useState<"new" | CustomTheme | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [apiInfo, setApiInfo] = useState<{
    enabled: boolean;
    port: number;
    token: string;
    url: string | null;
  } | null>(null);
  const [discord, setDiscord] = useState<{
    enabled: boolean;
    clientId: string;
    builtIn: boolean;
    largeImage: string;
    connected: boolean;
  } | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [updateChannel, setUpdateChannel] = useState("stable");
  const [portDraft, setPortDraft] = useState(String(settings.agentApiPort));

  // Автообновление: состояние проверки и скачивания.
  const [updateState, setUpdateState] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "uptodate"; current: string }
    | { kind: "available"; version: string }
    | { kind: "downloaded"; version: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    const offAvailable = window.electronAPI?.onUpdateAvailable?.((info) => {
      setUpdateState({ kind: "available", version: info.version });
    });
    const offDownloaded = window.electronAPI?.onUpdateDownloaded?.((info) => {
      setUpdateState({ kind: "downloaded", version: info.version });
    });
    const offError = window.electronAPI?.onUpdateError?.((info) => {
      setUpdateState({ kind: "error", message: info.message });
    });

    return () => {
      offAvailable?.();
      offDownloaded?.();
      offError?.();
    };
  }, []);

  const checkUpdates = async () => {
    setUpdateState({ kind: "checking" });

    const result = await window.electronAPI?.checkForUpdates?.();

    if (!result) {
      setUpdateState({ kind: "error", message: "Проверка не поддерживается" });
      return;
    }

    if (!result.ok) {
      setUpdateState({
        kind: "error",
        message: result.error ?? "Не удалось проверить обновления",
      });
      return;
    }

    if (result.upToDate) {
      setUpdateState({ kind: "uptodate", current: result.current ?? "" });
      return;
    }

    setUpdateState({ kind: "available", version: result.version ?? "" });
  };

  const lyricsFontStack = useMemo(
    () => fontStack(settings.lyricsFont, settings.customFonts),
    [settings.lyricsFont, settings.customFonts]
  );

  // Свои шрифты живут файлами в папке приложения — подгружаем при открытии.
  useEffect(() => {
    void syncCustomFonts().then(setCustomFonts);
  }, [setCustomFonts]);

  useEffect(() => {
    void window.electronAPI?.agentApiConfig?.().then((info) => {
      setApiInfo(info);
      setPortDraft(String(info.port));
    });

    void window.electronAPI?.discordStatus?.().then(setDiscord);

    void window.electronAPI?.getConfig?.().then((cfg) => {
      if (cfg && "version" in cfg) setAppVersion(String(cfg.version));

    void window.electronAPI?.getUpdateChannel?.().then((channel) => {
      if (channel) setUpdateChannel(channel);
    });
    });
  }, []);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Буфер обмена недоступен — не критично.
    }
  };

  const importFont = async () => {
    const font = await window.electronAPI?.importCustomFont?.();
    if (!font) return;

    await registerFont(font);
    const list = await window.electronAPI?.listCustomFonts?.();
    setCustomFonts(list ?? []);

    // Новый шрифт сразу становится выбранным, если до него был встроенный.
    if (!settings.lyricsFont.startsWith(CUSTOM_FONT_PREFIX)) {
      setSetting("lyricsFont", `${CUSTOM_FONT_PREFIX}${font.family}`);
    }
  };

  const removeFont = async (family: string) => {
    await window.electronAPI?.removeCustomFont?.(family);

    for (const face of Array.from(document.fonts)) {
      if (face.family === family) document.fonts.delete(face);
    }

    const list = (await window.electronAPI?.listCustomFonts?.()) ?? [];
    setCustomFonts(list);

    if (settings.lyricsFont === `${CUSTOM_FONT_PREFIX}${family}`) {
      setSetting("lyricsFont", "sans");
    }
  };

  const applyApi = async (patch: {
    enabled?: boolean;
    port?: number;
    regenerateToken?: boolean;
  }) => {
    const info = await window.electronAPI?.agentApiConfig?.(patch);
    if (!info) return;

    setApiInfo(info);
    setPortDraft(String(info.port));
    setSetting("agentApiEnabled", info.enabled);
    setSetting("agentApiPort", info.port);
  };

  const applyDiscord = async (patch: {
    enabled?: boolean;
    clientId?: string;
    largeImage?: string;
  }) => {
    const info = await window.electronAPI?.setDiscordConfig?.(patch);
    if (!info) return;

    setDiscord(info);
    setSetting("discordEnabled", info.enabled);
    setSetting("discordClientId", info.clientId);
    setSetting("discordLargeImage", info.largeImage);

    // Активность отправляем сразу, а не ждём смены трека.
    if (info.enabled && info.connected) pushDiscordPresence();
  };

  const renderTab = () => {
    switch (tab) {
      case "appearance":
        return (
          <>
            <div className="settings-section">
              {/* Средняя кнопка мыши — вернуть стандартную тему */}
              <h3
                onAuxClick={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  if (theme === "dark") return;
                  setTheme("dark");
                  showToast({ title: "Тема — тёмная (по умолчанию)", kind: "info" });
                }}
                title="Средняя кнопка мыши: вернуть тему по умолчанию"
              >
                Тема
              </h3>
              <div className="settings-theme-grid">
                {BUILTIN_THEMES.map((item) => (
                  <button
                    key={item.id}
                    className={`settings-theme-card ${theme === item.id ? "active" : ""}`}
                    onClick={() => setTheme(item.id)}
                  >
                    <span
                      className="settings-theme-dot"
                      style={{ background: item.accent }}
                    />
                    <span>{item.label}</span>
                    {theme === item.id && <Check size={15} weight="bold" />}
                  </button>
                ))}

                {customThemes.map((item) => {
                  const id = themeDataId(item);
                  return (
                    <div key={item.id} className="settings-theme-card custom">
                      <button
                        className="settings-theme-main"
                        onClick={() => setTheme(id)}
                      >
                        <span
                          className="settings-theme-dot"
                          style={{ background: item.accent }}
                        />
                        <span>{item.name}</span>
                        {theme === id && <Check size={15} weight="bold" />}
                      </button>
                      <button
                        className="settings-theme-remove"
                        onClick={() => deleteCustomTheme(item.id)}
                        title="Удалить тему"
                      >
                        <Trash size={14} />
                      </button>
                    </div>
                  );
                })}

                <button
                  className="settings-theme-card add"
                  onClick={() => setThemeEditor("new")}
                >
                  <Plus size={15} />
                  Своя тема
                </button>
              </div>
            </div>

            <div className="settings-section">
              <h3>Стиль оформления</h3>
              <div className="settings-style-grid">
                {STYLES.map((item) => (
                  <button
                    key={item.id}
                    className={`settings-style-card ${settings.style === item.id ? "active" : ""}`}
                    onClick={() => setSetting("style", item.id)}
                    {...middleReset("Стиль оформления", "style")}
                  >
                    <span className={`settings-style-preview ${item.id}`}>
                      <span />
                      <span />
                      <span />
                    </span>
                    <span className="settings-style-name">{item.label}</span>
                    <span className="settings-style-hint">{item.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-section">
              <h3>Интерфейс</h3>

              <Row label="Анимации" hint="Переходы и плавные появления">
                <Switch
                  checked={settings.animations}
                  onChange={(value) => setSetting("animations", value)}
                  label="Анимации"
                  {...middleReset("Анимации", "animations")}
                />
              </Row>

              <Row label="Плотность" hint="Компактный режим уменьшает отступы">
                <div className="settings-segmented" {...middleReset("Плотность", "density")}>
                  {(["comfortable", "compact"] as const).map((value) => (
                    <button
                      key={value}
                      className={settings.density === value ? "active" : ""}
                      onClick={() => setSetting("density", value)}
                    >
                      {value === "comfortable" ? "Обычная" : "Компактная"}
                    </button>
                  ))}
                </div>
              </Row>

              <Row
                label="Сайдбар свёрнут при запуске"
                hint="Панель навигации начинает работу в свёрнутом виде"
              >
                <Switch
                  checked={settings.sidebarCollapsed}
                  onChange={(value) => setSetting("sidebarCollapsed", value)}
                  label="Сайдбар свёрнут"
                />
              </Row>
            </div>
          </>
        );

      case "lyrics":
        return (
          <>
            <div className="settings-section">
              <h3>Текст песни</h3>

              <Row label="Шрифт">
                <select
                  className="settings-select"
                  value={settings.lyricsFont}
                  onChange={(e) => setSetting("lyricsFont", e.target.value)}
                  style={{ fontFamily: lyricsFontStack }}
                  {...middleReset("Шрифт текста", "lyricsFont")}
                >
                  {BUILTIN_FONTS.map((font) => (
                    <option key={font.id} value={font.id} style={{ fontFamily: font.stack }}>
                      {font.label}
                    </option>
                  ))}

                  {fontFamilies(settings.customFonts).length > 0 && (
                    <optgroup label="Свои шрифты">
                      {fontFamilies(settings.customFonts).map((item) => (
                        <option
                          key={item.family}
                          value={`${CUSTOM_FONT_PREFIX}${item.family}`}
                          style={{ fontFamily: `"${item.family}", sans-serif` }}
                        >
                          {item.display}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </Row>

              <Row label={`Размер текста — ${settings.lyricsFontSize} px`}>
                <input
                  type="range"
                  className="settings-range"
                  min={12}
                  max={22}
                  step={1}
                  value={settings.lyricsFontSize}
                  onChange={(e) => setSetting("lyricsFontSize", Number(e.target.value))}
                  {...middleReset("Размер текста", "lyricsFontSize")}
                />
              </Row>

              <Row
                label="Караоке по умолчанию"
                hint="В панели текста сразу включается подсветка строк"
              >
                <Switch
                  checked={settings.karaokeEnabled}
                  onChange={(value) => setSetting("karaokeEnabled", value)}
                  label="Караоке по умолчанию"
                  {...middleReset("Караоке по умолчанию", "karaokeEnabled")}
                />
              </Row>

              <Row
                label="Искать текст и караоке заранее"
                hint="Текст и тайминги ищутся для текущего трека и следующих в очереди ещё до того, как песня заиграет. Караоке включается мгновенно, а сеть не дёргается посреди песни"
              >
                <Switch
                  checked={settings.lyricsPrefetch}
                  onChange={(value) => setSetting("lyricsPrefetch", value)}
                  label="Искать текст и караоке заранее"
                  {...middleReset("Искать текст и караоке заранее", "lyricsPrefetch")}
                />
              </Row>

              <Row
                label="Подсветка в караоке"
                hint="По буквам: заливка идёт внутри слова по буквам. По слогам: слово делится на слоги («ма-ши-на»), каждый заливается по очереди. По словам: слово загорается целиком и остаётся подсвеченным"
              >
                <div
                  className="settings-segmented"
                  {...middleReset("Подсветка в караоке", "karaokeMode")}
                >
                  {(["letters", "syllables", "words"] as const).map((value) => (
                    <button
                      key={value}
                      className={settings.karaokeMode === value ? "active" : ""}
                      onClick={() => setSetting("karaokeMode", value)}
                    >
                      {value === "letters"
                        ? "По буквам"
                        : value === "syllables"
                          ? "По слогам"
                          : "По словам"}
                    </button>
                  ))}
                </div>
              </Row>

              <Row
                label={`Сдвиг караоке — ${settings.karaokeOffsetMs > 0 ? "+" : ""}${settings.karaokeOffsetMs} мс`}
                hint="Минус — подсветка раньше, плюс — позже. Общая поправка для всех треков; двойной клик по ползунку — сброс в 0"
              >
                <div className="settings-offset-row">
                  <input
                    type="range"
                    className="settings-range"
                    min={-3000}
                    max={3000}
                    step={50}
                    value={settings.karaokeOffsetMs}
                    onChange={(e) => setSetting("karaokeOffsetMs", Number(e.target.value))}
                    onDoubleClick={() => setSetting("karaokeOffsetMs", 0)}
                    {...middleReset("Сдвиг караоке", "karaokeOffsetMs")}
                  />
                  <button
                    className="settings-offset-zero"
                    onClick={() => setSetting("karaokeOffsetMs", 0)}
                    disabled={settings.karaokeOffsetMs === 0}
                    title="Вернуть 0 — без сдвига"
                    aria-label="Сбросить сдвиг караоке в 0"
                  >
                    0
                  </button>
                </div>
              </Row>

              <Row
                label="Всегда искать точную синхронизацию"
                hint="Запрос к LRCLIB даже без режима караоке"
              >
                <Switch
                  checked={settings.exactSync}
                  onChange={(value) => setSetting("exactSync", value)}
                  label="Точная синхронизация"
                  {...middleReset("Точная синхронизация", "exactSync")}
                />
              </Row>
            </div>

            <div className="settings-section">
              <h3>Свои шрифты</h3>
              <p className="settings-note">
                Файлы <code>.ttf</code>, <code>.otf</code>, <code>.woff</code> и{" "}
                <code>.woff2</code> копируются в папку приложения и доступны во всех
                окнах.
              </p>

              <div className="settings-font-list">
                {fontFamilies(settings.customFonts).length === 0 && (
                  <span className="settings-empty">Своих шрифтов пока нет</span>
                )}

                {fontFamilies(settings.customFonts).map((item) => (
                  <div key={item.family} className="settings-font-item">
                    <span
                      className="settings-font-name"
                      style={{ fontFamily: `"${item.family}", sans-serif` }}
                    >
                      {item.display}
                    </span>
                    <span className="settings-font-weights">
                      {item.weights
                        .slice()
                        .sort((a, b) => a - b)
                        .map((w) => w)
                        .join(", ")}
                    </span>
                    <button
                      className="settings-icon-btn"
                      onClick={() => void removeFont(item.family)}
                      title="Удалить шрифт"
                    >
                      <Trash size={15} />
                    </button>
                  </div>
                ))}
              </div>

              <button className="settings-button" onClick={() => void importFont()}>
                <Plus size={15} />
                Импортировать шрифт
              </button>
            </div>
          </>
        );

      case "player":
        return (
          <>
            <div className="settings-section">
              <h3>Воспроизведение</h3>

            <Row label={`Громкость — ${Math.round(settings.volume * 100)}%`}>
              <input
                type="range"
                className="settings-range"
                min={0}
                max={1}
                step={0.01}
                value={settings.volume}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  setSetting("volume", value);
                  usePlayerStore.getState().setVolume(value);
                }}
                {...middleReset("Громкость", "volume", () => {
                  usePlayerStore.getState().setVolume(DEFAULTS.volume);
                })}
              />
            </Row>

            <Row label="Перемешивать при запуске">
              <Switch
                checked={settings.shuffleOnStart}
                onChange={(value) => setSetting("shuffleOnStart", value)}
                label="Перемешивать при запуске"
                {...middleReset("Перемешивание при запуске", "shuffleOnStart")}
              />
            </Row>

            <Row label="Повтор при запуске">
              <div
                className="settings-segmented"
                {...middleReset("Повтор при запуске", "repeatOnStart")}
              >
                {(["off", "all", "one"] as const).map((value) => (
                  <button
                    key={value}
                    className={settings.repeatOnStart === value ? "active" : ""}
                    onClick={() => setSetting("repeatOnStart", value)}
                  >
                    {value === "off" ? "Выкл" : value === "all" ? "Все" : "Один"}
                  </button>
                ))}
              </div>
            </Row>

            <Row
              label="Не ставить DRM-треки в очередь"
              hint="Защищённые треки не попадают в «Мою волну» и очередь. Включить такой трек можно только вручную"
            >
              <Switch
                checked={settings.excludeDrmTracks}
                onChange={(value) => setSetting("excludeDrmTracks", value)}
                label="Не ставить DRM-треки в очередь"
                {...middleReset("Не ставить DRM-треки в очередь", "excludeDrmTracks")}
              />
            </Row>
          </div>

          <div className="settings-section">
            <h3>Аудио-визуализатор</h3>

            <Row
              label="Показывать визуализацию"
              hint="Реакция на звук в фоне панели плеера"
            >
              <Switch
                checked={settings.visualizerEnabled}
                onChange={(value) => setSetting("visualizerEnabled", value)}
                label="Аудио-визуализатор"
                {...middleReset("Визуализатор", "visualizerEnabled")}
              />
            </Row>

            <Row label="Стиль">
              <div
                className="settings-segmented"
                {...middleReset("Стиль визуализатора", "visualizerStyle")}
              >
                {(["bars", "mirror", "wave"] as const).map((value) => (
                  <button
                    key={value}
                    className={settings.visualizerStyle === value ? "active" : ""}
                    onClick={() => setSetting("visualizerStyle", value)}
                  >
                    {value === "bars" ? "Столбики" : value === "mirror" ? "Зеркало" : "Волна"}
                  </button>
                ))}
              </div>
            </Row>

            <Row label={`Высота — ${settings.visualizerHeight} px`}>
              <input
                type="range"
                className="settings-range"
                min={40}
                max={140}
                step={4}
                value={settings.visualizerHeight}
                onChange={(e) => setSetting("visualizerHeight", Number(e.target.value))}
                {...middleReset("Высота визуализатора", "visualizerHeight")}
              />
            </Row>
          </div>
          </>
        );

      case "discord":
        return (
          <>
            <div className="settings-section">
              <h3>Discord Rich Presence</h3>

              <Row
                label="Показывать, что я слушаю"
                hint="Трек появится в профиле Discord"
              >
                <Switch
                  checked={settings.discordEnabled}
                  onChange={(value) => void applyDiscord({ enabled: value })}
                  label="Discord Rich Presence"
                  {...middleReset("Discord Rich Presence", "discordEnabled", () => {
                    void applyDiscord({ enabled: DEFAULTS.discordEnabled });
                  })}
                />
              </Row>

              <Row
                label="Client ID"
                hint={
                  discord?.builtIn
                    ? `Встроенный: ${discord.clientId}`
                    : "Application ID из раздела General Information"
                }
              >
                <div className="settings-inline">
                  <input
                    className="settings-input"
                    value={settings.discordClientId}
                    placeholder={discord?.clientId ?? "1562164443893211307"}
                    onChange={(e) => setSetting("discordClientId", e.target.value.trim())}
                    onBlur={(e) => void applyDiscord({ clientId: e.target.value.trim() })}
                    {...middleReset("Client ID Discord", "discordClientId", () => {
                      void applyDiscord({ clientId: "" });
                    })}
                  />
                  {settings.discordClientId && (
                    <button
                      className="settings-icon-btn"
                      onClick={() => void applyDiscord({ clientId: "" })}
                      title="Вернуть встроенный Client ID"
                    >
                      <ArrowCounterClockwise size={15} />
                    </button>
                  )}
                </div>
              </Row>

              <Row
                label="Имя большой картинки"
                hint="Запасной ассет, если у трека нет обложки (обычно soundwave). Обложка трека показывается автоматически"
              >
                <input
                  className="settings-input"
                  value={settings.discordLargeImage}
                  placeholder="soundwave"
                  onChange={(e) => setSetting("discordLargeImage", e.target.value.trim())}
                  onBlur={(e) => void applyDiscord({ largeImage: e.target.value.trim() })}
                  {...middleReset("Имя картинки Discord", "discordLargeImage", () => {
                    void applyDiscord({ largeImage: "" });
                  })}
                />
              </Row>

              <div className="settings-steps">
                <span className="settings-steps-title">
                  Свой Client ID — необязательно
                </span>
                <p className="settings-note">
                  В сборку уже вшит Client ID приложения SoundWave, поэтому
                  Rich Presence работает сразу, без настройки. Свой можно
                  подставить, если хочется другое имя или иконку в профиле:
                </p>
                <ol>
                  <li>
                    Открой{" "}
                    <button
                      className="settings-link"
                      onClick={() =>
                        void window.electronAPI?.openExternal(
                          "https://discord.com/developers/applications"
                        )
                      }
                    >
                      discord.com/developers/applications
                      <ArrowSquareOut size={12} />
                    </button>
                  </li>
                  <li>Нажми «Create» → «Create new application», назови SoundWave</li>
                  <li>
                    В разделе General Information скопируй Application ID и вставь
                    выше
                  </li>
                  <li>
                    В разделе Rich Presence загрузи картинку с именем{" "}
                    <code>soundwave</code> — тогда в профиле будет обложка
                  </li>
                </ol>
              </div>

              <p className="settings-note">
                Rich Presence работает только с настольным Discord для ПК. В
                приложении используется локальный канал Discord RPC — те же
                cookies, что и у официального приложения, ничего лишнего наружу не
                отправляется.
              </p>

              <div className="settings-status">
                <span
                  className={`settings-status-dot ${
                    discord?.connected ? "ok" : "off"
                  }`}
                />
                {discord?.connected
                  ? "Подключено к Discord"
                  : !discord?.clientId
                    ? "Укажите Client ID — без него Discord не подключится"
                    : "Нет подключения — проверьте, запущен ли Discord"}
              </div>

              <div className="settings-inline" style={{ marginTop: 12 }}>
                <button
                  className="settings-button"
                  onClick={() => {
                    void window.electronAPI?.setDiscordPresence?.({
                      details: "SoundWave запущен",
                      state: "Проверка связи с Discord",
                      largeText: "SoundWave",
                      smallText: "Проверка",
                      startTimestamp: Math.floor(Date.now() / 1000),
                    });
                  }}
                >
                  Показать тестовую активность
                </button>
                <span className="settings-note" style={{ margin: 0 }}>
                  Discord показывает только одну активность: если её заняло
                  другое приложение, закройте его.
                </span>
              </div>
            </div>
          </>
        );

      case "api":
        return (
          <div className="settings-section">
            <h3>Локальный API для агентов</h3>

            <Row
              label="Включить API"
              hint="Локальный HTTP-сервер для управления плеером"
            >
              <Switch
                checked={settings.agentApiEnabled}
                onChange={(value) => void applyApi({ enabled: value })}
                label="Включить API"
                {...middleReset("API для агентов", "agentApiEnabled", () => {
                  void applyApi({ enabled: DEFAULTS.agentApiEnabled });
                })}
              />
            </Row>

            <Row label="Порт" hint="Занятый порт — берётся следующий свободный">
              <div className="settings-inline">
                <input
                  className="settings-input port"
                  value={portDraft}
                  inputMode="numeric"
                  onChange={(e) => setPortDraft(e.target.value.replace(/\D/g, ""))}
                  {...middleReset("Порт API", "agentApiPort", () => {
                    void applyApi({ port: DEFAULTS.agentApiPort });
                  })}
                />
                <button
                  className="settings-button small"
                  onClick={() => void applyApi({ port: Number(portDraft) })}
                >
                  Применить
                </button>
              </div>
            </Row>

            <Row label="Токен доступа" hint="Заголовок Authorization: Bearer <токен>">
              <div className="settings-inline">
                <input
                  className="settings-input token"
                  type={tokenVisible ? "text" : "password"}
                  value={apiInfo?.token ?? ""}
                  readOnly
                />
                <button
                  className="settings-icon-btn"
                  onClick={() => setTokenVisible((v) => !v)}
                  title="Показать или скрыть"
                >
                  <TextAa size={15} />
                </button>
                <button
                  className="settings-icon-btn"
                  onClick={() => void copy(apiInfo?.token ?? "")}
                  title="Скопировать"
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                </button>
                <button
                  className="settings-icon-btn"
                  onClick={() => void applyApi({ regenerateToken: true })}
                  title="Выпустить новый токен"
                >
                  <Plus size={15} />
                </button>
              </div>
            </Row>

            {apiInfo?.url && (
              <p className="settings-note">
                Адрес: <code>{apiInfo.url}</code> · схема:{" "}
                <button
                  className="settings-link"
                  onClick={() =>
                    void window.electronAPI?.openExternal(
                      `${apiInfo.url}/api/openapi.json`
                    )
                  }
                >
                  OpenAPI
                  <ArrowSquareOut size={12} />
                </button>
              </p>
            )}
          </div>
        );

      case "about":
        return (
          <div className="settings-section">
            <h3>О программе</h3>

            <Row label="Версия">
              <span className="settings-value">SoundWave {appVersion || "—"}</span>
            </Row>

            <Row
              label="Канал обновлений"
              hint="stable — стабильные сборки, beta и alpha — ранние"
            >
              <div className="settings-channel">
                {(["stable", "beta", "alpha"] as const).map((item) => (
                  <button
                    key={item}
                    className={`settings-channel-item ${
                      updateChannel === item ? "active" : ""
                    }`}
                    onClick={() => {
                      if (updateChannel === item) return;
                      setUpdateChannel(item);
                      void window.electronAPI?.setUpdateChannel?.(item);
                    }}
                    title={
                      item === "stable"
                        ? "Только проверенные сборки"
                        : item === "beta"
                          ? "Сборки с новыми функциями"
                          : "Самые свежие изменения, возможны ошибки"
                    }
                  >
                    {item}
                  </button>
                ))}
              </div>
            </Row>

            <Row
              label="Обновления"
              hint="Проверяет GitHub и ставит свежую версию"
            >
              <div className="settings-update">
                {updateState.kind === "checking" && (
                  <span className="settings-value">Проверяем…</span>
                )}
                {updateState.kind === "uptodate" && (
                  <span className="settings-value">
                    Установлена свежая версия{updateState.current ? ` (${updateState.current})` : ""}
                  </span>
                )}
                {updateState.kind === "available" && (
                  <span className="settings-value">
                    Доступно обновление {updateState.version}
                  </span>
                )}
                {updateState.kind === "downloaded" && (
                  <span className="settings-value">
                    Обновление {updateState.version} скачано
                  </span>
                )}
                {updateState.kind === "error" && (
                  <span className="settings-value" title={updateState.message}>
                    {updateState.message}
                  </span>
                )}

                {updateState.kind === "available" ||
                updateState.kind === "downloaded" ? (
                  <button
                    className="settings-button"
                    onClick={() => void window.electronAPI?.installUpdate?.()}
                  >
                    Установить и перезапустить
                  </button>
                ) : (
                  <button
                    className="settings-button"
                    onClick={() => void checkUpdates()}
                    disabled={updateState.kind === "checking"}
                  >
                    Проверить обновления
                  </button>
                )}
              </div>
            </Row>

            <Row
              label="Журнал действий"
              hint="Пишет все нажатия в logs/actions.log — пригодится, чтобы разобрать баг"
            >
              <Switch
                checked={settings.actionLog}
                onChange={(value) => setSetting("actionLog", value)}
                label="Журнал действий"
                {...middleReset("Журнал действий", "actionLog")}
              />
            </Row>

            <Row
              label="Закрывать в трей"
              hint="Крестик на окне сворачивает приложение в трей, а не закрывает его"
            >
              <Switch
                checked={settings.closeToTray}
                onChange={(value) => {
                  setSetting("closeToTray", value);
                  void window.electronAPI?.setCloseToTray?.(value);
                }}
                label="Закрывать окно в трей"
                {...middleReset("Закрывать в трей", "closeToTray", () => {
                  void window.electronAPI?.setCloseToTray?.(DEFAULTS.closeToTray);
                })}
              />
            </Row>

            <Row label="Папка данных" hint="Кэш текстов, свои шрифты, конфиг, логи">
              <button
                className="settings-button"
                onClick={() => void window.electronAPI?.openUserData?.()}
              >
                <FolderOpen size={15} />
                Открыть папку
              </button>
            </Row>

            <Row label="Репозиторий">
              <button
                className="settings-button"
                onClick={() =>
                  void window.electronAPI?.openExternal(
                    "https://github.com/c4elovek-cmd/SoundWave"
                  )
                }
              >
                <ArrowSquareOut size={15} />
                GitHub
              </button>
            </Row>

            <Row
              label="Благодарности"
              hint="Идеи и решения подсмотрены в проекте NeDotify"
            >
              <button
                className="settings-button"
                onClick={() =>
                  void window.electronAPI?.openExternal(
                    "https://github.com/vitalygotska/NeDotify"
                  )
                }
              >
                <Heart size={15} />
                NeDotify
              </button>
            </Row>

            <Row
              label="Сбросить настройки"
              hint="Вернуть значения по умолчанию, не трогая темы и шрифты"
            >
              <button
                className="settings-button danger"
                onClick={() => useSettingsStore.getState().reset()}
              >
                Сбросить
              </button>
            </Row>
          </div>
        );

      default:
        return null;
    }
  };

  return createPortal(
    <div className={`settings-backdrop ${closing ? "closing" : ""}`} onClick={close}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <span>Настройки</span>
          <button className="icon-btn" onClick={close} title="Закрыть">
            <X size={16} />
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-tabs">
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={tab === item.id ? "active" : ""}
                  onClick={() => selectTab(item.id)}
                >
                  <Icon size={17} />
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="settings-content">
            {renderTab()}
          </div>
        </div>
      </div>

      {themeEditor && (
        <ThemeEditor
          initial={themeEditor === "new" ? undefined : themeEditor}
          onSave={(nextTheme) => {
            saveCustomTheme(nextTheme);
            setThemeEditor(null);
          }}
          onDelete={(id) => {
            deleteCustomTheme(id);
            setThemeEditor(null);
          }}
          onClose={() => setThemeEditor(null)}
        />
      )}
    </div>,
    document.body
  );
}
