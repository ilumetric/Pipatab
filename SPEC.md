# Pipatab — Wireless Graphics Tablet for Artists

## Цель

Превратить iPad (с Apple Pencil) в графический планшет без экрана для Windows 11.
Никакого зеркалирования экрана. Только ввод стилусом — быстро, стабильно, без лишнего.

## Ключевые требования

### Клиент (iPad / браузер Safari)
- **Только стилус (pen)** — касания пальцами игнорируются
- **Hover Apple Pencil** — поддержка событий наведения без касания поверхности
- **Pressure sensitivity** — полная передача силы нажатия (0.0–1.0)
- **Tilt X/Y** — наклон пера
- **Twist / rotation** — вращение пера (если поддерживается устройством)
- **Barrel button / eraser** — кнопки стилуса
- **Coalesced events** — сбор промежуточных точек для плавности
- **Полноэкранный режим** через PWA / Add to Home Screen
- **Минимальный UI** — только область ввода + скрытое меню настроек

### Сервер (Windows 11)
- **Pen injection** через Windows Synthetic Pointer API (`CreateSyntheticPointerDevice`, `InjectSyntheticPointerInput`)
- **Выбор активного монитора** — художники работают с несколькими мониторами, нужно выбрать конкретный дисплей для маппинга
- **Автоопределение мониторов** — через DXGI
- **Headless режим** (`--no-gui`) — запуск без GUI
- **Минимальная конфигурация** — bind address, port, access code, target monitor

### Протокол (WebSocket, JSON)
- `Client → Server`: PointerEvent (pen only), RequestMonitorList
- `Server → Client`: MonitorList, ConfigOk, Error

### Не входит в v1
- Кривые давления (pressure curves) — будущее
- Shortcut mapping / radial menu — будущее
- Нативный iPad-клиент — будущее
- Поддержка Linux / macOS сервера — не планируется
- Зеркалирование экрана — принципиально не нужно
- Touch / multi-touch ввод — не нужно
- Клавиатурный ввод — не нужно

## Архитектура

```
┌─────────────────────┐       WebSocket (JSON)       ┌──────────────────────┐
│   iPad Safari/PWA   │ ◄──────────────────────────► │   Windows 11 Server  │
│                     │                               │                      │
│  PointerEvent API   │  ── pen events ──────────►   │  Synthetic Pointer   │
│  (stylus only)      │                               │  Injection (WinAPI)  │
│                     │  ◄── monitor list ────────   │                      │
│  Canvas (draw area) │                               │  DXGI Monitor Enum   │
└─────────────────────┘                               └──────────────────────┘
```

## Стек
- **Сервер:** Rust (hyper + tokio + fastwebsockets + winapi)
- **Клиент:** TypeScript → JavaScript, запускается в браузере
- **Транспорт:** HTTP для страницы, WebSocket для событий
- **Сборка:** cargo build (Windows MSVC)

## Файловая структура (целевая)

```
src/
  main.rs          — точка входа
  config.rs        — конфигурация CLI + файл
  log.rs           — логирование
  web.rs           — HTTP сервер + WebSocket upgrade
  websocket.rs     — обработка WebSocket сообщений
  protocol.rs      — типы сообщений
  input.rs         — Windows pen injection
  monitor.rs       — перечисление мониторов (DXGI)
ts/
  lib.ts           — браузерный клиент (stylus capture)
www/
  templates/
    index.html     — страница планшета
  static/
    style.css      — стили
```
