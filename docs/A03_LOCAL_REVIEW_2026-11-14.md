# A03 / F05 — пакет независимого локального ревью

14.11.2026. Статус исполнителя: **LOCAL_VERIFIED**. Область: maintenance 1.x A03/F05. Независимое ревью candidate ещё требуется. Production readiness, merge и deployment не заявляются и не разрешаются этим пакетом.

## Base, дерево и изоляция

Точный base: **`729736f83095937d0bfb5b4ea6233857dbd0819e`**, одобренный A02. Точный candidate и его единственный parent записаны в `test-results/a03/manifest.json`; patch строится непосредственно от этого base. Candidate сохраняет ancestry A01 (`95d99fae3fef3f7a1dc537a40a5e50e48913f407`) и A02.

На входе фактически обнаружены:

| Дерево | HEAD | Status |
|---|---|---|
| `sangha-mantra-bot` | `65e54e3a81197e09c76fad21460c197d2d300e2f` | чистое |
| `sangha-mantra-bot-public` | `b7cc125a47c4b791cdafefcd22dbc1859a8f126f` | 7 modified, 4 untracked entries; незакоммиченные A01/planning inputs |
| `sangha-mantra-bot-a02` | `729736f83095937d0bfb5b4ea6233857dbd0819e` | чистое |

Из `sangha-mantra-bot-public` выполнен только локальный `git clone --no-hardlinks --no-checkout` в **`sangha-mantra-bot-a03`**, затем создана ветка **`local/a03-f05`** от точного base. Это отдельная копия с собственным Git index/objects, не новый worktree исходного общего Git. Исходные ветки, файлы, index и соседние worktrees не использовались для изменений. `original-before.json` / `original-preserved.json` фиксируют HEAD, porcelain status, worktree inventory и SHA-256 всех tracked/nonignored untracked файлов трёх исходных деревьев.

Прочитаны актуальные BACKLOG A03, SC09/RQ09 и относящиеся ADR-07/границы verification matrix. Backlog по-прежнему имеет исторические PLANNED/NOT IMPLEMENTED, включая уже одобренные A01/A02; он сохранён без переписывания. Текущий запрос разрешает только A03. Новая архитектурная фаза не проводилась.

## Дефект и полный путь notice

`worker.fetch()` проверяет Telegram envelope, source context и mapping; `parseAmount()` формирует решение. `ingest()` атомарно записывает `event_log`, меняет `contributions` и суммы. Затем Worker создаёт participant notice через `enqueueNotice()`, ранее с одним ключом `rejected:<chat>:<message>`, и запускает `deliverNotices()` через `waitUntil`. Cron вызывает тот же sender. `/notice_retry` возвращает явно проверенный intent в PENDING; `/silent` и `publication_hold` ограничивают выборку и claim.

Sender переводит истёкший SENDING в UNCERTAIN, выбирает до двух PENDING, захватывает каждый CAS-claim и повторно читает публикационную политику. На base после этого проверялась только A02 admin authorization, затем вызывался Telegram и claim-fenced finish. Между очередью и API не было проверки source state: исправленный и принятый вклад всё ещё мог получить старое предупреждение.

## Источник истины и исправление

Источник истины — **подтверждённая строка `contributions` и её `last_event_key`**, связанный с immutable `event_log`. Время очереди, `updated_at`, `received_at`, `update_id` и строковый порядок ключей не служат порядком версий. Существующий `ingest()` решает порядок по исходному message identity, `original_date`, `version_date` (`edit_date ?? date`) и `is_edit`: более поздняя версия применяется; edit при той же секунде имеет приоритет над original; одинаковый подтверждённый content не двигает pointer; конфликт одной версии переходит в REVIEW. Повтор старого APPLIED receipt не применяет его повторно благодаря nonce. Эти правила не менялись.

Миграция **0009** добавляет nullable `notices.source_event_key`. Новый Worker явно передаёт ключ того event, который создал intent. `rejected:<chat>:<message>:<event_key>` даёт неизменяемый intent каждой несохранённой ранее ревизии. Это идентификатор дедупликации, а не доказательство актуальности. Старый PENDING/claimed intent не перезаписывается новым payload. Если предупреждение для этого исходного сообщения уже подтверждено SENT, `INSERT ... SELECT` сохраняет прежнюю once-per-message семантику и не создаёт новые предупреждения.

**Финальный SQL gate**, после claim и непосредственно перед A02 authorization/API, проверяет одновременно:

- campaign, SENDING и текущий claim token;
- publication hold и текущую `/silent` policy;
- для namespace `rejected:` — явный `source_event_key`, event/contribution campaign, source chat, message/reply ID и исходную дату;
- точное совпадение `contributions.last_event_key` с event intent и отсутствие override, включая override `0`;
- INVALID/APPLIED и совпадение `version_date`/`is_edit`, либо текущий REVIEW/NEEDS_REVIEW.

Для REVIEW существующий core намеренно сохраняет дату/флаг последней однозначной версии, а pointer указывает на конфликтующий event. Поэтому равенство version_date/is_edit требуется для INVALID, а REVIEW подтверждается pointer и outcome. Несовпадение исходной даты не разрешает participant warning; существующий операторский alert о REVIEW остаётся отдельным механизмом.

При stale source sender атомарным D1 batch записывает `NOTICE_SOURCE_STALE` и переводит intent в **FAILED_KNOWN**, с `last_error='Source revision no longer confirms warning'`, NULL sent ID и очищенными claim/lease. Audit содержит notice reference и reason code без body/token. Оба statement ограничены campaign/state/claim и повторно проверяют source в transaction. Отказ любого statement откатывает audit и state вместе. Это известный non-send, не подтверждение доставки. PENDING-only sender больше его не повторяет. Ручной `/notice_retry` проходит тот же fence заново.

Legacy `rejected:` без source reference **не backfill-ятся догадкой** из ключа/created_at: при попытке доставки они завершаются тем же известным отказом. Удержанные `/silent` строки остаются held до прежней явной процедуры; после OFF нет автоматического release. Новые revision intents могут увеличить число held строк; это не новые отправки. `/notice_sent` по-прежнему является ручным подтверждением оператором после проверки Telegram и не вызывает API.

## Воспроизводимый red-on-base

До изменения `src/`/миграций выполнено:

```sh
bun test tests/notice-source.test.ts tests/notice-source-runtime.test.ts -t 'F05 invalid queued'
```

Результат: **0 PASS / 2 FAIL, exit 1**, SQLite и настоящий локальный D1/workerd. После `bad → очередь → good` вклад равен `108`, но transport получил `warning:bad`. Production diff был пуст; exact HEAD и SHA-256 тестов сохранены в `red-on-base.json`.

После завершения воспроизведение повторено финальными тестами на чистом `git archive` exact base. `reproduce-red.py` создаёт временную копию, копирует только четыре source-fence test files, подключает pinned node_modules и запускает ту же команду. Все `src/*.ts` до/после совпадают с base; снова **0 PASS / 2 FAIL**, exit 1. Скрипт возвращает 0 только при подтверждённом ожидаемом red. Evidence: `red-on-base-final.log/.json`. На base новый необязательный аргумент enqueue игнорируется JS; проверяется прежний sender, а не shim исправления.

## Проверки

Все проверки локальные: `CI=true WRANGLER_SEND_METRICS=false`. Полные stdout/stderr и фактические exit codes сохранены отдельно в `test-results/a03/`.

| Проверка | Результат | Evidence |
|---|---|---|
| Первый corpus F05, SQLite + D1/workerd | 32 PASS / 0 FAIL | `focused-initial.*` |
| Итоговый targeted F05 + A01/A02/maintenance | 136 PASS / 0 FAIL, 668 assertions, 7 files | `focused-final.*` |
| Полный typecheck + весь suite: `bun run check` | 303 PASS / 0 FAIL, 1372 assertions, 21 files; exit 0 | `check-final.*` |
| Отдельный typecheck | exit 0; полный check также включает итоговые тесты | `typecheck-final.*` |
| `bun run build` | exit 0, Wrangler `deploy --dry-run --env test`, без upload | `build.*` |
| Собранный Worker, webhook → D1/outbox → Cron | PASS; исправленный 108 не получает warning, следующая invalid revision доставляется один раз | полный check; `notice-source-runtime.test.ts` |
| Реальный D1 upgrade 0008 → 0009 | PASS; legacy body, NULL revision и A01 controls сохранены; unbound notice не вызывает transport | тот же runtime file |
| Backup/restore drill с 0001–0009 | локальный Wrangler D1 export, отдельный SQLite restore/reimport; результат в `backup-drill.json/.log` | локальные synthetic данные |
| Base replay, whitespace, apply/tree equality, bundle, сохранность исходных деревьев | результаты и hashes в manifest/packaging evidence | `packaging-checks.json`, `original-preserved.json` |

25 одинаковых source-fence сценариев на каждом SQL engine, плюс два runtime integration tests. Они охватывают восемь запрошенных последовательностей: invalid→valid; истинно invalid; invalid→valid→другой invalid; exact duplicate/поздний original/старый edit; concurrent sender CAS; SQL gate error и реальные `RAISE(ABORT)` в обеих половинах cancellation; silent ON/OFF/explicit release; A01/A02 regression corpus. Дополнительно проверены edit в ту же секунду, REVIEW conflict, no-number edit, override0, wrong original date/route, late enqueue, одинаковый invalid content в новой версии, ingest rollback, повтор после FAILED_KNOWN/UNCERTAIN и один audit при concurrent cancellation. Fixture refs: source chat `-1001`, message `10`, events `bad/good/bad2`, intent `rejected:-1001:10:bad`.

Integration probe собирает настоящий `src/worker.ts` через Bun с test-only wrapper, который детерминированно дожидается `waitUntil` перед следующим входом. SQL trigger временно задерживает warning в очереди, затем отдельный Cron исполняет настоящий sender. Telegram полностью заменён локальным outboundService. Самостоятельный Wrangler dry-run artifact хранится в `dist/`; runtime integration не объявляется проверкой удалённого deployment.

Промежуточные ошибки не скрыты: standalone typecheck сначала нашёл типы fetch mock и несуществующий `Response.waitUntil`; expanded run — этот же probe API, новое число warning deliveries и недостающую 0009 в старом migration fixture. Probe исправлен wrapper-ом, SENT dedup сохранён в реализации, fixture применяет additive 0009. Первый полный check: 302 PASS / 1 FAIL — старый matrix ожидал одну held строку вместо трёх revision intents; исправлено ожидание представления очереди с дополнительной проверкой hold/source binding, ноль отправок сохранён. Логи этих прогонов сохранены; authoritative — итоговые результаты таблицы.

## Конкурентность, отказы и TOCTOU

Один intent захватывается одним sender через существующий CAS. Конкурентный проигравший не может отправить, завершить или отменить чужой claim. Source changes, подтверждённые **до финального SQL-read**, блокируют старый запрос; несколько queued редакций разрешают только последнюю подтверждённую. Последующее enqueue старого APPLIED replay не возвращает source pointer назад и не rearm-ит terminal notice. Повторный update с тем же content не создаёт новый warning при UNCHANGED.

Исключение D1 до разрешения отправки не вызывает API. Сбой audit/state cancellation оставляет исходный claim SENDING без частичного audit; по истечении lease он становится UNCERTAIN. Нет blind resend. Сбой ingest откатывает новую версию: предыдущий подтверждённый INVALID остаётся истиной, и его предупреждение допустимо. Если ingest уже committed, но enqueue упал, webhook retry может восстановить intent; даже поздний enqueue связан с исходным event и проходит fence. SQL-отказ после вызова API остаётся прежней uncertain-delivery границей: этот пакет не обещает атомарный DB/Telegram finish.

**Остаточное окно существует:** между выполнением последнего D1 read и внешним Telegram API нет общей transaction. Worker не добавляет await между разрешающим read, A02 config authorization и вызовом transport, но другой invocation может успеть commit-нуть edit, override или silent ON после read. Уже разрешённый запрос может завершиться после такого изменения. Это показано детерминированными before/after-read тестами на обоих engines. Изолированная проверка не исключает физическое завершение уже начатого старого warning или пересечение запросов разных revisions внутри этого окна. CAS гарантирует отсутствие двойной автоматической попытки одного intent, не exactly-once сети при ручном разрешении UNCERTAIN. Необработанные/ещё не доставленные Telegram edits в D1 не видны.

## Сохранность A01/A02 и границы diff

В base проверяются все девять source hashes A01 snapshot и все шесть A02 source hashes из их review manifests. В candidate `src/controls.ts`, `src/core.ts`, parser, migrations 0001–0008, backup drill и оба maintenance regression files неизменны. В `src/admin.ts` весь блок от комментария `All administrative outbox producers` до EOF побайтно равен A02: admin final authorization, NOTICE_AUTH_DENIED batch, result finish и command/recovery handling сохранены. Актуальный final source read находится перед ним. `preservation.json` фиксирует hashes/сравнения.

Существующие tests изменены только для нового binding у synthetic participant warnings A02, применения 0009 перед текущим enqueue в A01 migration test и числа immutable held intents в numeric matrix. Они не ослабляют silent ordering, authorization, delivery counts или parser expectations. Остальные A01/A02 сценарии проходят без переписывания. Исходные пользовательские деревья проверены отдельно; их незакоммиченные изменения не импортировались поверх A03 и не терялись.

Production diff ограничен `src/admin.ts`, `src/worker.ts` и additive `0009_notice_source_revision.sql`; parser/domain ordering/ledger/queue state enum не менялись. Нет новой общей notification framework, background job или DB grants.

## Rollout-риски и ограничения

До любого rollout нужны независимое ревью exact candidate, применимые остальные maintenance gates и отдельное live-разрешение. Этот пакет не выполняет внешних действий.

- Новый Worker требует 0009; отсутствие column вызывает отказ SQL, а не fallback-send. Миграция additive, старые queue states/holds сохранены. Сначала обеспечить согласованную остановку/drain старых senders, затем миграцию и проверенный новый artifact по отдельно принятой процедуре. Параллельный старый sender игнорирует fence и способен воспроизвести F05.
- У legacy warning без доказуемого event binding пропускается доставка даже если сообщение фактически ещё invalid. Автоматический backfill/reset и `/notice_retry` не создают доказательство. Это осознанная fail-closed совместимость; нужен отдельный операторский разбор.
- Устаревший intent отображается в существующих `/notices`/status как FAILED_KNOWN с причиной. Это может увеличить число видимых failed/held строк и операторский шум. Во время silence новые source revisions сохраняют отдельные удержанные intents; OFF их не отправляет и не очищает.
- Успешный send использует прежнее число SQL round trips; final read содержит индексируемые event/contribution joins. Enqueue содержит поиск уже SENT warning; cancellation требует дополнительного batch. Рост числа revisions и эксплуатационная стоимость не измерялись: capacity PASS не заявляется.
- Rollback не должен возвращать sender без A03 fence или терять A01 ordering/A02 authorization. Additive column можно сохранить; безопасный fallback при сомнении — остановленный outbound/удержанная очередь до проверенного совместимого artifact. Массово сбрасывать UNCERTAIN/FAILED_KNOWN нельзя.
- Native Telegram, реальные Cloudflare/D1, live drain, PITR/cutover, нагрузочная проверка и production readiness не проверялись. TOCTOU между D1 и Telegram устранён не полностью и не объявляется устранённым.

## Пакет и повторение

`A03.patch`, incremental `A03.bundle` (требует base), `source-files.sha256`, `artifact-files.sha256`, `manifest.json` и `manifest.sha256` лежат в `test-results/a03/`. Manifest содержит exact base/candidate, environment fingerprint, команды/exit codes, preservation/packaging results и SHA-256 evidence. Архив evidence расположен рядом с каталогом; его SHA-256 хранится отдельным файлом.

В репозитории с доступным base применить `git apply --check A03.patch`, затем patch в отдельной копии; проверить `source-files.sha256` и pinned dependencies. Для red-on-base: `python3 test-results/a03/reproduce-red.py` из распакованного пакета. Для candidate: `bun run check`, targeted command из `focused-final.json`, `bun run build`, `bun run backup:drill`. Последние два используют только dry-run и локальный synthetic drill соответственно.

Удалённый Git, PR, merge, deployment, реальные Cloudflare/Telegram, secrets и production state не изменялись. Создан один локальный A03 commit и review artifacts в отдельной копии.
