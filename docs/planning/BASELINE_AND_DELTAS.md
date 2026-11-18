# Исходная точка и изменения плана

Срез: 14.11.2026. Документационная ревизия; разрешение на реализацию, merge и production отсутствует. Реестр используется вместе с [MASTER_PLAN.md](MASTER_PLAN.md), [DECISIONS.md](DECISIONS.md) и [VERIFICATION_MATRIX.md](VERIFICATION_MATRIX.md).

## Статусы доказательств

- **NOW-LOCAL / NOW-REMOTE** — проверено в этой сессии чтением локальных файлов / удалённого API. Чтение кода не доказывает поведение живого бота.
- **INHERITED-LOCAL / INHERITED-TEST** — сохранённое свидетельство прежней Sol или repository receipt на указанном SHA; повторно не воспроизводилось.
- **OWNER-OBSERVED** — историческое наблюдение, переданное владельцем; не текущий production-срез.
- **DESIGN** — рекомендуемое устройство будущей версии, ещё не реализация.
- **UNKNOWN** — необходимых свидетельств нет. Это не PASS и не доказанный отказ.

## EV01 — Checkout и входные документы

| Объект | Результат NOW-LOCAL |
|---|---|
| Рабочая папка | Содержит два checkout; сама не Git-репозиторий |
| Публичный checkout, место новых документов | `sangha-mantra-bot-public/docs/planning/` |
| Публичный HEAD | `b7cc125a47c4b791cdafefcd22dbc1859a8f126f` |
| База PR | `efc3240e988a6809978339944da09155c256adbb` |
| Изменения main → HEAD | 2 коммита; 47 файлов, +1763/−116 |
| Приватный checkout | `65e54e3a81197e09c76fad21460c197d2d300e2f`; используется только как идентификатор исторической базы |
| Исходные рабочие деревья | Оба чистые до создания planning-документов |
| Локальные AGENTS.md | В checkout и родительских каталогах не обнаружены |

Входы находятся вне публичного checkout и не копируются в него целиком:

| Вход | SHA-256 |
|---|---|
| `codex-plan-01a1d648-bfe0-7df1-a70c-3db5ac5282ba-01a1d648-bf.md` | `f9c9357839cfc653fb17685c62af712bd52d854eb43f938324bb753944927bb1` |
| `SANGHA_MANTRA_BOT_MASTER_PLAN_REVISION_PACKAGE_2026-11-14.md` | `0a8a8cc27f897a676002b5368dffb7b02964ab2a4af3d29b7c1f648129ac96cf` |

Первый документ сохраняется как история архитектурного исследования. В пакете приоритет имеют краткое задание и часть II, особенно §§20–25. Старый запрет записи из Plan Mode и прежний порядок M2b/D1 не являются инструкциями текущей сессии. Исходный `Sangha-Mantra-Bot_context_handoff_2026-11-13.md` среди доступных входов не установлен; его содержимое не выдумано. Доступные handoff-файлы с другими именами не объявляются его заменой.

## EV02 — PR и CI

NOW-REMOTE через GitHub connector, 14.11.2026:

- [PR #1](https://github.com/midnight000spark/Sangha-Mantra-Bot/pull/1): `open`, `merged=false`, HEAD совпадает с EV01; base совпадает с EV01.
- [Checks #5](https://github.com/midnight000spark/Sangha-Mantra-Bot/actions/runs/43404449402): `completed/success` для этого commit. Это состояние CI, не новый локальный прогон.
- Review submissions: 0; review threads: 0. GitHub `mergeable=true` означает отсутствие механического конфликта, а не закрытие F03/F04.

Ни PR, ни CI не устанавливают фактически развёрнутый production SHA, баланс, webhook, Cron, cutoff или исправление сообщения 35.

## EV03 — Карта кода и статические подтверждения

Все ссылки ниже относятся к HEAD EV01; при смене SHA проверять только затронутую дельту.

| ID | Место | Что установлено NOW-LOCAL | Ограничение / работа |
|---|---|---|---|
| F01 | [telegram.ts](../../src/telegram.ts), интерфейс с строки 63 и нормализация | В нормализованном сообщении нет `message_thread_id`, `is_topic_message`, `chat.is_forum` | Нужен новый envelope; SQL сам по себе темы не добавит |
| F02 | [0001_core.sql](../../migrations/0001_core.sql), [config.ts](../../src/config.ts) | `chat_aliases.chat_id` — PK; конфигурация и список admins глобальны | Multi-Campaign затрагивает route, settings и authorization |
| F03 | [admin.ts](../../src/admin.ts), строка 38 | Final admin gate ограничен префиксом `ui:`; обычный `admin:` его не проходит | Прежняя локальная проба утечки наследуется; нового сетевого воспроизведения нет |
| F04 | [controls.ts](../../src/controls.ts), строки 11–33 | Есть event dedup/nonce, но нет исходной версии команды / watermark порядка | Новый старый OFF может отменить более новый ON; dedup этого не решает |
| F05 | [worker.ts](../../src/worker.ts), строка 172; [admin.ts](../../src/admin.ts), строки 15–48 | `rejected:` создаётся отдельно; доставка не сверяет актуальную ревизию вклада | Старое предупреждение после исправления; нужна проверка перед send |
| F06 | [core.ts](../../src/core.ts), строки 57–59 | Достижение цели проверяется полным campaign SUM в ingest | Механизм роста rows read подтверждён; облачная стоимость UNKNOWN |
| F07 | [config.ts](../../src/config.ts), начало файла | Публичные production guards содержат вымышленные фиксированные identity | Публичный checkout не готовый production-артефакт |
| F08 | [db.ts](../../tests/db.ts), [backup.ts](../../scripts/backup.ts), [restore.ts](../../scripts/restore.ts) | SQLite test adapter и backup tools зависят от Bun | Это не проверенный Node runtime или автономная эксплуатация |
| BOUNDARY | [core.ts](../../src/core.ts), строки 7–65; [0007](../../migrations/0007_campaign_controls.sql) | Для отсутствующего оригинала проверка исходной даты / message ID внутри D1 batch; существующий вклад не удаляется новой boundary | Нет ретроактивного автоматического исправления 35 |
| MEMBERSHIP | [worker.ts](../../src/worker.ts), обработка `my_chat_member` | Состояние membership хранится отдельно для известных aliases | Это не окончательный `joined_at` всех групп и не автоматическое enrollment |
| REPORT | [reports.ts](../../src/reports.ts), строки 97–112 | correction = актуальная сумма до начала периода − total предыдущего immutable snapshot | `+5000` может происходить от edit, а не admin override |
| HISTORY | [admin-dialog.ts](../../src/admin-dialog.ts), строка 203 | Recent сортируется по `original_date` | Поздний edit старой записи не обязан появиться в последних 20 |

Основные границы: [parser.ts](../../src/parser.ts), [core.ts](../../src/core.ts), [controls.ts](../../src/controls.ts), [admin-dialog.ts](../../src/admin-dialog.ts), [reports.ts](../../src/reports.ts), [telegram.ts](../../src/telegram.ts), [worker.ts](../../src/worker.ts). Календарь: [time.ts](../../src/time.ts). Проверки: [tests](../../tests), включая workerd/D1 runtime suites. Операции и свидетельства: [ACCEPTANCE](../ACCEPTANCE.md), [TELEGRAM_E2E](../TELEGRAM_E2E.md), [PRODUCTION_TRANSITION](../PRODUCTION_TRANSITION.md), [scripts](../../scripts).

## EV04 — Сохранённые результаты прежнего исследования

SHA совпадает с EV01. Тесты, сборка и drills в этой сессии не повторялись: новых product changes нет, решение о ревизии документов от повторного прогона не изменится.

| Проверка | Результат и происхождение | Что она не закрывает |
|---|---|---|
| `CI=true WRANGLER_SEND_METRICS=false bun run check` | INHERITED-LOCAL: 189 tests, 831 assertions, typecheck PASS; прежний MASTER PLAN | Не human E2E и не новая проверка |
| `bun run backup:drill` | INHERITED-LOCAL: synthetic D1 → encrypted archive → отдельная SQLite; corruption / wrong key PASS | Не свежий production backup и не внешний restore |
| `bun run build` | INHERITED-LOCAL: TEST dry-run PASS | Не deploy |
| F03/F04/F05 | INHERITED-LOCAL: локальные репродукции старой Sol; кодовые причины перепроверены в EV03 | Новых исправлений нет |
| F06 | INHERITED-LOCAL: workerd/D1, 1002 rows read при 1000 прежних вкладов; 10002 при 10000 | Не production billing, CPU или предел ёмкости |
| Миграция архивной БД | INHERITED-TEST из ACCEPTANCE: прежние столбцы 18 таблиц и zero overrides 32/38 сохранены | Архивный срез, не текущая production-БД; независимо не повторён |
| Автономный Telegram TEST | INHERITED-TEST из TELEGRAM_E2E / ACCEPTANCE: isolated bot-to-bot, реальные сообщения/edits, redeploy, heartbeat | Не человек, callbacks, General topic, ежедневный cloud report, native reorder или потеря ответа |

Прежний MASTER PLAN отмечает F03 и в main: это не объявляется новой регрессией PR #1. Первоначальная неуспешная F06 проба имела ошибку SQL-экранирования инструмента; числа в таблице относятся к исправленному повтору, не к той ошибке.

## EV05 — Исторический инцидент 35

OWNER-OBSERVED из пакета, §13: отчёт за 13.11 — day 26500, total 63550, correction +5000; предыдущий snapshot 32050. `32050 + 26500 + 5000 = 63550`. Сообщение 35 исходно от 12.11, edited 13.11, amount 5000, override NULL; по сообщению владельца оно уже включалось в ручной начальный импорт 14950. Это объяснение согласуется с формулой REPORT в EV03.

Для 32/38 исторически применялись override=0, суммарно 3200. Для 35 correction предложена, **исполнение не подтверждено**. 58550 — только ожидаемый исторический итог при успешном обнулении лишнего 5000, не текущий баланс. 24 исторически не найдено по inspect; это не доказательство корректного отклонения.

Новая boundary предотвращает появление отсутствующих старых оригиналов. Уже сохранённый дубль требует отдельной авторизованной, идемпотентной и проверяемой коррекции. Миграция сохраняет такие записи и не предполагает, что оператор уже исправил их.

Отдельный инцидент «отчёт виден в Telegram, состояние FAILED_KNOWN»: причина UNKNOWN. Нельзя автоматически повторять публикацию или приписывать причину Telegram/Cron/БД.

## EV06 — Внешние ограничения

Официальные страницы просмотрены 14.11.2026. Это документационные лимиты, не метрики аккаунта.

| Источник | Проверенный факт |
|---|---|
| [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) | Free: 100000 requests/day, 10 ms CPU для HTTP и Cron, 5 Cron/account; CPU отличается от wall time |
| [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) | Free: 500 MB/database, 50 queries/invocation; batch считается одним обращением к этому лимиту, не одним rows-read/write |
| [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) | Free: 5 млн rows read/day, 100000 rows written/day; учесть соседние приложения аккаунта |
| [D1 limits / Time Travel](https://developers.cloudflare.com/d1/platform/limits/) | Retention: 7 дней Free, 30 Paid. Общий текст Time Travel о 30 днях нельзя переносить на Free |
| [Telegram Bot API](https://core.telegram.org/bots/api#getupdates) | Webhook и polling взаимоисключающие; updates хранятся не более 24 ч; offset подтверждает более ранние updates |
| [setMessageReaction](https://core.telegram.org/bots/api#setmessagereaction) | Метод существует; допустимость конкретной реакции и permissions проверяется в TEST |
| [Node releases](https://nodejs.org/en/about/previous-releases) | На просмотренной странице 24 и 26 — LTS; Node 24 остаётся кандидатом, не закреплённым образом |
| [SQLite Backup API](https://www.sqlite.org/backup.html) | Основа согласованного snapshot активной БД; обычное копирование одного WAL database file не принимается |
| [rclone crypt](https://rclone.org/crypt/), [Drive](https://rclone.org/drive/), [Yandex](https://rclone.org/yandex/) | Кандидаты self-hosted upload/encryption; account access и round-trip не проверялись |

Точный Node driver/SQLite build и отсутствие известных WAL defects подлежат проверке в B03, а не наследуются по имени пакета. Страницу `latest-v24.x/api/sqlite.html` web-инструмент не получил; прежнее утверждение о статусе node:sqlite Release Candidate здесь не переутверждается. Никакие cloud credentials, production API или реальные backup-архивы не открывались.

## EV07 — Дельта первого пакета до независимого review

1. Вместо обязательного D1 Multi-Campaign перед self-hosted предложены Track A / Track B и опциональный Cloudflare v2; условия пересмотра — ADR-01.
2. UX, жизненный цикл, incident trace, reactions и manual reconciliation получают конкретные сценарии и задачи; предложения отделены от обязательного MVP.
3. Incident 35 и отсутствие доказательства исправления сохранены; published snapshot отделён от updated period view.
4. Разделены P0-integrity/security и P0-product usability **в пределах своего релиза**. Полный UX 2.0 не блокирует исправление 1.x.
5. Данные production, ёмкость аккаунта, RPO/RTO, provider/retention, роли, лицензия и решение о переходе остаются открытыми gates.

## EV08 — Ревью и решения до уточнений EV09

Вход: `SANGHA_SOL_MAX_INDEPENDENT_REVIEW_2026-11-14.md`, SHA-256 `05cdfddc33482386bf59eb73cbc14c3d1b1a3eb5bb473247c3e0a1005b95bfb0`. Это внешнее ревью текстов восьми документов; заявленный reviewer SHA архива не проверен по самому архиву. Оно не является новым GitHub code review, повторением тестов или production audit. Public/private HEAD не изменились; F03/F04/F05 по-прежнему не исправлены.

Это исторический срез первой реакции на review. Последующие явные решения владельца EV09 имеют приоритет, особенно по prospective pause и независимости мигратора; прежняя window/reclassification схема не действует.

**OWNER-DECIDED, текущее сообщение владельца:** для Cloudflare/D1 1.x достаточно provider Time Travel с историей 7 дней; полноценные encrypted backups на файловые хранилища относятся к v2. Регулярный внешний executor/export/rotation не добавляется в Track A и не является его gate. Одноразовый consistent export для перехода между платформами остаётся migration artifact, а не навязанным регулярным backup. OD04 закрыт в этой части; provider/retention/RPO/RTO/ключи v2 ещё не выбраны.

Проверено повторно по официальным страницам: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) подтверждает 7 дней Free; [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) восстанавливает D1 **на месте**, а не клонирует в новую БД. Поэтому восстановимость процедуры проверяется на отдельной synthetic TEST D1; production restore не выполняется как диагностическая проба. Новый bookmark может появиться без пользовательского изменения — сам по себе это не доказательство новых данных. [getChatMember](https://core.telegram.org/bots/api#getchatmember) гарантирован для других пользователей, если бот является администратором; это учтено в enrollment proof.

| Замечание | Оценка после сопоставления | Адресная поправка |
|---|---|---|
| CR-01 | Принято: доказать отсутствие в неизвестном агрегированном import по отсутствию DB row нельзя | Batch/coverage provenance и PARTIAL/UNKNOWN; default review, owner risk exception явно audited, не VERIFIED |
| CR-02 | Проблема границы признана; прежний ретроактивный способ решения отменён владельцем в EV09 | Pause действует после confirm/DB commit; уже применённый ledger не пересчитывается. Исторический intake cutoff — отдельное правило |
| CR-03 | Частично: atomic audit уже обязателен ADR-02/04, но wording B23 двусмыслен | Event contract B02, schema B13, запись B15/B20 с первой операции; B23 только projection/query/UI/export |
| CR-04 | Принято: нельзя делать unavailable analytics бессрочным запретом narrow fix | Разделены merge FIX, maintenance deploy и scale/CF v2; ограниченный maintenance risk-accepted путь не называется capacity PASS |
| CR-05 | Это осознанное ограничение предлагаемого MVP, не дефект уникальности | Видимое предупреждение setup/completion; выбор reuse в OD02; source generations не добавляются без потребности |
| CR-06 | Принято в ограниченном объёме; случайный corpus не доказывает полную эквивалентность | Seeded model/differential checks, bounded budgets, shrink; supported subset и адресные regressions сохраняются |
| CR-07 | Принято как public-release checklist, без отдельной security platform | OP-10: trust boundaries, least privileges, credentials/rotation, untrusted inputs, negative checks |
| CR-08 | Принято как конкретизация proof, не новая система ролей | Same-route nonce, bot/member admin evidence, TTL и повторная проверка confirm; fail closed при отсутствии proof |
| CR-09 | Принято: final config gate 1.x не делает revoke мгновенным между Worker versions | Граница отзыва — новый artifact + прекращение старых writers; тест двух configs/drain, без обещания DB epoch для старого кода |
| CR-10 | Новая функция не требуется; P1/owner decisions уже были явными | Scope фиксируется до RC/human TEST; stale reaction в silent объясняется, reconcile после OFF адресный |
| CR-11 | Уточнение владельца выбирает provider-only 1.x, поэтому новый external-backup A-task отклонён | Platform-specific backup gates; hourly RPO/remote verify только v2; PITR bookmark/runbook для Track A |
| CR-12 | Принято с разграничением prototype/release | CURRENT_1X_OBSERVED, SYNTHETIC_WORKLOAD, V2_DEPLOYED_TEST; C01 допускает только prototype decision, CF v2 capacity GO после C02/C03 |

Общий NO-GO ревью на «крупную реализацию до всех OD/live evidence» не распространяется на любую изолированную работу: нужны разрешение на code scope и только относящиеся к задаче решения/входы. Production OD09 всегда отдельный. Указанные reviewer тесты CR-06 добавляются в требования к будущей реализации; тестовые файлы сейчас не редактируются.

## EV09 — Четыре явных решения владельца

Источник: следующее сообщение владельца из четырёх пунктов, 14.11.2026. Это принятые требования, а не рекомендации reviewer; не спрашивать их повторного утверждения. Они заменяют противоречащие части EV07/EV08 и прежней roadmap.

| Решение | Зафиксированное следствие |
|---|---|
| D1 → SQLite отдельно | B28 — самостоятельный migration stream. Не входит ни прямо, ни транзитивно в release dependencies B29/B31/B32; first self-hosted install/public release работают с пустой БД. До отдельной приёмки перенос D1 не рекламируется как поддержанный |
| Пауза только после подтверждения | Preview ничего не меняет. После окончательного confirm одна transaction фиксирует state/policy revision/audit; её commit — начало pause. Нет backdated cutoff, автоматической отмены/обнуления уже принятых вкладов или range reclassification из-за pause |
| Time Travel достаточно | Для текущего production приняты 7 дней D1 provider history с осознанием ограничений. Регулярный внешний backup executor не разрабатывается. Self-hosted v2 external backups остаются отдельным требованием; PITR readiness фактической production DB не выдумывается |
| Сначала P0, потом функции | F03/F04/F05 → regression/review/нужный TEST → безопасный выпуск и сверка A09 → функциональные итерации. Прежнее разрешение начать продуктовую реализацию B до завершения A1 отменено. После P0 release не добавляются обязательная D1 migration или новая широкая фаза архитектурного исследования |

ADR-06 конкретизирует pause через порядок committed admission operations: raw inbox receipt не равен учтённому вкладу; решение проверяет DB policy внутри transaction. Это исключает сравнение cross-chat message IDs и секундные ретроактивные пересчёты. Initial historical boundary, source edits и явные admin corrections остаются самостоятельными правилами; сама pause их не подменяет.

Принятая последовательность не означает выполненных исправлений или выданного конкретному artifact production GO. В этой итерации согласуются только planning Markdown; current production и F03–F05 не меняются.

## Метод и пределы текущей проверки

Прочитаны оба входа; использованы `git status/rev-parse/log/diff --stat`, адресные диапазоны кода и schema, metadata PR/CI/reviews, официальные ограничения. Начальный `git status` в общей папке вернул «not a git repository»; проверки перенесены в оба checkout. Ошибочный путь `test/` в обзорном поиске исправлен на существующий `tests/`. Урезанный большой вывод не использовался как доказательство полного просмотра; критические диапазоны прочитаны адресно.

В этой сессии не запускались product tests/build/drills, Telegram E2E, cloud capacity test, migration или какие-либо production-действия. Финальная проверка разрешённого diff и связности документов записывается в [SESSION_STATE.md](SESSION_STATE.md).
