# SoundWave

Десктопный клиент **SoundCloud** в стиле Spotify. Оранжевая тема, смена оформления, глобальные медиа-клавиши, системный трей.

![status](https://img.shields.io/badge/status-MVP-ff5500)
![stack](https://img.shields.io/badge/Electron%20%2B%20React%20%2B%20TS-ff5500)

## Что внутри

- **Интерфейс в стиле Spotify** — сайдбар, основной контент, панель плеера, панель очереди
- **Вход в аккаунт SoundCloud** — три способа:
  - окно с настоящим `soundcloud.com/signin` (пароль не проходит через приложение)
  - ручной импорт cookies из браузера (Cookie-Editor / EditThisCookie), с автопарсингом форматов
  - «Войти» в верхней панели → выбор способа
- **Музыка** — лайки, загрузки, плейлисты, поиск треков / артистов / плейлистов
- **Плеер** — play/pause, seek, громкость, shuffle, повтор (все / один), очередь
- **Горячие клавиши** — `Space` играть/пауза, `Shift+←/→` переключение, `↑/↓` громкость, `M` mute, `Ctrl+F` поиск
- **Медиа-клавиши** и **системный трей** — сворачивается в трей, управление из контекстного меню
- **Четыре темы** — тёмная (SoundCloud Orange), светлая, фиолетовая, зелёная

## Стек

| Слой | Технология |
|------|-----------|
| Оболочка | Electron 33 |
| Фронтенд | React 18 + TypeScript + Vite |
| Стейт | Zustand |
| Аудио | Howler.js |
| Иконки | Phosphor Icons |
| Сборка | vite-plugin-electron |

## Как это работает без официального API

Официальный developers API SoundCloud закрыт для новичков, поэтому клиент ходит в **внутреннее API веб-версии** (`api-v2.soundcloud.com`):

1. `client_id` извлекается из JS-бандлов soundcloud.com и кешируется
2. запросы подписываются cookie сессии, полученной после входа
3. стрим трека — `api-v2.soundcloud.com/tracks/{id}/stream`

Авторизация:
- **через окно** — Electron открывает `soundcloud.com/signin`, после редиректа на `/discover` забирает cookies домена `.soundcloud.com`
- **вручную** — пользователь экспортирует cookies расширением и вставляет в окно; парсер понимает строку заголовка, JSON Cookie-Editor и Netscape `cookies.txt`

> ⚠️ Проект не является официальным клиентом SoundCloud. Использование внутреннего API может нарушать Terms of Service — используй на свой риск.

## Запуск

```bash
# установка
npm install

# сборка и запуск
npm run electron
```

Для разработки с горячей перезагрузкой:

```bash
npm run dev        # vite dev-сервер (только UI)
```

## Структура

```
electron/
  main.ts            # главное окно, трей, медиа-клавиши, окна входа, IPC
  preload.ts         # безопасный мост contextBridge
src/
  App.tsx            # роутинг видов, топ-бар, панель очереди
  components/
    Layout/          # каркас
    Sidebar/         # навигация, список плейлистов, переключатель тем
    Player/          # панель плеера, горячие клавиши
    Track/           # трек-строка и карточка
  pages/
    HomePage.tsx     # главная: лайки, артисты, плейлисты
    SearchPage.tsx   # поиск с debounce и вкладками
    LibraryPage.tsx  # лайки / загрузки с пагинацией
    AuthPage.tsx     # выбор способа входа
    ManualAuthPage.tsx # ручной импорт cookies
  stores/            # zustand: appStore, playerStore
  lib/
    soundcloud-api.ts # обёртка внутреннего API
  styles/
    themes.css       # четыре темы на CSS-переменных
```

## Дальше

- [ ] Свои плейлисты: создание, drag & drop
- [ ] Страница артиста и плейлиста с полным списком
- [ ] Лайк прямо из строки трека (POST в API)
- [ ] Мини-плеер
- [ ] Scrobbling Last.fm
- [ ] Автообновление (electron-updater)

## Лицензия

MIT
