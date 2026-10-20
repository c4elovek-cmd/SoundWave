# SoundWave — Десктопный клиент SoundCloud

## Концепция и видение

Нативный десктопный клиент SoundCloud с интерфейсом в стиле Spotify. Приложение предоставляет полный доступ к аккаунту SoundCloud — трекам, плейлистам, загрузкам, подпискам — без браузера. Ощущение: быстрый, лёгкий, минималистичный, но с характером SoundCloud (оранжевый, музыка, свобода).

Целевой пользователь — слушатель, который хочет удобство настольного клиента (горячие клавиши, системный трей, медиа-клавиши) без зависимости от браузера.

## Дизайн-система

### Цветовая палитра SoundCloud

**Тёмная тема (Dark) — основная:**
| Роль | Цвет | HEX |
|------|------|-----|
| Background | Тёмно-серый | `#121212` |
| Surface | Чуть светлее | `#181818` |
| Surface Elevated | Карточки | `#232323` |
| Surface Hover | Ховер | `#282828` |
| Border | Разделители | `#333333` |
| Text Primary | Белый | `#FFFFFF` |
| Text Secondary | Серый | `#B3B3B3` |
| Text Disabled | Тёмный серый | `#6B6B6B` |
| **Accent (SoundCloud Orange)** | Оранжевый | `#FF5500` |
| Accent Hover | Светлее | `#FF7043` |
| Accent Pressed | Темнее | `#E64A00` |

**Светлая тема (Light):**
| Роль | Цвет | HEX |
|------|------|-----|
| Background | Почти белый | `#FAFAFA` |
| Surface | Белый | `#FFFFFF` |
| Surface Elevated | Карточки | `#F5F5F5` |
| Border | Светлый | `#E0E0E0` |
| Text Primary | Почти чёрный | `#1A1A1A` |
| Text Secondary | Серый | `#666666` |
| Accent | Оранжевый | `#FF5500` |

**Дополнительные темы (будущее):**
- Purple (фиолетовая)
- Green (зелёная)
- Sunset (градиентная)

### Типографика

- **Основной шрифт:** `Inter` — читаемый, нейтральный, как у Spotify
- **Заголовки:** `Inter` 600–700 weight
- **Размеры:**
  - XL: 24px (заголовки страниц)
  - L: 18px (секции)
  - M: 14px (основной текст)
  - S: 12px (мета-данные, время)
- **Line-height:** 1.4 для текста, 1.2 для заголовков

### Пространственная система

- **Базовый модуль:** 4px
- **Отступы:** 8px, 12px, 16px, 24px, 32px, 48px
- **Радиусы:**
  - Кнопки/инпуты: 4px
  - Карточки: 8px
  - Аватары: 50%
  - Крупные элементы: 12px
- **Тени:** минимальные, только для elevated surfaces

### Анимации

- **Длительность:** 150ms для ховер-эффектов, 300ms для переходов
- **Easing:** `cubic-bezier(0.4, 0, 0.2, 1)` — Material motion
- **Hover:** scale(1.02) для карточек
- **Page transitions:** fade 200ms

## Структура интерфейса

### Layout (как Spotify)

```
┌─────────────────────────────────────────────────────────────┐
│  ┌──────────┐ ┌─────────────────────────────┐ ┌─────────┐ │
│  │          │ │                             │ │         │ │
│  │ SIDEBAR  │ │       CONTENT AREA          │ │  QUEUE  │ │
│  │  220px   │ │       (flex: 1)             │ │  300px  │ │
│  │          │ │                             │ │         │ │
│  │ - Logo   │ │  - Search results           │ │ Текущий │ │
│  │ - Home   │ │  - Playlist view            │ │  плейлист│ │
│  │ - Search │ │  - Artist page              │ │ или     │ │
│  │ - Library│ │  - Album tracks            │ │ следующие│ │
│  │ - Likes  │ │                             │ │  треки  │ │
│  │ - Uploads│ │                             │ │         │ │
│  │ ──────── │ │                             │ │         │ │
│  │ Playlists│ │                             │ │         │ │
│  │          │ │                             │ │         │ │
│  └──────────┘ └─────────────────────────────┘ └─────────┘ │
├─────────────────────────────────────────────────────────────┤
│  PLAYER BAR (80px)                                           │
│  [Album Art] Track info  ◄◄  ▶  ►►  ───●────────  🔊 ───  │
└─────────────────────────────────────────────────────────────┘
```

### Страницы/Виды

1. **Home** — недавнее, рекомендации, тренды
2. **Search** — поиск треков, исполнителей, плейлистов
3. **Library** — все загруженные треки
4. **Likes** — лайкнутые треки
5. **Uploads** — собственные загрузки
6. **Playlist View** — треки плейлиста
7. **Artist View** — треки и репосты артиста
8. **Queue Panel** — боковая панель очереди

### Компоненты

#### Карточка трека (TrackRow)
- 48px высота
- Album art 40x40px
- Название (primary), Исполнитель (secondary)
- Длительность справа
- Hover: background → Surface Hover, show play button overlay
- Playing state: оранжевый индикатор слева

#### Карточка плейлиста/артиста (Card)
- Квадратная обложка (aspect 1:1)
- Название под обложкой
- Hover: scale(1.02), тень, play button overlay

#### Sidebar Navigation
- Logo сверху (SoundWave, оранжевый акцент)
- Navigation items с иконками
- Разделитель между nav и playlists
- Scroll для длинных списков плейлистов

#### Player Bar
- Album art 56x56px
- Track title + artist (marquee если длинный)
- Controls: prev, play/pause, next
- Progress bar (draggable)
- Volume slider
- Queue button

#### Search Bar
- Input с placeholder "Search tracks, artists..."
- Иконка лупы слева
- Clear button справа
- 200ms debounce

## Функциональность

### Авторизация (вход в аккаунт)

**Flow:**
1. Пользователь жмёт «Войти» — открывается **одно** окно входа (всего в приложении не больше двух окон)
2. В окне выбирается способ:
   - «Войти через SoundCloud» — в это же окно грузится настоящая `soundcloud.com/signin`, пароль вводится на самом SoundCloud
   - «Войти вручную» — в это же окно переключается форма для вставки cookies
3. После успешного входа SoundCloud уводит на `/discover` (или `/you`) — приложение забирает cookies домена `.soundcloud.com` из раздела сессии `persist:soundcloud`
4. Cookies кладутся в общий раздел сессии, окно входа закрывается, главное окно получает профиль
5. При последующих запусках — сессия восстанавливается автоматически (раздел персистентный), вход заново не нужен

**Реализация:**
- Окно входа с настоящей страницей soundcloud.com; пароль приложению не видно
- Запасной путь: ручной импорт cookies (строка заголовка, JSON Cookie-Editor, Netscape cookies.txt) — cookies пишутся в тот же раздел сессии и проверяются запросом `/me`
- Дальнейшие запросы — через внутренний API SoundCloud из main-процесса (в renderer нельзя передать заголовок `Cookie`)

### Воспроизведение

- Play/Pause/Next/Previous
- Seek (клик на progress bar)
- Volume control
- shuffle/repeat
- Queue management (add, remove, reorder)
- Keyboard shortcuts

### Навигация

- Поиск по трекам, исполнителям, плейлистам
- Переход по ссылкам в треках (исполнитель, альбом)
- Browser back/forward

### Моя волна

- Включение/остановка бесконечного потока рекомендаций
- Три режима: «Знакомое», «Всё вместе», «Новое» — меняют веса источников
- Очередь доливается автоматически, когда треки заканчиваются
- Дизлайк убирает трек из очереди; два дизлайка артиста исключают его из волны
- История прослушанного и дизлайки хранятся в `localStorage`
- Очередь волны — это очередь `playerStore`: next/prev/автопереход работают как обычно

### Плейлисты

- Создание/редактирование/удаление
- Добавление/удаление треков
- Drag & drop reorder

### Системные фичи

- Системный трей с иконкой
- Медиа-клавиши (play/pause/next/prev)
- Глобальный хоткей (play/pause)
- Минимизация в трей
- Clipboard share links

## Техническая архитектура

### Стек

- **Runtime:** Tauri v2 (WebView2 на Windows, WebKit на macOS)
- **Frontend:** React 18 + TypeScript + Vite
- **Styling:** CSS Modules + CSS Variables (для тем)
- **State:** Zustand (простой, быстрый)
- **Audio:** HTML5 `<audio>` + hls.js (для HLS-манифестов, которых Chromium не играет нативно)
- **HTTP:** Axios для запросов к SC API

### Структура проекта

```
src/
├── main.tsx                 # React entry
├── App.tsx                  # Root component, routing
├── styles/
│   ├── themes/
│   │   ├── dark.css
│   │   ├── light.css
│   │   └── variables.css
│   └── global.css
├── components/
│   ├── Sidebar/
│   ├── Player/
│   ├── TrackRow/
│   ├── Card/
│   ├── SearchBar/
│   └── common/
├── pages/
│   ├── Home.tsx
│   ├── Search.tsx
│   ├── Library.tsx
│   └── Playlist.tsx
├── hooks/
│   ├── useAudio.ts
│   ├── useTheme.ts
│   └── useSCApi.ts
├── stores/
│   ├── playerStore.ts
│   ├── authStore.ts
│   └── libraryStore.ts
├── lib/
│   ├── soundcloud-api.ts    # API wrapper
│   ├── auth.ts              # Авторизация
│   └── storage.ts           # Локальное хранилище
└── types/
    └── soundcloud.ts
```

### SoundCloud API (internal)

Приложение использует internal API веб-версии SoundCloud (`api-v2.soundcloud.com`). Запросы идут из main-процесса Electron: только там можно передать заголовки `Cookie` и `Authorization: OAuth <oauth_token>`, которые требует api-v2 для приватных коллекций.

**Основные endpoints:**
```
GET    /me                                     # Профиль
GET    /users/{id}/tracks                       # Мои треки
GET    /users/{id}/likes                        # Лайки
GET    /users/{id}/followings                   # Подписки
GET    /users/{id}/playlists                    # Плейлисты
GET    /users/{id}                             # Профиль пользователя
GET    /tracks/{id}                            # Информация о треке (media.transcodings)
GET    /tracks/{id}/related                     # Похожие треки (основа «Моей волны»)
GET    /charts?kind=trending&genre=...         # Популярное (без входа)
GET    /search?q=...&type=tracks|users|playlists # Поиск
GET    /playlists/{id}                         # Плейлист
```

> Путей вида `/me/likes` в api-v2 нет — они отдают 404. Приватные коллекции доступны только по `/users/{id}/...`.

**Stream URL:** `/tracks/{id}` отдаёт `media.transcodings`; запрос манифеста
(`.../stream/progressive?client_id=…`) возвращает подписанный URL файла на CDN — он играется напрямую.
Часть треков SoundCloud отдаёт только в HLS (`audio/mp4; codecs="mp4a.40.2"`) — такие потоки играются через `hls.js` (MSE).

### Хранение данных

- **Сессия:** cookies SoundCloud в разделе Electron `persist:soundcloud` (переживает перезапуск)
- **Настройки:** `electron-store` (тема, громкость, размер окна)
- **Cache:** в памяти + optional disk cache для artwork

## Roadmap

### Phase 1 — MVP (этот релиз)
- [x] Логин в аккаунт
- [x] Основные страницы (Home, Search, Library, Likes)
- [x] Воспроизведение треков
- [x] Player bar с базовыми контролами
- [x] Тёмная тема
- [x] Системный трей

### Phase 2 — Улучшения
- [ ] Светлая тема
- [ ] Сворачивание/разворачивание sidebar
- [ ] Right panel (queue/now playing)
- [ ] Создание/редактирование плейлистов
- [ ] Drag & drop в очередь

### Phase 3 — Расширение
- [ ] Выбор тем (оранжевая, фиолетовая, зелёная)
- [ ] Hotkeys настройка
- [ ] Scrobbling (Last.fm)
- [ ] Скачивание треков (если возможно)
- [ ] Мини-режим плеера

## Keyboard Shortcuts

| Клавиша | Действие |
|---------|----------|
| `Space` | Play / Pause |
| `←` / `→` | Prev / Next track |
| `↑` / `↓` | Volume + / - |
| `M` | Mute |
| `Ctrl+F` | Focus search |
| `Ctrl+L` | Liked current track |
| `Ctrl+Q` | Toggle queue panel |
