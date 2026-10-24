// Минимальный клиент Discord Rich Presence.
//
// Discord RPC — локальный IPC: приложение подключается к именованному каналу
// discord-ipc-N и общается кадрами [длина][опкод][JSON]. Свой клиент вместо
// npm-пакета: протокол стабильный, а тянуть заброшенную зависимость в сборку
// не нужно. Работает только на Windows, где Discord держит эти каналы.

import net from "net";
import log from "electron-log";

const OPCODE_HANDSHAKE = 0;
const OPCODE_FRAME = 1;
const OPCODE_CLOSE = 2;
const OPCODE_PING = 3;
const OPCODE_PONG = 4;

const PIPE_ATTEMPTS = 10;
const RECONNECT_DELAY = 5000;
/** Как часто напоминаем Discord о нашей активности. */
const HEARTBEAT_INTERVAL = 60_000;

export interface DiscordActivity {
  details?: string;
  state?: string;
  largeText?: string;
  smallText?: string;
  largeImageKey?: string;
  largeImageText?: string;
  startTimestamp?: number;
}

export class DiscordRpc {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private clientId = "";
  private ready = false;
  private stopped = true;
  private attempts = 0;
  private activity: DiscordActivity | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private nonce = 0;

  /** Подключён ли Discord и принят ли handshake. */
  get isConnected(): boolean {
    return this.ready;
  }

  /** Подключается к Discord. clientId берётся из настроек приложения. */
  async connect(clientId: string): Promise<boolean> {
    this.stop();
    this.stopped = false;
    this.clientId = clientId;
    this.attempts = 0;

    // Discord держит только одну активность на аккаунт: если её заняло
    // другое приложение, наша пропадёт. Раз в минуту напоминаем о себе.
    this.heartbeat = setInterval(() => {
      if (this.ready) this.sendActivity();
    }, HEARTBEAT_INTERVAL);

    if (!clientId) {
      log.warn("Discord RPC: не задан Client ID");
      return false;
    }

    return this.openPipe(0);
  }

  /** Обновляет активность. null — очистить (пауза, ничего не играет). */
  setActivity(activity: DiscordActivity | null): void {
    this.activity = activity;
    this.sendActivity();
  }

  /** Полностью останавливает клиент. */
  stop(): void {
    this.stopped = true;
    this.ready = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }

    if (this.socket) {
      // Перед закрытием снимаем активность, чтобы не остался «призрак».
      try {
        this.sendActivity();
      } catch {
        // Канал уже мёртв — не страшно.
      }
      this.socket.destroy();
      this.socket = null;
    }

    this.buffer = Buffer.alloc(0);
  }

  // --- внутреннее ---

  private openPipe(index: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (index >= PIPE_ATTEMPTS) {
        log.info("Discord RPC: канал discord-ipc не найден — Discord не запущен?");
        resolve(false);
        return;
      }

      const pipePath = `\\\\.\\pipe\\discord-ipc-${index}`;
      const socket = net.connect(pipePath);

      const onError = (error: NodeJS.ErrnoException) => {
        socket.destroy();
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
          void this.openPipe(index + 1).then(resolve);
          return;
        }
        log.warn("Discord RPC: ошибка подключения:", error.message);
        resolve(false);
      };

      socket.once("error", onError);

      socket.once("connect", () => {
        socket.removeListener("error", onError);
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.ready = false;

        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("error", (error) => {
          log.warn("Discord RPC: сбой соединения:", error.message);
          this.ready = false;
        });
        socket.on("close", () => this.onClose());

        this.write(OPCODE_HANDSHAKE, { v: 1, client_id: this.clientId });
        log.info(`Discord RPC: подключение к ${pipePath}`);
        resolve(true);
      });
    });
  }

  private onClose(): void {
    this.ready = false;
    this.socket = null;

    if (this.stopped) return;

    // Discord закрыл соединение до handshake — скорее всего, неверный Client ID.
    if (this.attempts >= 2) {
      this.stopped = true;
      log.warn(
        "Discord RPC: соединение закрывается до handshake — проверьте Client ID в настройках"
      );
      return;
    }

    this.attempts += 1;

    // Discord перезапустили или канал закрылся — переподключаемся.
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) void this.openPipe(0);
    }, RECONNECT_DELAY);
  }

  private onData(chunk: Buffer | string): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);

    // Кадр Discord: [4 байта opcode][4 байта длины][данные].
    // Порядок именно такой — с обратным Discord отвечает «protocol error».
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + length) break;

      const body = this.buffer.subarray(8, 8 + length).toString("utf8");
      this.buffer = this.buffer.subarray(8 + length);

      this.handleFrame(opcode, body);
    }
  }

  private handleFrame(opcode: number, body: string): void {
    if (opcode === OPCODE_CLOSE) {
      this.ready = false;
      log.warn("Discord RPC: Discord закрыл соединение (проверьте Client ID)");
      return;
    }

    if (opcode === OPCODE_PING) {
      this.write(OPCODE_PONG, {});
      return;
    }

    if (opcode !== OPCODE_FRAME) return;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return;
    }

    const cmd = payload.cmd;
    const evt = payload.evt;

    if (cmd === "DISPATCH" && evt === "READY") {
      this.ready = true;
      this.attempts = 0;
      log.info("Discord RPC: Discord ответил, активность можно отправлять");
      this.sendActivity();
      return;
    }

    if (cmd === "SET_ACTIVITY") {
      const data = payload.data as { code?: string; message?: string } | undefined;
      if (data?.code) {
        log.warn("Discord RPC: SET_ACTIVITY отклонён —", data.code, data.message ?? "");
      }
    }
  }

  private sendActivity(): void {
    if (!this.ready || !this.socket) return;

    const activity = this.activity;
    this.nonce += 1;

    // Картинки и подписи живут во вложенном объекте assets: плоские поля
    // уровня activity Discord молча игнорирует, и обложки в профиле нет.
    const assets: Record<string, string> = {};
    if (activity?.largeImageKey) assets.large_image = activity.largeImageKey;
    const largeTooltip = activity?.largeImageText || activity?.largeText;
    if (largeTooltip) assets.large_text = largeTooltip;
    if (activity?.smallText) assets.small_text = activity.smallText;

    this.write(OPCODE_FRAME, {
      cmd: "SET_ACTIVITY",
      args: {
        pid: process.pid,
        activity: activity
          ? {
              details: activity.details,
              state: activity.state,
              ...(Object.keys(assets).length ? { assets } : {}),
              timestamps: activity.startTimestamp
                ? { start: activity.startTimestamp }
                : undefined,
            }
          : null,
      },
      nonce: String(this.nonce),
    });
  }

  private write(opcode: number, payload: unknown): void {
    if (!this.socket || this.socket.destroyed) return;

    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const header = Buffer.alloc(8);
    header.writeInt32LE(opcode, 0);
    header.writeInt32LE(body.length, 4);

    this.socket.write(Buffer.concat([header, body]));
  }
}
