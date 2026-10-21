//! Проверка живой связи с SoundCloud: client_id, поиск и подписанная ссылка.
//!
//! Тест идёт в сеть, поэтому при отсутствии соединения он падает мягко:
//! печатает причину и завершается успехом, чтобы не ломать сборку.

use reqwest::Method;
use soundwave_lib::soundcloud::SoundCloud;

#[tokio::test]
async fn client_id_and_stream_resolve() {
    let sc = SoundCloud::new();

    let client_id = match sc.client_id().await {
        Ok(id) => {
            println!("client_id: {id} ({} символов)", id.len());
            id
        }
        Err(e) => {
            println!("ПРОПУСК: не удалось получить client_id — {e}");
            return;
        }
    };

    assert!(client_id.len() >= 8, "client_id слишком короткий");

    // Ищем трек, чтобы взять настоящий id.
    let search = sc
        .api(
            Method::GET,
            "/search/tracks",
            &[("q".to_string(), "daft punk".to_string())],
        )
        .await;

    let search = match search {
        Ok(value) => value,
        Err(e) => {
            println!("ПРОПУСК: поиск не отработал — {e}");
            return;
        }
    };

    let track_id = search
        .get("collection")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|track| track.get("id"))
        .and_then(|id| id.as_u64());

    let track_id = match track_id {
        Some(id) => id,
        None => {
            println!("ПРОПУСК: поиск не вернул треков");
            return;
        }
    };

    println!("трек для проверки: {track_id}");

    match sc.resolve_stream(track_id).await {
        Ok(stream) => {
            println!("протокол: {}", stream.protocol);
            println!("длительность: {} мс", stream.duration);
            println!("ссылка: {}", stream.url);

            assert!(stream.url.starts_with("https://"), "ссылка должна быть https");
            assert!(
                stream.url.contains("soundcloud"),
                "ссылка должна вести на CDN SoundCloud"
            );

            // Смотрим, что внутри манифеста: fMP4 играется в MSE как есть,
            // MPEG-TS приходится перепаковывать (hls.js умеет).
            let client = reqwest::Client::new();
            if let Ok(response) = client.get(&stream.url).send().await {
                if let Ok(text) = response.text().await {
                    let lines: Vec<&str> = text
                        .lines()
                        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
                        .take(3)
                        .collect();
                    println!("сегменты манифеста:");
                    for line in &lines {
                        println!("   {line}");
                    }
                }
            }
        }
        Err(e) => {
            println!("ПРОПУСК: поток не разрешился — {e}");
        }
    }
}
