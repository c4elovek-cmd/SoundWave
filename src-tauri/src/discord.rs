//! Discord Rich Presence — свой клиент канала `discord-ipc-N`.
//!
//! Discord RPC — локальный IPC: именованный канал `\\.\pipe\discord-ipc-N`,
//! кадры вида `[opcode][длина][JSON]`. Порядок именно такой — с обратным
//! Discord отвечает «protocol error».
//!
//! Библиотеки не используем: в Rust это работает напрямую с каналом.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

const OPCODE_HANDSHAKE: i32 = 0;
const OPCODE_FRAME: i32 = 1;
const OPCODE_CLOSE: i32 = 2;
const OPCODE_PING: i32 = 3;
const OPCODE_PONG: i32 = 4;

/// Сколько каналов перебираем, прежде чем сдаться.
const PIPE_ATTEMPTS: u32 = 10;
/// Пауза перед переподключением, если Discord перезапустили.
const RECONNECT_DELAY: Duration = Duration::from_secs(5);
/// Как часто повторяем активность: Discord держит её 60 секунд.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);

/// Client ID приложения SoundWave в Discord — вшит в сборку.
pub const DEFAULT_DISCORD_CLIENT_ID: &str = "1562164443893211307";
/// Ассет по умолчанию для обложки в профиле.
pub const DEFAULT_DISCORD_ASSET: &str = "wave";

/// Активность, которую показываем в профиле.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordActivity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub small_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_image_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_image_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_timestamp: Option<i64>,
}

/// Состояние подключения и текущая активность.
#[derive(Default)]
struct Inner {
    client_id: String,
    ready: bool,
    activity: Option<DiscordActivity>,
    nonce: u64,
    /// Канал, куда складываются новые активности.
    sender: Option<tokio::sync::mpsc::UnboundedSender<Option<DiscordActivity>>>,
}

/// Клиент Discord RPC.
#[derive(Clone, Default)]
pub struct DiscordRpc {
    inner: Arc<Mutex<Inner>>,
}

impl DiscordRpc {
    pub fn new() -> Self {
        Self::default()
    }

    /// Подключён ли Discord.
    pub fn is_connected(&self) -> bool {
        self.inner.lock().map(|s| s.ready).unwrap_or(false)
    }

    /// Подключается к Discord. client_id пустой — подключения не будет.
    pub fn connect(&self, client_id: &str) {
        self.stop();

        if client_id.trim().is_empty() {
            return;
        }

        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        let inner = self.inner.clone();
        let client_id = client_id.to_string();

        if let Ok(mut state) = self.inner.lock() {
            state.client_id = client_id.clone();
            state.ready = false;
            state.sender = Some(sender.clone());
        }

        let task_inner = inner.clone();
        tauri::async_runtime::spawn(async move {
            run_client(client_id, receiver, task_inner).await;
        });
    }

    /// Показывает активность. None — убрать активность.
    pub fn set_activity(&self, activity: Option<DiscordActivity>) {
        let sender = match self.inner.lock() {
            Ok(mut state) => {
                state.activity = activity.clone();
                state.sender.clone()
            }
            Err(_) => None,
        };

        if let Some(sender) = sender {
            let _ = sender.send(activity);
        }
    }

    /// Останавливает подключение.
    pub fn stop(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.ready = false;
            state.sender = None;
            state.activity = None;
        }
    }
}

/// Собирает кадр Discord: [opcode][длина][данные].
fn encode_frame(opcode: i32, payload: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(payload).unwrap_or_else(|_| b"{}".to_vec());

    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend_from_slice(&opcode.to_le_bytes());
    frame.extend_from_slice(&(body.len() as i32).to_le_bytes());
    frame.extend_from_slice(&body);
    frame
}

/// Читает кадры из буфера. Возвращает список готовых кадров и остаток буфера.
fn take_frames(buffer: &mut Vec<u8>) -> Vec<(i32, Value)> {
    let mut frames = Vec::new();

    while buffer.len() >= 8 {
        let opcode = i32::from_le_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]);
        let length = i32::from_le_bytes([buffer[4], buffer[5], buffer[6], buffer[7]]);

        if length < 0 || buffer.len() < 8 + length as usize {
            break;
        }

        let body = serde_json::from_slice::<Value>(&buffer[8..8 + length as usize]).ok();
        buffer.drain(..8 + length as usize);

        if let Some(value) = body {
            frames.push((opcode, value));
        }
    }

    frames
}

/// Переподключается, пока не найдёт канал Discord.
#[cfg(windows)]
async fn open_pipe(client_id: &str) -> Option<tokio::net::windows::named_pipe::NamedPipeClient> {
    use tokio::net::windows::named_pipe::ClientOptions;

    for index in 0..PIPE_ATTEMPTS {
        let path = format!(r"\\.\pipe\discord-ipc-{index}");

        match ClientOptions::new().open(&path) {
            Ok(pipe) => return Some(pipe),
            Err(_) => continue,
        }
    }

    let _ = client_id;
    None
}

#[cfg(not(windows))]
async fn open_pipe(_client_id: &str) -> Option<()> {
    None
}

/// Основной цикл клиента: подключение, чтение кадров, активность, heartbeat.
async fn run_client(
    client_id: String,
    mut activity_rx: tokio::sync::mpsc::UnboundedReceiver<Option<DiscordActivity>>,
    inner: Arc<Mutex<Inner>>,
) {
    let mut attempts = 0u32;

    loop {
        let Some(pipe) = open_pipe(&client_id).await else {
            // Discord не запущен — ждём и пробуем снова.
            tokio::time::sleep(RECONNECT_DELAY).await;
            continue;
        };

        let (mut reader, mut writer) = tokio::io::split(pipe);

        // Handshake: Discord ждёт его, иначе закрывает канал.
        let handshake = json!({ "v": 1, "client_id": client_id });
        if writer.write_all(&encode_frame(OPCODE_HANDSHAKE, &handshake)).await.is_err() {
            tokio::time::sleep(RECONNECT_DELAY).await;
            continue;
        }

        if let Ok(mut state) = inner.lock() {
            state.ready = false;
        }

        // Чтение кадров — отдельной задачей, чтобы select! не терял данные.
        let (frame_tx, mut frame_rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 8192];

            loop {
                let read = match tokio::io::AsyncReadExt::read(&mut reader, &mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };

                buffer.extend_from_slice(&chunk[..read]);
                for (opcode, payload) in take_frames(&mut buffer) {
                    if frame_tx.send((opcode, payload)).is_err() {
                        return;
                    }
                }
            }
        });

        let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
        heartbeat.tick().await;

        let mut closed = false;

        loop {
            tokio::select! {
                frame = frame_rx.recv() => {
                    match frame {
                        Some((opcode, payload)) => {
                            match handle_frame(opcode, &payload, &inner) {
                                FrameAction::None => {}
                                FrameAction::Pong => {
                                    let _ = writer.write_all(&encode_frame(OPCODE_PONG, &json!({}))).await;
                                }
                                FrameAction::Close => {
                                    closed = true;
                                }
                            }
                        }
                        None => closed = true,
                    }
                }

                activity = activity_rx.recv() => {
                    match activity {
                        // Новая активность.
                        Some(Some(activity)) => {
                            let ready = inner.lock().map(|s| s.ready).unwrap_or(false);
                            if ready {
                                if let Ok(mut state) = inner.lock() {
                                    state.activity = Some(activity.clone());
                                }
                                send_activity(&mut writer, &inner, Some(activity)).await;
                            } else if let Ok(mut state) = inner.lock() {
                                state.activity = Some(activity);
                            }
                        }
                        // Активность убрать.
                        Some(None) => {
                            if let Ok(mut state) = inner.lock() {
                                state.activity = None;
                            }
                            send_activity(&mut writer, &inner, None).await;
                        }
                        // Канал закрыли — завершаемся.
                        None => closed = true,
                    }
                }

                _ = heartbeat.tick() => {
                    let ready = inner.lock().map(|s| s.ready).unwrap_or(false);
                    if ready {
                        send_activity(&mut writer, &inner, None).await;
                    }
                }
            }

            if closed {
                break;
            }
        }

        if let Ok(mut state) = inner.lock() {
            state.ready = false;
        }

        // Discord закрыл соединение до handshake — скорее всего, неверный Client ID.
        attempts += 1;
        if attempts >= 2 {
            if let Ok(mut state) = inner.lock() {
                state.sender = None;
            }
            return;
        }

        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

/// Что делать с полученным кадром.
enum FrameAction {
    None,
    Pong,
    Close,
}

/// Разбор кадра от Discord.
fn handle_frame(opcode: i32, payload: &Value, inner: &Arc<Mutex<Inner>>) -> FrameAction {
    match opcode {
        OPCODE_CLOSE => FrameAction::Close,
        OPCODE_PING => FrameAction::Pong,
        OPCODE_FRAME => {
            let cmd = payload.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
            let evt = payload.get("evt").and_then(|v| v.as_str()).unwrap_or("");

            if cmd == "DISPATCH" && evt == "READY" {
                if let Ok(mut state) = inner.lock() {
                    state.ready = true;
                }
            }

            FrameAction::None
        }
        _ => FrameAction::None,
    }
}

/// Отправляет активность в Discord.
async fn send_activity<W>(
    writer: &mut W,
    inner: &Arc<Mutex<Inner>>,
    activity: Option<DiscordActivity>,
) where
    W: tokio::io::AsyncWrite + Unpin,
{
    let (activity, nonce, client_id) = match inner.lock() {
        Ok(mut state) => {
            if let Some(new_activity) = activity {
                state.activity = Some(new_activity);
            }
            state.nonce += 1;
            (
                state.activity.clone(),
                state.nonce,
                state.client_id.clone(),
            )
        }
        Err(_) => return,
    };

    let _ = client_id;

    let activity_json = match activity {
        Some(activity) => {
            let mut value = serde_json::Map::new();
            if let Some(details) = activity.details {
                value.insert("details".to_string(), json!(details));
            }
            if let Some(state) = activity.state {
                value.insert("state".to_string(), json!(state));
            }
            if let Some(large_text) = activity.large_text {
                value.insert("large_text".to_string(), json!(large_text));
            }
            if let Some(small_text) = activity.small_text {
                value.insert("small_text".to_string(), json!(small_text));
            }
            if let Some(image) = activity.large_image_key {
                value.insert("large_image".to_string(), json!(image));
            }
            if let Some(image_text) = activity.large_image_text {
                value.insert("large_image_text".to_string(), json!(image_text));
            }
            if let Some(start) = activity.start_timestamp {
                value.insert("timestamps".to_string(), json!({ "start": start }));
            }
            Some(Value::Object(value))
        }
        None => None,
    };

    let payload = json!({
        "cmd": "SET_ACTIVITY",
        "args": {
            "pid": std::process::id(),
            "activity": activity_json,
        },
        "nonce": nonce.to_string(),
    });

    let _ = writer.write_all(&encode_frame(OPCODE_FRAME, &payload)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_frame() {
        let frame = encode_frame(OPCODE_FRAME, &json!({ "a": 1 }));
        assert_eq!(&frame[0..4], &1i32.to_le_bytes());
        assert_eq!(
            &frame[4..8],
            &(frame.len() as i32 - 8).to_le_bytes(),
            "длина — только данные, без заголовка"
        );
    }

    #[test]
    fn parses_frames() {
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&encode_frame(OPCODE_FRAME, &json!({ "cmd": "X" })));
        buffer.extend_from_slice(&encode_frame(OPCODE_PING, &json!({})));

        let frames = take_frames(&mut buffer);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].0, OPCODE_FRAME);
        assert_eq!(frames[1].0, OPCODE_PING);
        assert!(buffer.is_empty());
    }

    #[test]
    fn keeps_incomplete_frame() {
        let mut buffer = Vec::new();
        let frame = encode_frame(OPCODE_FRAME, &json!({ "cmd": "X" }));
        buffer.extend_from_slice(&frame[..frame.len() - 3]);

        assert!(take_frames(&mut buffer).is_empty());
        assert_eq!(buffer.len(), frame.len() - 3);
    }
}
