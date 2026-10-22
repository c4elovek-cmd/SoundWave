import { create } from "zustand";
import { scApi } from "../lib/soundcloud-api";
import { errorText } from "../lib/errorText";
import { useAppStore } from "./appStore";
import { SCPlaylist, SCTrack, SCUser } from "../types/soundcloud";

/**
 * Данные главной страницы живут в сторе, а не в компоненте.
 *
 * Причина: HomePage размонтируется при каждом переходе на другую страницу.
 * Если держать данные в локальном состоянии, при возврате на главную они
 * сбрасываются, `loading` снова становится `true` — и пользователь видит
 * скелетоны, которые тут же сменяются контентом. Кеш в сторе убирает это
 * мелькание: скелетоны показываются только при первой загрузке.
 */
interface HomeState {
  recommended: SCTrack[];
  artists: SCUser[];
  playlists: SCPlaylist[];
  trending: SCTrack[];

  /** Идёт первая загрузка — только тогда рисуем скелетоны. */
  loading: boolean;
  trendingLoading: boolean;
  error: string | null;
  /** Когда данные обновлялись в последний раз (мс). */
  loadedAt: number | null;

  load: (options?: { force?: boolean }) => Promise<void>;
  loadTrending: () => Promise<void>;
  reset: () => void;
}

export const useHomeStore = create<HomeState>((set, get) => ({
  recommended: [],
  artists: [],
  playlists: [],
  trending: [],
  // Первая загрузка: скелетоны уместны, пока данных ещё нет.
  loading: true,
  trendingLoading: true,
  error: null,
  loadedAt: null,

  load: async (options) => {
    const { isLoggedIn, currentUser, setLikedTracks } = useAppStore.getState();

    if (!isLoggedIn) {
      set({ loading: false });
      return;
    }

    const force = options?.force ?? false;

    // Скелетоны — только до первой успешной загрузки. Дальше данные уже
    // в сторе, и обновление идёт молча, без мигания.
    if (get().loadedAt === null) set({ loading: true });
    set({ error: null });

    try {
      const userId = currentUser?.id;
      const results = await Promise.allSettled([
        scApi.getMyLikes(userId, 20),
        scApi.getMyFollowings(userId, 12),
        scApi.getMyPlaylists(userId, 10),
      ]);

      if (results[0].status === "fulfilled") {
        const items = (results[0].value as any).collection ?? [];
        const tracks: SCTrack[] = items.map((i: any) => i.track ?? i).filter(Boolean);
        set({ recommended: tracks });
        setLikedTracks(tracks);
      }
      if (results[1].status === "fulfilled") {
        set({ artists: (results[1].value as any).collection ?? [] });
      }
      if (results[2].status === "fulfilled") {
        const items = (results[2].value as any).collection ?? [];
        set({ playlists: items.map((i: any) => i.playlist ?? i).filter(Boolean) });
      }

      if (results.every((r) => r.status === "rejected")) {
        set({ error: "Не удалось загрузить данные SoundCloud" });
      } else {
        set({ loadedAt: Date.now() });
      }

      // Явное обновление по кнопке: даже если данные не изменились,
      // сообщаем об этом через дату загрузки.
      if (force) set({ loadedAt: Date.now() });
    } catch (e) {
      set({ error: errorText(e, "Ошибка загрузки") });
    } finally {
      set({ loading: false });
    }
  },

  loadTrending: async () => {
    if (get().trending.length > 0) {
      // Уже загружено — обновляем в фоне, без скелетонов.
      set({ trendingLoading: false });
    } else {
      set({ trendingLoading: true });
    }

    try {
      const res = await scApi.getTrending(20);
      set({ trending: res.collection ?? [] });
    } catch {
      // Для гостя популярное — необязательный блок: молча оставляем пусто.
    } finally {
      set({ trendingLoading: false });
    }
  },

  reset: () =>
    set({
      // Чистим только данные аккаунта: «Популярное» нужно и гостю.
      recommended: [],
      artists: [],
      playlists: [],
      loading: false,
      error: null,
      loadedAt: null,
    }),
}));
