import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  Check,
  Copy,
  FolderOpen,
  Gear,
  Microphone,
  PaintBrush,
  Plus,
  Sliders,
  SpeakerHigh,
  TextAa,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useAppStore } from "../../stores/appStore";
import { usePlayerStore } from "../../stores/playerStore";
import { useSettingsStore, UiStyle } from "../../stores/settingsStore";
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
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const customThemes = useAppStore((s) => s.customThemes);
  const saveCustomTheme = useAppStore((s) => s.saveCustomTheme);
  const deleteCustomTheme = useAppStore((s) => s.deleteCustomTheme);

  const settings = useSettingsStore();
  const setSetting = useSettingsStore((s) => s.set);
  const setCustomFonts = useSettingsStore((s) => s.setCustomFonts);

  const [tab, setTab] = useState<TabId>("appearance");
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
  const [portDraft, setPortDraft] = useState(String(settings.agentApiPort));

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
              <h3>Тема</h3>
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
                />
              </Row>

              <Row label="Плотность" hint="Компактный режим уменьшает отступы">
                <div className="settings-segmented">
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
                />
              </Row>

              <Row
                label="Всегда искать точную синхронизацию"
                hint="Запрос к LRCLIB даже без режима караоке"
              >
                <Switch
                  checked={settings.exactSync}
                  onChange={(value) => setSetting("exactSync", value)}
                  label="Точная синхронизация"
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
              />
            </Row>

            <Row label="Перемешивать при запуске">
              <Switch
                checked={settings.shuffleOnStart}
                onChange={(value) => setSetting("shuffleOnStart", value)}
                label="Перемешивать при запуске"
              />
            </Row>

            <Row label="Повтор при запуске">
              <div className="settings-segmented">
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
          </div>
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
                hint="Ключ ассета в Discord — обычно soundwave"
              >
                <input
                  className="settings-input"
                  value={settings.discordLargeImage}
                  placeholder="soundwave"
                  onChange={(e) => setSetting("discordLargeImage", e.target.value.trim())}
                  onBlur={(e) => void applyDiscord({ largeImage: e.target.value.trim() })}
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
              />
            </Row>

            <Row label="Порт" hint="Занятый порт — берётся следующий свободный">
              <div className="settings-inline">
                <input
                  className="settings-input port"
                  value={portDraft}
                  inputMode="numeric"
                  onChange={(e) => setPortDraft(e.target.value.replace(/\D/g, ""))}
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
              label="Журнал действий"
              hint="Пишет все нажатия в logs/actions.log — пригодится, чтобы разобрать баг"
            >
              <Switch
                checked={settings.actionLog}
                onChange={(value) => setSetting("actionLog", value)}
                label="Журнал действий"
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
    <div className="settings-backdrop" onClick={closeSettings}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <span>Настройки</span>
          <button className="icon-btn" onClick={closeSettings} title="Закрыть">
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
                  onClick={() => setTab(item.id)}
                >
                  <Icon size={17} />
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="settings-content">{renderTab()}</div>
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
