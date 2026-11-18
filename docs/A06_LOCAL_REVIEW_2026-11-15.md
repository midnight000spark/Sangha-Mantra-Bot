# A06 — локальная подготовка native Telegram TEST

**LOCAL_VERIFIED** в разрешённом scope: test infrastructure R1, три полных проверки, native plan/resource matrix/receipt и evidence подготовлены. **Native TEST NOT_RUN**, запуск сейчас **NO-GO** до отдельного решения владельца и подтверждения ресурсов. Полная SC27 приёмка остаётся PARTIAL/UNKNOWN; A05 provider PITR NOT_RUN не закрыт. Production authorization не выдаётся.

## Git и изоляция

Base проверен фактически: A05 `dd7c959699a4df2491833049ebb783fe1b1f72dd`, чистый. Корень workspace сам не Git repo. Создан отдельный worktree `sangha-mantra-bot-a06`, ветка `local/a06-native-test-preparation`, от exact A05 candidate. Code candidate SHA/tree/patch hash после локального commit находятся в `test-results/a06/manifest.json`; self-referential SHA в committed document не встраивается.

Исходные private/A02/A03/A04/A05 рабочие деревья не редактировались; public HEADb7cc125 с пользовательскими dirty changes сохранён. Начальные HEAD/status наблюдались до создания A06; подробный status/diff/untracked-digest checkpoint и итоговое сравнение — evidence. Dependencies независимо скопированы из pinned A05 node_modules (`cp -a --reflink=auto`), без hardlinks и network install. Package/lock/config, **src/** и **migrations/** идентичны base; ledger runtime не менялся.

## R1: причина, изменение и предел доказательства

Исходный тест создавал временные service/timer, но `systemd-analyze --user verify` наследовал HOME/XDG/SYSTEMD environment и реальный user-unit search graph. Наличие XDG_RUNTIME_DIR — не доказательство изолированной или исправной user-сессии. Это infrastructure coupling: результат проверки generated units зависит от посторонних user units/drop-ins/runtime state. В текущем окружении реальный parser сообщил ordering cycle `drkonqi-coredump-cleanup.timer` → `timers.target`. Уровень warning может давать exit0: старая проверка только строки `bad unit file` не ловила все реальные syntax warnings.

`test-results/a06/r1-probe.ts` воспроизводит причинную связь без изменения пользовательского systemd: baseline valid units exit0 с посторонним cycle; временный XDG_CONFIG_HOME с `basic.target Requires=a06-missing.service` → те же generated units exit1; isolated invocation → exit0, stdout/stderr пусты. Полные argv/result/stderr — `r1-probe.jsonl`. Исторический точный failing stacktrace R1 владельцем не приложен; естественный random failure в исходном baseline в этой сессии **не пойман**. Доказана и устранена зависимость от host unit graph; timeout/ресурсный сбой не заявляется установленной причиной.

Минимальный fix находится в `tests/production-ops.test.ts`: собственный temporary HOME/XDG_RUNTIME_DIR, явный SYSTEMD_UNIT_PATH на test directory + настоящие vendor directories, `--generators=no --man=no --recursive-errors=yes`; stdout и stderr оба drained. Unit/service/timer/executable остаются настоящими, vendor dependencies не stub-ятся, service не запускается. Нет systemctl/daemon-reload/enable/install; production installer не менялся. Проверяется exit0 **и пустая диагностика**, а затем parser обязан отказать на неизвестной директиве и несуществующем executable. Проверка не skip-ится из-за отсутствия ambient XDG_RUNTIME_DIR; только отсутствие binary оставляет прежнюю платформенную опциональность. На проверенной Linux/systemd255 все assertions исполнены, skips нет. Иная версия systemd/vendor tree требует своей среды, а не подавления ошибки.

## Проверки и окружение

Все команды проверки: `CI=true WRANGLER_SEND_METRICS=false`, Linux x64, Bun1.4.4, Node22.23.4, TypeScript7.0.2, Wrangler4.160.0, Miniflare4.20260730.0, workerd1.20260730.1, systemd255. Полный platform/cpu/timezone/tool fingerprint — `environment.json`, SHA всех code/test/script/schema/package inputs — `verified-inputs.json`. Runner проверил неизменность inputs после каждого suite. Telegram transport в runtime suites подменён; local workerd/D1, migration fixtures, local Git objects — без Cloudflare/Telegram API. Никакого remote deployment/secret access.

| Проверка | Результат | Длительность / evidence |
|---|---|---|
| Исходный baseline full `bun run check` | 329 PASS,0 FAIL; typecheck PASS | 65,243с, `baseline-check.log/json` |
| Focused final systemd + A06 boundary | 3 PASS,0 FAIL,25 assertions | 1,69с, `focused-final.log` |
| Последовательный полный #1 | typecheck PASS;330 PASS,0 FAIL;1806 assertions/25 files | **63,960с**, 2026-11-15 06:42:45→06:43:49 UTC, `check-1.log` |
| Последовательный полный #2 | typecheck PASS;330 PASS,0 FAIL;1806 assertions/25 files | **60,851с**, 06:43:49→06:44:50 UTC, `check-2.log` |
| Последовательный полный #3 | typecheck PASS;330 PASS,0 FAIL;1806 assertions/25 files | **61,665с**, 06:44:50→06:45:51 UTC, `check-3.log` |

В таблице duration — elapsed монотонных часов внешнего Python runner, включая typecheck; Bun suite отдельно сообщает63,40/60,32/61,12с. `three-runs.json` хранит timestamps/exitCode/log hashes; каждый полный прогон — ровно `bun run check` без фильтров/условных retry. Изменения tests/code после этой серии отсутствуют; позднее завершалась только документация. Отдельный build/backup/migration drill A05 заново не выполнялся и A06 PASS ему не приписывается; package/runtime не менялись, необходимые runtime tests входят в full suite.

Новый `tests/a06-report-boundary.test.ts` проверяет настоящую D1/workerd schema0001–0009 и существующий `runReports(..., nowMs, send)` seam: три original вокруг Moscow midnight, cutoff00:04:59/00:05:00, snapshot immutability и late correction, три дня ON, repeated runs без duplicate snapshot, OFF не release backlog, следующий новый день отправляется один раз. Clock/send synthetic, **не native Telegram/Cron evidence**. Native report cycle и provider trigger разведены в плане.

Промежуточные failures сохранены: `focused.log` — ошибочное тестовое ожидание `.created===1` при D1 meta.changes=2 из-за audit trigger; assertion исправлен на positive inserted changes, точное число/содержимое snapshot проверяется по actual rows. Runtime не исправлялся ради счётчика. `typecheck-initial.log/json` — TypeScript не вывел тип paths после переноса в closure; добавлен `string[]`, затем полные typechecks PASS. Receipt первоначально называл log check-1, сохранён после rename как typecheck-initial. Никаких errors из suite не отфильтровано.

Ранее первая серия также дала три330/0, но первый прогон пересёк длительную паузу/скачок календарного времени сессии: runner monotonic68,597с, UTC интервал около11ч и Bun39937с. Эти raw logs/receipt сохранены в `interrupted-series/` с исходными внутренними именами; **не** используются для сопоставимого timing evidence. Авторитетная серия из таблицы исполнена заново последовательно после возобновления, без clock discrepancy. Первоначальный SQL observation validator некорректно делил `;` внутри комментария; после удаления комментариев все23 read-only statements прошли against fresh local schema, `observation-validation.json`. Это проверка корректности запросов, не внешний D1 receipt.

## TEST plan и remaining owner gates

[План](A06_NATIVE_TEST_E2E_PLAN.md) содержит24 сценария H00–H13/R01–R03/C01–C04/F01–F03; у каждого действия, expected, права, D1 observation, evidence label. [Resource matrix](A06_TEST_RESOURCES.json), [SQL Q0–Q10](A06_TEST_OBSERVATION.sql), [receipt template](A06_TEST_RECEIPT.template.json) подготовлены; все24 внешние строки NOT_RUN. Реальные bot/account/chat/UUID/config/window/permissions остаются UNKNOWN.

Без ожидания проверены deterministic границы/несколько дней; короткий human+native provider report witness возможен на **отдельной fresh accelerated TEST campaign**, без смены immutable primary calendar. Полная native Moscow multi-day SC27 требует календарного окна. `ScheduledController.scheduledTime` не ускоряет этот Worker: handler использует Date.now(). Bot-to-bot и operator replay не заменяют human/provider evidence.

GO — локальная подготовка для review. TEST launch NO-GO до подписанной resource matrix, конкретного SHA/config/window и отдельных owner permissions: Telegram/CF reads; TEST provisioning/migrations/enrollment/secrets/deploy; webhook/Cron; реальные human/admin/membership действия; controlled retry/fault gateway/revoke/restart; выбор полного календарного окна/accelerated resources; retention/teardown. Точный перечень и STOP — последние секции плана. Provider PITR отдельным A05 scope; production push/merge/deploy/cutover/restore/коррекция35 не разрешены. Доступ к production не выполнялся, production authorization не выдаётся.

## Артефакты и воспроизведение

`test-results/a06/`: `manifest.json`, `A06.patch`, local Git bundle, `source-files.sha256`, `evidence-files.sha256`, `bundle-files.sha256`, полные stdout/stderr и replay runner. Bundle — локальная история sanitized repo, включая b7cc125 для A05 runtime tests. Manifest создаётся **после** candidate commit, без самоссылочного SHA; evidence намеренно Git-ignored. Hash manifests исключают самих себя/manifest согласно описанной inventory и проверяются `sha256sum -c`.

В новом изолированном checkout exact candidate из bundle с pinned dependencies и полным local history:

```bash
sha256sum -c test-results/a06/source-files.sha256
sha256sum -c test-results/a06/evidence-files.sha256
sha256sum -c test-results/a06/bundle-files.sha256
python3 test-results/a06/verify-local.py
```

Runner перезаписывает текущие check logs/three-runs.json: запускать его только в новом evidence directory/копии, после сохранения исходного пакета. Он останавливается на первом FAIL; scripts/schema/package input SHA сверяет после каждого прогона. Если replay начинается с base: сначала `git apply --check A06.patch`, затем применить patch; SHA candidate из manifest предпочтительнее. При необходимости установки dependencies использовать pinned `bun install --frozen-lockfile` в отдельно разрешённом network scope; текущая сессия его не выполняла. Не запускать native setup по локальному PASS.
