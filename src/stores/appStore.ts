import { create } from "zustand";
import { SCUser, SCTrack, SCPlaylist } from "../types/soundcloud";
import {
  CustomTheme,
  applyTheme,
  loadCustomThemes,
  saveCustomThemes,
  themeBase,
  themeDataId,
} from "../lib/themes";

export type Theme = string;
export type View = "home" | "wave" | "search" | "library" | "likes" | "uploads" | "playlist" | "artist";

interface AppState {
  // Тема
  theme: Theme;
  customThemes: CustomTheme[];
  setTheme: (t: Theme) => void;
  saveCustomTheme: (theme: CustomTheme) => void;
  deleteCustomTheme: (id: string) => void;

  // Текущий вид
  view: View;
  setView: (v: View) => void;

  // Параметры навигации
  currentPlaylistId: number | null;
  currentArtistId: number | null;
  searchQuery: string;
  setSearchQuery: (q: string) => void;

  // Авторизация
  isLoggedIn: boolean;
  currentUser: SCUser | null;
  setLoggedIn: (v: boolean, user?: SCUser) => void;

  // Данные библиотеки
  likedTracks: SCTrack[];
  uploadedTracks: SCTrack[];
  playlists: SCPlaylist[];
  setLikedTracks: (t: SCTrack[]) => void;
  setUploadedTracks: (t: SCTrack[]) => void;
  setPlaylists: (p: SCPlaylist[]) => void;
  /** Лайк или снятие лайка трека. */
  toggleLike: (track: SCTrack) => Promise<void>;
  likeError: string | null;
  clearLikeError: () => void;

  // Sidebar collapsed
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (value: boolean) => void;

  // Панель настроек
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;

  // Queue panel
  queueVisible: boolean;
  toggleQueue: () => void;

  // Панель текста песни
  lyricsVisible: boolean;
  toggleLyrics: () => void;
  closeLyrics: () => void;

  // Караоке на весь экран
  karaokeFullscreen: boolean;
  openKaraokeFullscreen: () => void;
  closeKaraokeFullscreen: () => void;
  toggleKaraokeFullscreen: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  theme: "dark",
  customThemes: loadCustomThemes(),

  setTheme: (theme) => {
    applyTheme(theme, get().customThemes);
    window.electronAPI?.setTheme(theme, themeBase(theme, get().customThemes));
    set({ theme });
  },

  saveCustomTheme: (theme) => {
    const themes = get().customThemes;
    const exists = themes.some((item) => item.id === theme.id);
    const next = exists
      ? themes.map((item) => (item.id === theme.id ? theme : item))
      : [...themes, theme];

    saveCustomThemes(next);
    set({ customThemes: next });
    get().setTheme(themeDataId(theme));
  },

  deleteCustomTheme: (id) => {
    const next = get().customThemes.filter((theme) => theme.id !== id);
    saveCustomThemes(next);
    set({ customThemes: next });

    if (get().theme === `custom:${id}`) {
      get().setTheme("dark");
    }
  },

  view: "home",
  setView: (view) => set({ view, currentPlaylistId: null, currentArtistId: null }),

  currentPlaylistId: null,
  currentArtistId: null,
  searchQuery: "",
  setSearchQuery: (searchQuery) => set({ searchQuery }),

  isLoggedIn: false,
  currentUser: null,
  setLoggedIn: (isLoggedIn, currentUser) => set({ isLoggedIn, currentUser }),

  likedTracks: [],
  uploadedTracks: [],
  playlists: [],
  setLikedTracks: (likedTracks) => set({ likedTracks }),
  setUploadedTracks: (uploadedTracks) => set({ uploadedTracks }),
  setPlaylists: (playlists) => set({ playlists }),

  likeError: null,
  clearLikeError: () => set({ likeError: null }),

  toggleLike: async (track) => {
    const state = get();
    const liked = state.likedTracks.some((item) => item.id === track.id);

    const res = await window.electronAPI?.toggleLike(track.id, !liked);

    if (!res?.ok) {
      set({ likeError: res?.error ?? "Не удалось изменить лайк" });
      return;
    }

    set({
      likeError: null,
      likedTracks: liked
        ? state.likedTracks.filter((item) => item.id !== track.id)
        : [track, ...state.likedTracks],
    });
  },

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),

  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  queueVisible: false,
  // Очередь и текст занимают одно и то же место справа,
  // поэтому открытие одной панели закрывает другую.
  toggleQueue: () => set((s) => ({ queueVisible: !s.queueVisible, lyricsVisible: false })),

  lyricsVisible: false,
  toggleLyrics: () => set((s) => ({ lyricsVisible: !s.lyricsVisible, queueVisible: false })),
  closeLyrics: () => set({ lyricsVisible: false }),

  karaokeFullscreen: false,
  openKaraokeFullscreen: () => set({ karaokeFullscreen: true }),
  closeKaraokeFullscreen: () => set({ karaokeFullscreen: false }),
  toggleKaraokeFullscreen: () =>
    set((s) => ({ karaokeFullscreen: !s.karaokeFullscreen })),
}));