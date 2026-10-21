export {};

declare global {
  interface Window {
    electronAPI: {
      getConfig: () => Promise<{
        theme: string;
        volume: number;
        loggedIn: boolean;
        version?: string;
      }>;
      setTheme: (theme: string, base?: string) => Promise<boolean>;
      setVolume: (volume: number) => Promise<boolean>;
      openAuthWindow: () => Promise<boolean>;
      openRealLogin: () => Promise<boolean>;
      openManualLogin: () => Promise<boolean>;
      showAuthChoice: () => Promise<boolean>;
      closeLoginWindow: () => Promise<boolean>;
      importCookies: (raw: string) => Promise<{ ok: boolean; count?: number; error?: string }>;
      dumpSessionCookies: () => Promise<string>;
      restoreSession: () => Promise<{ loggedIn: boolean; cookies: string }>;
      checkLogin: () => Promise<boolean>;
      hasSession: () => Promise<boolean>;
      logout: () => Promise<boolean>;
      scRequest: (
        path: string,
        params?: Record<string, string | number>
      ) => Promise<unknown>;
      resolveStream: (
        trackId: number
      ) => Promise<{ url: string; protocol: string; duration: number }>;
      getClientId: () => Promise<string>;
      scWrite: (
        method: string,
        path: string,
        params?: Record<string, string | number>
      ) => Promise<unknown>;
      toggleLike: (
        trackId: number,
        like: boolean
      ) => Promise<{ ok: boolean; liked?: boolean; error?: string }>;
      getLyrics: (
        title: string,
        artist: string,
        description?: string
      ) => Promise<{
        found: boolean;
        title?: string;
        artist?: string;
        url?: string;
        lyrics?: string;
        error?: string;
      }>;
      openExternal: (url: string) => Promise<boolean>;
      getSyncedLyrics: (
        title: string,
        artist: string,
        duration: number
      ) => Promise<{
        found: boolean;
        syncedLyrics?: string;
        title?: string;
        artist?: string;
        duration?: number;
        error?: string;
      }>;
      onAgentRequest: (
        callback: (request: { id: string; type: string; payload?: unknown }) => void
      ) => () => void;
      sendAgentResponse: (response: {
        id: string;
        ok: boolean;
        data?: unknown;
        error?: string;
        code?: string;
      }) => void;
      showWindow: () => Promise<boolean>;
      minimizeToTray: () => Promise<boolean>;
      setFullscreen: (value: boolean) => Promise<boolean>;
      onFullscreenChanged: (callback: (value: boolean) => void) => () => void;
      windowMinimize: () => Promise<boolean>;
      windowToggleMaximize: () => Promise<boolean>;
      windowIsMaximized: () => Promise<boolean>;
      windowClose: () => Promise<boolean>;
      onWindowMaximizedChanged: (callback: (value: boolean) => void) => () => void;
      listCustomFonts: () => Promise<
        {
          id: string;
          name: string;
          family: string;
          display: string;
          weight: number;
          file: string;
          mime: string;
          dataUrl: string;
        }[]
      >;
      importCustomFont: () => Promise<{
        id: string;
        name: string;
        family: string;
        display: string;
        weight: number;
        file: string;
        mime: string;
        dataUrl: string;
      } | null>;
      removeCustomFont: (family: string) => Promise<boolean>;
      discordStatus: () => Promise<{
        enabled: boolean;
        clientId: string;
        builtIn: boolean;
        largeImage: string;
        connected: boolean;
      }>;
      setDiscordConfig: (config: {
        enabled?: boolean;
        clientId?: string;
        largeImage?: string;
      }) => Promise<{
        enabled: boolean;
        clientId: string;
        builtIn: boolean;
        largeImage: string;
        connected: boolean;
      }>;
      setDiscordPresence: (
        presence: {
          details?: string;
          state?: string;
          largeText?: string;
          smallText?: string;
          startTimestamp?: number;
        } | null
      ) => Promise<boolean>;
      agentApiConfig: (config?: {
        enabled?: boolean;
        port?: number;
        regenerateToken?: boolean;
      }) => Promise<{
        enabled: boolean;
        port: number;
        token: string;
        url: string | null;
      }>;
      openUserData: () => Promise<boolean>;
      setCloseToTray: (value: boolean) => Promise<boolean>;
      logAction: (
        action: string,
        details?: Record<string, unknown>
      ) => Promise<boolean>;
      onAuthSuccess: (callback: (cookies: string) => void) => void;
      onLoggedOut: (callback: () => void) => void;
      onTrayPlayPause: (callback: () => void) => void;
      onTrayNext: (callback: () => void) => void;
      onTrayPrev: (callback: () => void) => void;
      onMediaPlayPause: (callback: () => void) => void;
      onMediaNext: (callback: () => void) => void;
      onMediaPrev: (callback: () => void) => void;
      removeAllListeners: (channel: string) => void;
    };
  }
}
