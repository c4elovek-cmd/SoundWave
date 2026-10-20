// Локальный HTTP API для агентов.
//
// Сервер слушает только 127.0.0.1, требует Bearer-токен и проксирует
// команды в renderer: там живут плеер, очередь, поиск и тексты.
// Токен и порт сохраняются в electron-store, а готовая информация для
// агента пишется в agent-api.json в папке данных приложения.

import { app, ipcMain, BrowserWindow } from "electron";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import log from "electron-log";

export interface AgentApiOptions {
  getWindow: () => BrowserWindow | null;
  port: number;
  token: string;
}

export interface AgentApiHandle {
  port: number;
  url: string;
  close: () => void;
}

interface RendererRequest {
  id: string;
  type: string;
  payload?: unknown;
}

interface RendererResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class AgentApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const pending = new Map<string, PendingRequest>();
let requestSeq = 0;
let ipcRegistered = false;

/** Один раз подписывается на ответы renderer-а. */
export function registerAgentIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on("agent-response", (_event, response: RendererResponse) => {
    const entry = pending.get(response?.id);
    if (!entry) return;

    clearTimeout(entry.timer);
    pending.delete(response.id);

    if (response.ok) {
      entry.resolve(response.data);
    } else {
      entry.reject(
        new AgentApiError(
          response.code === "bad_request" ? 400 : response.code === "not_found" ? 404 : 500,
          response.error || "Ошибка в приложении",
          response.code || "renderer_error"
        )
      );
    }
  });
}

function askRenderer(
  win: BrowserWindow | null,
  type: string,
  payload?: unknown
): Promise<unknown> {
  if (!win || win.isDestroyed()) {
    return Promise.reject(
      new AgentApiError(503, "Окно приложения недоступно", "renderer_unavailable")
    );
  }

  const id = `a${Date.now().toString(36)}${(++requestSeq).toString(36)}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new AgentApiError(504, "Приложение не ответило за 20 секунд", "timeout"));
    }, 20_000);

    pending.set(id, { resolve, reject, timer });
    win.webContents.send("agent-request", { id, type, payload } satisfies RendererRequest);
  });
}

/* ==================== HTTP-обвязка ==================== */

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4783;
const PORT_ATTEMPTS = 10;
const MAX_BODY = 1_000_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

function sendOk(res: ServerResponse, data: unknown): void {
  sendJson(res, 200, { ok: true, data });
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string
): void {
  sendJson(res, status, { ok: false, error: { code, message } });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) {
      throw new AgentApiError(413, "Тело запроса больше 1 МБ", "payload_too_large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AgentApiError(400, "Тело запроса должно быть JSON-объектом", "bad_json");
  }
}

function bearerToken(req: IncomingMessage): string {
  const header = String(req.headers.authorization ?? "");
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return String(req.headers["x-soundwave-token"] ?? "").trim();
}

function openApiSchema(port: number) {
  const track = {
    type: "object",
    properties: {
      id: { type: "integer" },
      title: { type: "string" },
      artist: { type: ["string", "null"] },
      artistId: { type: ["integer", "null"] },
      artwork: { type: ["string", "null"] },
      duration: { type: "number", description: "Длительность в секундах" },
      genre: { type: ["string", "null"] },
      permalink: { type: ["string", "null"] },
      playable: { type: "boolean" },
      likes: { type: ["integer", "null"] },
      plays: { type: ["integer", "null"] },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "SoundWave Agent API",
      version: app.getVersion(),
      description:
        "Локальное управление плеером SoundWave. Сервер слушает только 127.0.0.1. " +
        "Все защищённые запросы требуют заголовок Authorization: Bearer <token>. " +
        "Токен и фактический порт лежат в agent-api.json в папке данных приложения.",
    },
    servers: [{ url: `http://${HOST}:${port}` }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas: { Track: track },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/health": {
        get: {
          summary: "Проверка доступности",
          security: [],
          responses: { "200": { description: "Приложение запущено" } },
        },
      },
      "/api/state": {
        get: {
          summary: "Текущее состояние плеера и интерфейса",
          responses: { "200": { description: "Состояние" } },
        },
      },
      "/api/search": {
        get: {
          summary: "Поиск в SoundCloud",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            {
              name: "type",
              in: "query",
              schema: { type: "string", enum: ["tracks", "users", "playlists"], default: "tracks" },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
            },
          ],
          responses: { "200": { description: "Результаты поиска" } },
        },
      },
      "/api/play": {
        post: {
          summary: "Включить трек по id, ссылке или поисковому запросу",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    url: { type: "string" },
                    query: { type: "string" },
                  },
                },
                examples: {
                  byQuery: { value: { query: "IC3PEAK Смерти больше нет" } },
                  byId: { value: { id: 123456789 } },
                },
              },
            },
          },
          responses: { "200": { description: "Трек поставлен" } },
        },
      },
      "/api/control": {
        post: {
          summary: "Управление воспроизведением",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["action"],
                  properties: {
                    action: {
                      type: "string",
                      enum: [
                        "play",
                        "pause",
                        "toggle",
                        "next",
                        "prev",
                        "seek",
                        "volume",
                        "mute",
                        "unmute",
                        "shuffle",
                        "repeat",
                      ],
                    },
                    seconds: { type: "number", description: "Для seek — секунда трека" },
                    percent: { type: "number", description: "Для seek — доля 0..1" },
                    value: {
                      description: "Громкость 0..1, shuffle true/false, repeat off/all/one",
                    },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Новое состояние" } },
        },
      },
      "/api/queue": {
        get: { summary: "Очередь", responses: { "200": { description: "Очередь" } } },
        post: {
          summary: "Добавить, удалить или очистить очередь",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["action"],
                  properties: {
                    action: { type: "string", enum: ["add", "remove", "clear"] },
                    trackId: { type: "integer" },
                    index: { type: "integer" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Очередь" } },
        },
      },
      "/api/lyrics": {
        get: {
          summary: "Текст и синхронизация трека",
          parameters: [
            { name: "trackId", in: "query", schema: { type: "integer" } },
            {
              name: "synced",
              in: "query",
              schema: { type: "string", enum: ["0", "1"], default: "1" },
            },
          ],
          responses: { "200": { description: "Текст" } },
        },
      },
      "/api/likes": {
        get: {
          summary: "Лайкнутые треки",
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            },
          ],
          responses: { "200": { description: "Треки" } },
        },
      },
      "/api/playlists": {
        get: {
          summary: "Плейлисты пользователя",
          responses: { "200": { description: "Плейлисты" } },
        },
      },
      "/api/playlist/{id}": {
        get: {
          summary: "Плейлист с треками",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": { description: "Плейлист" } },
        },
      },
      "/api/track/{id}": {
        get: {
          summary: "Информация о треке",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": { description: "Трек" } },
        },
      },
      "/api/navigate": {
        post: {
          summary: "Перейти на экран приложения",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["view"],
                  properties: {
                    view: {
                      type: "string",
                      enum: ["home", "wave", "search", "library", "likes", "uploads", "playlist", "artist"],
                    },
                    query: { type: "string" },
                    playlistId: { type: "integer" },
                    artistId: { type: "integer" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Экран открыт" } },
        },
      },
      "/api/show": {
        post: { summary: "Показать и сфокусировать окно", responses: { "200": { description: "Окно показано" } } },
      },
      "/api/karaoke": {
        post: {
          summary: "Открыть или закрыть караоке на весь экран",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean", default: true },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Режим караоке переключён" } },
        },
      },
    },
  };
}

/* ==================== Сервер ==================== */

async function listenOnFreePort(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  let lastError: unknown = null;

  for (let offset = 0; offset < PORT_ATTEMPTS; offset++) {
    const port = DEFAULT_PORT + offset;
    const server = createServer((req, res) => void handler(req, res));

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, HOST);
      });

      return server;
    } catch (error) {
      lastError = error;
      server.close();
      if ((error as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Не удалось занять порт ${DEFAULT_PORT}–${DEFAULT_PORT + PORT_ATTEMPTS - 1}`);
}

export async function startAgentApi(options: AgentApiOptions): Promise<AgentApiHandle> {
  registerAgentIpc();

  const infoPath = path.join(app.getPath("userData"), "agent-api.json");
  let actualPort = options.port || DEFAULT_PORT;

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const host = String(req.headers.host ?? "");
      const allowedHosts = new Set([
        `${HOST}:${actualPort}`,
        `localhost:${actualPort}`,
        `[::1]:${actualPort}`,
      ]);

      if (!allowedHosts.has(host)) {
        sendError(res, 403, "forbidden_host", "Неверный заголовок Host");
        return;
      }

      const url = new URL(req.url ?? "/", `http://${host}`);
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      const method = (req.method ?? "GET").toUpperCase();

      // Публичные маршруты: проверка доступности и схема.
      if (method === "GET" && pathname === "/api/health") {
        sendOk(res, {
          app: "SoundWave",
          version: app.getVersion(),
          ready: Boolean(options.getWindow() && !options.getWindow()?.isDestroyed()),
          uptime: Math.round(process.uptime()),
          serverTime: new Date().toISOString(),
        });
        return;
      }

      if (method === "GET" && pathname === "/api/openapi.json") {
        sendOk(res, openApiSchema(actualPort));
        return;
      }

      if (method === "GET" && (pathname === "/" || pathname === "/api")) {
        sendOk(res, {
          name: "SoundWave Agent API",
          version: app.getVersion(),
          auth: "Authorization: Bearer <token>",
          tokenFile: infoPath,
          openapi: `http://${HOST}:${actualPort}/api/openapi.json`,
          endpoints: [
            "GET /api/health",
            "GET /api/state",
            "GET /api/search?q=...&type=tracks|users|playlists",
            "POST /api/play {id|url|query}",
            "POST /api/control {action, value?, seconds?}",
            "GET|POST /api/queue",
            "GET /api/lyrics?trackId=...&synced=1",
            "GET /api/likes?limit=20",
            "GET /api/playlists",
            "GET /api/playlist/{id}",
            "GET /api/track/{id}",
            "POST /api/navigate {view}",
            "POST /api/show",
            "POST /api/karaoke {enabled}",
          ],
        });
        return;
      }

      if (bearerToken(req) !== options.token) {
        sendError(
          res,
          401,
          "unauthorized",
          `Нужен заголовок Authorization: Bearer <token>. Токен: ${infoPath}`
        );
        return;
      }

      if (method === "GET" && pathname === "/api/state") {
        sendOk(res, await askRenderer(options.getWindow(), "state"));
        return;
      }

      if (method === "GET" && pathname === "/api/search") {
        const query = (url.searchParams.get("q") ?? "").trim();
        if (query.length < 2) {
          throw new AgentApiError(400, "Параметр q должен быть не короче 2 символов", "bad_request");
        }

        const type = url.searchParams.get("type") ?? "tracks";
        if (!["tracks", "users", "playlists"].includes(type)) {
          throw new AgentApiError(400, "type: tracks, users или playlists", "bad_request");
        }

        const limitRaw = Number(url.searchParams.get("limit") ?? 10);
        const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, Math.round(limitRaw))) : 10;

        sendOk(
          res,
          await askRenderer(options.getWindow(), "search", { query, type, limit })
        );
        return;
      }

      if (method === "POST" && pathname === "/api/play") {
        const body = await readJson(req);
        if (!body.id && !body.url && !body.query) {
          throw new AgentApiError(400, "Нужен id, url или query", "bad_request");
        }
        sendOk(res, await askRenderer(options.getWindow(), "play", body));
        return;
      }

      if (method === "POST" && pathname === "/api/control") {
        const body = await readJson(req);
        if (typeof body.action !== "string") {
          throw new AgentApiError(400, "Нужно поле action", "bad_request");
        }
        sendOk(res, await askRenderer(options.getWindow(), "control", body));
        return;
      }

      if (method === "GET" && pathname === "/api/queue") {
        sendOk(res, await askRenderer(options.getWindow(), "queue", { action: "list" }));
        return;
      }

      if (method === "POST" && pathname === "/api/queue") {
        const body = await readJson(req);
        sendOk(res, await askRenderer(options.getWindow(), "queue", body));
        return;
      }

      if (method === "GET" && pathname === "/api/lyrics") {
        const trackIdRaw = url.searchParams.get("trackId");
        const trackId = trackIdRaw ? Number(trackIdRaw) : undefined;
        if (trackIdRaw && !Number.isFinite(trackId)) {
          throw new AgentApiError(400, "trackId должен быть числом", "bad_request");
        }
        sendOk(
          res,
          await askRenderer(options.getWindow(), "lyrics", {
            trackId,
            synced: url.searchParams.get("synced") !== "0",
          })
        );
        return;
      }

      if (method === "GET" && pathname === "/api/likes") {
        const limitRaw = Number(url.searchParams.get("limit") ?? 20);
        const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.round(limitRaw))) : 20;
        sendOk(res, await askRenderer(options.getWindow(), "likes", { limit }));
        return;
      }

      if (method === "GET" && pathname === "/api/playlists") {
        sendOk(res, await askRenderer(options.getWindow(), "playlists", {}));
        return;
      }

      const playlistMatch = /^\/api\/playlist\/(\d+)$/.exec(pathname);
      if (method === "GET" && playlistMatch) {
        sendOk(
          res,
          await askRenderer(options.getWindow(), "playlist", { id: Number(playlistMatch[1]) })
        );
        return;
      }

      const trackMatch = /^\/api\/track\/(\d+)$/.exec(pathname);
      if (method === "GET" && trackMatch) {
        sendOk(
          res,
          await askRenderer(options.getWindow(), "track", { id: Number(trackMatch[1]) })
        );
        return;
      }

      if (method === "POST" && pathname === "/api/navigate") {
        const body = await readJson(req);
        if (typeof body.view !== "string") {
          throw new AgentApiError(400, "Нужно поле view", "bad_request");
        }
        sendOk(res, await askRenderer(options.getWindow(), "navigate", body));
        return;
      }

      if (method === "POST" && pathname === "/api/show") {
        sendOk(res, await askRenderer(options.getWindow(), "show", {}));
        return;
      }

      if (method === "POST" && pathname === "/api/karaoke") {
        const body = await readJson(req);
        sendOk(
          res,
          await askRenderer(options.getWindow(), "karaoke", {
            enabled: body.enabled !== false,
          })
        );
        return;
      }

      sendError(res, 404, "not_found", `Неизвестный маршрут: ${method} ${pathname}`);
    } catch (error) {
      if (error instanceof AgentApiError) {
        sendError(res, error.status, error.code, error.message);
        return;
      }

      const message = error instanceof Error ? error.message : "Внутренняя ошибка";
      log.error("Agent API:", error);
      sendError(res, 500, "internal_error", message);
    }
  };

  const server = await listenOnFreePort(handler);
  const address = server.address();
  actualPort = typeof address === "object" && address ? address.port : actualPort;

  const url = `http://${HOST}:${actualPort}`;
  const info = {
    name: "SoundWave Agent API",
    url,
    token: options.token,
    authHeader: "Authorization: Bearer <token>",
    openapi: `${url}/api/openapi.json`,
    health: `${url}/api/health`,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  try {
    writeFileSync(infoPath, JSON.stringify(info, null, 2), "utf8");
  } catch (error) {
    log.warn("Agent API: не удалось записать agent-api.json:", error);
  }

  log.info(`Agent API слушает ${url}`);
  log.info(`Agent API: данные для агента — ${infoPath}`);

  return {
    port: actualPort,
    url,
    close: () => {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new AgentApiError(503, "Приложение закрывается", "shutdown"));
        pending.delete(id);
      }
      server.close();
      try {
        unlinkSync(infoPath);
      } catch {
        // Файла уже нет — не страшно.
      }
      log.info("Agent API остановлен");
    },
  };
}
