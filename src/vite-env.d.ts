export {};

declare global {
  interface Window {
    electronAPI: {
      getConfig: () => Promise<{
        theme: string;
        volume: number;
        loggedIn: boolean;
      }>;
      setTheme: (theme: string) => Promise<boolean>;
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
      logout: () => Promise<boolean>;
      scRequest: (
        path: string,
        params?: Record<string, string | number>
      ) => Promise<unknown>;
      resolveStream: (
        trackId: number
      ) => Promise<{ url: string; protocol: string; duration: number }>;
      getClientId: () => Promise<string>;
      showWindow: () => Promise<boolean>;
      minimizeToTray: () => Promise<boolean>;
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
