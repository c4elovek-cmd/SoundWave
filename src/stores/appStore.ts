import { create } from "zustand";
import { SCUser, SCTrack, SCPlaylist } from "../types/soundcloud";

export type Theme = "dark" | "light" | "purple" | "green";
export type View = "home" | "search" | "library" | "likes" | "uploads" | "playlist" | "artist";

interface AppState {
  // Тема
  theme: Theme;
  setTheme: (t: Theme) => void;

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

  // Sidebar collapsed
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  // Queue panel
  queueVisible: boolean;
  toggleQueue: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  theme: "dark",
  setTheme: (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    window.electronAPI?.setTheme(theme);
    set({ theme });
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

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  queueVisible: false,
  toggleQueue: () => set((s) => ({ queueVisible: !s.queueVisible })),
}));