# Hardware Monitoring + Telegram Plan

## Goal

Add backend health visibility for `trading-runner-new` so I can monitor the system remotely while away.

## Core Requirement

Use a **second Telegram chat** with the **same bot** so I can request hardware/runtime info on demand without mixing those messages into the main trading chat.

## Why

- Confirm the runner is healthy 24/7.
- Catch backend issues early (high CPU, memory pressure, disk fill, thermal throttling, stalled scans).
- Debug incidents remotely from Telegram.

## Proposed Chat Model

- `primary chat`: trading signals and strategy commands (`/new`, `/funding`, etc.).
- `ops chat` (second chat, same bot): backend and hardware monitoring commands.

## Proposed Commands (Ops Chat)

- `/hw`: one-screen hardware summary.
- `/health`: runner + DB + Telegram + market API heartbeat summary.
- `/cpu`: CPU load and process usage.
- `/mem`: RAM usage and swap usage.
- `/disk`: disk usage and free space.
- `/temp`: SoC/system temperature.
- `/uptime`: host + process uptime.
- `/net`: basic network status and recent API latency.
- `/logs`: last N warning/error lines (safe-trimmed).

## Suggested Data in `/hw`

- Hostname, OS, architecture.
- CPU model, core count, load averages.
- Memory used/total (+ swap).
- Disk used/total for runner volume.
- Temperature (Pi sensor if available).
- Runner state: last scan timestamp, last scan duration, setup count, ready count.

## Access Control

- Add allowlist for ops chat IDs:
  - Example env: `TELEGRAM_MONITOR_CHAT_IDS=12345,67890`
- Only allow `/hw` style commands in allowlisted chats.
- Keep trading decision buttons and strategy actions restricted to intended chat(s).

## Implementation Outline

1. Add monitor chat ID config parsing in bootstrap/config.
2. Extend `telegramCommandRouter` with ops commands.
3. Add host-metrics helper (`os` module + optional shell fallback for Pi temperature).
4. Format concise Telegram output for each ops command.
5. Add light timeout/error handling (return partial info instead of failing whole command).
6. Optional: scheduled heartbeat push to ops chat every X minutes.

## Non-Goals (for first pass)

- No heavy metrics stack (Prometheus/Grafana) yet.
- No container/orchestrator dependency.
- No long historical charting in Telegram.

## Acceptance Criteria

- I can send `/hw` from the second chat and get a valid backend snapshot in <5s.
- Unauthorized chats cannot run ops commands.
- Trading signals still go only to intended signal chat.
- Output is concise enough for phone reading.

