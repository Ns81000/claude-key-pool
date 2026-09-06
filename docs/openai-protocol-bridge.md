# OpenAI-протокольный мост (protocol: "openai")

Группа с `protocol: "openai"` позволяет подключить OpenAI-совместимый
агрегатор (OpenRouter и любой другой `/v1/chat/completions`) к пулу, все
клиенты которого говорят по Anthropic Messages API. Пул принимает
`POST /v1/messages` как обычно, транслирует запрос вверх, транслирует
OpenAI-SSE-ответ обратно в Anthropic-SSE — claude.exe подмены не замечает.

Статус: этапы 1–2 реализованы (ядро трансляции + интеграция в роут),
офлайн-тесты зелёные (`corepack pnpm exec vitest run`, 40 тестов).
Живой прогон с реальным ключом OpenRouter (этап 4 задания §9) —
не выполнен, требует ключа; чеклист в конце этого документа.

## Конфигурация

```json
{
  "id": "group_openrouter",
  "name": "OpenRouter",
  "targetUrl": "https://openrouter.ai/api",
  "protocol": "openai",
  "chatCompletionsPath": "/v1/chat/completions",
  "model": "claude-sonnet-4-5",
  "modelMapping": { "claude-sonnet-4-5": "anthropic/claude-sonnet-4.5" },
  "keys": [ { "id": "k1", "email": "or-1", "key": "sk-or-v1-..." } ]
}
```

| Поле | Смысл | Дефолт |
|---|---|---|
| `protocol` | `"anthropic"` (как раньше) или `"openai"` (мост) | `"anthropic"` — существующие конфиги не меняются |
| `chatCompletionsPath` | путь чат-комплишенов у агрегатора с нестандартной базой | `/v1/chat/completions` |
| `model` | Anthropic-имя, которое видит клиент и `/api/models` | — |
| `modelMapping` | Anthropic-имя → OpenAI-имя, отправляемое вверх. `[1m]`-суффикс срезается ДО маппинга. Немаппированное имя проходит как есть | `{}` |
| `keys` | ключи агрегатора, отправляются как `Authorization: Bearer …` | — |

## Как проходит запрос

```
claude.exe ── Anthropic POST /v1/messages ──► пул :9999
   │ translateRequest (1 раз до ротации):
   │   system → system-сообщение; tool_use → tool_calls
   │   (JSON.stringify input); tool_result → role:tool
   │   tools/tool_choice/temperature/stop_sequences;
   │   metadata/cache_control/thinking — отбрасываются;
   │   неизвестные блоки content — отбрасываются (warn-лог)
   ▼
POST {targetUrl}{chatCompletionsPath}   Authorization: Bearer <ключ пула>
   │ UA-маска claude-cli, accept-encoding: identity — как у anthropic-групп
   ▼
OpenAI-SSE ответ
   │ stall-защита (120 c) → translateStream:
   │   message_start → (content_block_start → delta* → stop)*
   │   → message_delta (stop_reason + usage) → message_stop
   │   finish_reason: length→max_tokens, tool_calls→tool_use, прочее→end_turn
   │   usage — из stream_options.include_usage
   │   мусор после [DONE] отбрасывается
   │   обрыв без finish_reason → синтетический end_turn + message_stop
   ▼
Anthropic-SSE клиенту (claude.exe)
```

Ротация/классификация/cooldown работают по тем же правилам, что и для
anthropic-групп: 429/401/403/5xx — по статусам; тела ошибок OpenAI-формата
(`{"error":{"message","type","code"}}`) покрываются расширенными списками
substring в `proxy.ts` («rate limit exceeded», «exceeded your quota»,
«no auth credentials», «insufficient credits», …); `X-RateLimit-Reset`
(OpenRouter) учитывается в `computeCooldownUntil`. Mid-stream ротация:
peek идёт по уже транслированному нами Anthropic-стриму — до первого
контента можно тихо сменить ключ, после — форвард как есть.

## Ограничения v1

- **thinking-блоки не транслируются** — отбрасываются с warn-логом.
  Выбирайте модель агрегатора без обязательного reasoning или модель
  с обычным function calling.
- Мульти-`system`, изображения (`type: "image"`) и прочие мультимодальные
  блоки — отбрасываются (forward-совместимость: запрос не роняется).
- `/api/models` НЕ ходит в `{targetUrl}/v1/models` агрегатора (этап 3
  задания, опционально): отдаёт `group.model` + ключи `modelMapping`.
- Backpressure на транслированном стриме не форсируется (кадры одного
  комплишена малы; stall-защита стоит выше транслятора).

## Тесты

```powershell
corepack pnpm exec vitest run   # 40 тестов, офлайн
```

- `tests/translate-request.test.ts` — трансляция запроса: диалог, tools,
  tool_result, `[1m]`, modelMapping, неизвестные блоки, tool_choice.
- `tests/translate-stream.test.ts` — OpenAI-SSE → Anthropic-SSE: текст,
  tool_calls (одиночный и мульти), `length`→`max_tokens`, обрыв без
  finish_reason, мусор после `[DONE]`, пустой стрим, битые data-строки.
- `tests/classifiers.test.ts` — фикстуры OpenRouter-ошибок 429/401/402/5xx →
  вердикты ротации; `X-RateLimit-Reset`.
- `tests/integration-openai-bridge.test.ts` — мок-агрегатор (node:http) за
  роутом: полный цикл с tool use, не-стриминговый ответ, 429 → ротация на
  второй ключ в том же запросе.
- `tests/regression-anthropic.test.ts` — конфиг без `protocol` форвардит
  тело байт-в-байт в `{targetUrl}/v1/messages`; `/api/models` не меняется.

## Чеклист живого прогона (этап 4, требует ключ OpenRouter)

1. Добавить группу OpenRouter в config.json (см. пример выше), ключ
   агрегатора в `keys`.
2. Выбрать модель группы в панели; `GET /api/models` должен показать
   Anthropic-имя.
3. Живая сессия Claude Code через Aiagent: текст; вызов инструмента и
   tool_result; стриминг; stop/resume.
4. Выключить первый ключ (429 у агрегатора) — запрос не должен упасть.
5. Проверить логи: секретов нет, только метки ключей.

Результаты прогона записать сюда с пометкой «проверено живым прогоном»
и датой (по образцу docs/sdk-notes.md в Aiagent).
