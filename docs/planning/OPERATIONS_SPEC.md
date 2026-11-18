# Установка, аудит, восстановление и переходы

Статус: DESIGN, 14.11.2026, с принятым владельцем provider-only backup для 1.x (EV08/EV09) и отдельным мигратором, не блокирующим fresh release. Здесь будущие процедуры, не команды для выполнения сейчас. Любое изменение production, webhook/Cron, live schema, merge/push или ownership требует отдельного предметного разрешения. Нет production credentials/identifiers и исполнимого deploy script. [MASTER_PLAN](MASTER_PLAN.md) задаёт scope/OD, [DECISIONS](DECISIONS.md) — инварианты, [BASELINE](BASELINE_AND_DELTAS.md) — факты/review decisions, [VERIFICATION_MATRIX](VERIFICATION_MATRIX.md) — доказательства.

## OP-01 — Поставка и первый запуск

Self-hosted release — готовый Node image, Docker Compose, persistent volume, отдельный secret file, понятная CLI и Telegram wizard. Не требует Cloudflare account, домена, входящего порта, Bun, SQL или приватного checkout. Пользователю нужен постоянно доступный Linux host с диском и сетью; «без платного VPS» возможно на собственном хосте, но не является обещанием нулевой стоимости эксплуатации.

Release manifest: product version/code SHA, dependency lock/image digest, host architectures, Node/SQLite versions, adapter feature set, supported read/write schema ranges, export/backup format, migration/fallback compatibility и известные ограничения. Secret file, OAuth tokens, bot token и encryption key в manifest не входят. Startup проверяет фактическую bundled SQLite version, а не только имя npm package.

| Шаг | Проверка / нормальный результат | При отказе |
|---|---|---|
| 1. Host/volume | Доступен persistent volume, DB directory writable только нужному пользователю, достаточно места | Объяснить путь/место; не создавать временную вместо ожидаемой живой БД |
| 2. Bot identity | getMe соответствует ожидаемому bot_id; token не логируется | Fail closed, показать fingerprint/тип ошибки без токена |
| 3. DB identity/schema | instance/environment/database identity совпадают; supported schema; FK и integrity | Чужую/новую схему не «чинить» startup migration |
| 4. Consumer | Нет configured webhook для polling; process/DB lease свободен; recovery state проверен | Не удалять webhook автоматически; второй consumer не запускается |
| 5. Owner | Локальная защищённая CLI выдаёт одноразовый challenge; кандидат сам открывает DM; оператор подтверждает verified identity на хосте | Первый /start не становится owner; challenge истекает/отменяется |
| 6. Source/campaign | Wizard U04, verified route/boundary, права, report preview | DRAFT, intake закрыт; retry не создаёт дубликат |
| 7. Backup | Provider/retention/key custody выбраны; external round-trip и restore drill пройдены | Не объявлять instance готовым для ценных данных |
| 8. TEST и итог | Изолированный сценарий, human callback, вклад/edit/override/report/silent/restart; читаемый summary | Открытый case, шаг и конкретное следующее действие |

Права/Privacy Mode проверяются фактической контрольной доставкой non-accounting probe в отдельном TEST либо явно разрешённом probe workflow. getMe/heartbeat не доказывают получение обычных сообщений/edits в теме. TEST имеет отдельный bot/DB/volume/environment и outbound allowlist. Restore/upgrade probes не получают production outbound по умолчанию.

Миграции выполняются отдельной операцией после safety snapshot, version/identity preview и согласованного scope. Обычный restart никогда не меняет существующую schema и не назначает новые boundaries.

## OP-02 — Polling, durable acknowledgement и scheduler

1. Получить exclusive process lock на persistent volume и DB lease с fencing epoch. Для одного bot нельзя запускать другой runtime на другом host/DB; local lock этого сам не доказывает. Telegram conflict останавливает consumer, не запускает бесконечную борьбу pollers.
2. На startup проверить webhook/recovery/schema. Первый read неподтверждённых updates не использует слепо старый глобальный max offset из архива. Никаких negative offsets или drop_pending_updates.
3. Каждую полученную пачку нормализовать в достаточные для deterministic processing facts: identity, original/edit/receive times, route metadata, parser result/revision, command/callback typed payload, digest и processing state. Raw participant text не сохранять автоматически. Неизвестный тип/некорректный envelope имеет bounded diagnostic receipt и явное terminal/quarantine решение, а не бесконечный poison retry.
4. Durable inbox transaction сохраняет **всю подтверждаемую пачку**; одинаковый receipt/digest не создаёт новый эффект, конфликт identity/digest фиксируется отдельно. Ack не двигается через update без durable facts. Если используется непосредственное domain application, все подтверждаемые операции уже committed.
5. Следующий getUpdates с offset за последним идентификатором именно этой durable пачки подтверждает её. Inbox processing ведёт свою idempotent state; crash после ack не теряет ещё не применённый receipt. Пустая пачка и смена последовательности после простоя не оправдывают blind saved offset. Правило подтверждения задано [Telegram getUpdates](https://core.telegram.org/bots/api#getupdates).
6. При SIGTERM прекратить новый fetch/claim, закончить/откатить DB transaction, сохранить состояние, корректно освободить lease. Сеть с потерянным результатом → UNCERTAIN attempt. Нельзя считать expired SENDING безопасным retry.

SQLite write transactions короткие, без Telegram/rclone/network внутри, FK включены; WAL/synchronous/disk durability profile закрепляется B03/B04 и crash drill. SQLITE_BUSY retry ограничен, затем incident; disk full не подтверждает потерянный input. Restore из часового backup всё равно может потерять более свежие подтверждённые receipts — это RPO, не исправляемое Telegram ack алгоритмом.

Scheduler использует persisted due cursor, fairness/round-robin campaigns, bounded snapshots/claims/time и monotonic leases. Начальные TEST budgets для настройки: до 3 кампаний, 2 snapshots, 2 delivery attempts за проход; платформа может потребовать меньших лимитов. Долгая работа делится на новые проходы, одна кампания не вытесняет остальные. У Cloudflare один trigger на instance; отдельный Cron на каждую кампанию не нужен. Missed days создаются по period ID без дублей, но recovered публикации не выпускаются автоматически.

Pause/resume не переупорядочиваются по Telegram timestamp: final confirm сохраняет DB policy revision, и только commit меняет admission. Ingest проверяет её внутри своей transaction; durable inbox receipt не равен accepted contribution. Pending original, применяемый после pause commit, получает HELD; ранее committed ledger и totals pause не переписывает. Replay читает сохранённое original admission, а source edits/corrections имеют свой audit. См. принятый ADR-06/EV09.

## OP-03 — Три слоя журнала и безопасная диагностика

| Слой | Содержимое и порядок | Retention / доступ |
|---|---|---|
| Ledger/audit | Учётные решения и дельты, source/settings/role revisions, reasons, causal links, report watermark, попытки и resolutions | Не выключается DEBUG; долговечен по OD10 и входит в backup |
| Operational journal | ingest/admin/reports/outbox/reactions/backup/polling, стадии commit/attempt, timings/errors/correlation | Bounded по bytes/time; DEBUG ограничен временем; не каждый payload в горячей D1 |
| Diagnostic projection | U07/U08, /log по commit order, /trace оригинала/campaign, JSONL/CSV и incident cards | Только current scope, ограниченный диапазон/объём, redaction по audience |

Различаются original_date, edit_date/occurred_at, received_at, recorded_at и commit_seq. Event fields заданы ADR-04; attempt ID не является bot token. Для публичного/ИИ-пакета campaign/source/person identifiers заменяются стабильными aliases, timestamps при необходимости округляются; суммы и причинные связи сохраняются в рамках разрешённого scope. Тексты, username, personal IDs, tokens, secrets, SQL dump и encrypted archives автоматически не прикладываются. CSV cells экранируются как данные, включая formula prefixes; decimal amounts не округляются spreadsheet Number conversion.

Export: actor выбирает campaign/period/type → preview fields/redaction/размер → current scope/CAS → streaming из согласованного watermark → выдача с ограниченным TTL и audit. После revoke старый handle/download не открывается; уже выданные данные технически не отзываются. Большие запросы paginated; публичный debug не превращается в полный dump DB. Долговечный receipt дельты не удаляется при ротации operational logs.

Новые event fields/schema задаются B02/B13 и пишутся B15/B20 до любого U08: B23 не пытается восстановить отсутствовавшие causation/commit facts. Legacy export хранит CAUSALITY_PARTIAL/UNKNOWN и original import references. Ledger/reconciliation export также содержит import_batch, coverage confidence/status и принятую owner risk exception; отсутствие такой истории нельзя обозначить «дублей нет».

Incident 35 должен раскрываться одним trace: исходное время → поздняя редакция → +5000 → report correction → предложенное/реальное admin исправление. Все contributing deltas суммируются до report correction; отсутствие legacy evidence показывается явно. Нельзя утверждать автора ручного override по одному полю correction.

## OP-04 — Health и incidents

U15 и локальная диагностика показывают отдельные факты:

- DB/identity/schema, process/lease epoch и conflicting consumer;
- последний **доказанно полученный** update и последний committed inbox event; полученные и применённые различаются;
- последний **подтверждённо доставленный** report с attempt/message reference; отдельно pending/held/FAILED_KNOWN/UNCERTAIN;
- количество/возраст REVIEW, quarantine, POST_CLOSE_REVIEW, unknown gaps и несверенных периодов;
- для 1.x D1 — доступный PITR диапазон/проверенный bookmark и статус TEST runbook; для Node v2 — verified external backup age, full restore drill и выбранные RPO/RTO; hourly stale threshold не применяется к provider-only 1.x;
- scheduler heartbeat/lag, ingest/outbox latency, DB size/disk reserve, CPU/rows/error outcomes по platform/version.

Health ok означает только пройденные конкретные checks. Оно не доказывает полноту истории, получение отсутствующего update или отправку отчёта. Часы/окно наблюдения и недоступные метрики видны.

Incidents deduplicate по type/campaign/source/policy revision; хранят first_seen/last_seen/count/severity/status/provenance. DM только при существенном изменении/порогах, с bounded reminders. «Acknowledged» не означает resolved; «notice queued» не означает owner notified. Если DM недоступен, локальная health/CLI остаётся источником диагностики, ошибка доставки тоже видна. Backup stale, quota exceeded, membership loss, reaction mismatch и report uncertainty — разные incidents.

## OP-05 — Согласованный внешний backup v2 Node/SQLite

Эта pipeline относится к self-hosted v2, не к Track A. Для D1 1.x владелец выбрал 7 дней Time Travel; регулярные external exports/executor/rotation не планируются. OD04 для v2 ещё выбирает Google Drive/Yandex, key custody, retention, RPO/RTO/drill interval. Предлагаются 4 hourly + 7 daily либо выбранные владельцем 4 hourly; hourly schedule, stale alert >2 ч, full restore drill ежемесячно и после изменения backup/driver/schema, RTO <=4 ч, RPO около часа + snapshot/verify. Это не SLA и не RPO Cloudflare 1.x.

Pipeline одной generation:

1. Взять согласованный Online Backup snapshot активной SQLite или проверенный эквивалент. Скопировать только основной файл активной WAL-БД нельзя. Snapshot watermark и фактические captured_at bounds определяются по самой копии, а не по времени старта upload. [SQLite Backup API](https://www.sqlite.org/backup.html).
2. Проверить integrity/FK/schema/identity, canonical ledger totals и zero overrides в копии. Все временные файлы в защищённом каталоге с ограниченным сроком; backup task не получает право мутировать live ledger.
3. Manifest: generation ID/parent, format/schema/product/SQLite versions, database/instance fingerprint, snapshot watermark/time bounds, checksum, crypto parameters без ключа, completion state. Защитить аутентичность manifest вместе с encrypted payload.
4. Зашифровать до external upload. Ключ не лежит в том же cloud account единственным экземпляром; owner проверяет recovery material отдельно. Кандидат rclone crypt поддерживает client-side encryption; credential/OAuth setup делается защищённо вне Telegram. [rclone crypt](https://rclone.org/crypt/), [Drive](https://rclone.org/drive/), [Yandex](https://rclone.org/yandex/).
5. Загрузить immutable object с уникальным generation name. Незавершённый объект не публикуется как latest verified. Повтор после network failure не перезаписывает старый архив.
6. Скачать новый объект, проверить transport checksum и crypto authentication, расшифровать в отдельное место, выполнить integrity/FK/semantic check. Только после этого mark VERIFIED; наличие файла/успешный upload недостаточны.
7. Обновить verified index и применить retention: удалить старейшие только после нового VERIFIED и проверки минимального числа рабочих generations. Ошибка удаления оставляет лишнюю копию и incident; не удаляет новую/последнюю рабочую. Daily копия может ссылаться на сохранённую generation без дублирования payload, если restore manifest самодостаточен. Generation не удаляется, пока входит хотя бы в один hourly/daily retention set; daily ссылка не может зависеть от уже удалённого hourly payload.
8. Полный drill отдельно поднимает restored TEST runtime, проверяет ledger/edit/override/report hold и измеряет RTO. Периодический semantic check не выдаётся за полный runtime drill.

Faults: process kill между каждым шагом, частичный upload, повреждённый/подменённый manifest, истёкший OAuth, неверный/утраченный key, clock skew, disk/cloud quota, delete denied. В любом случае сохраняется объект последней verified generation и честный stale/failed status. Утрата единственного ключа означает утрату восстановимости даже при наличии этого объекта: LOST_KEY, restore FAIL, никакого обещания обхода шифрования. Отдельный recovery key/custody проверяется владельцем заранее. Подробное fault evidence — SC11. Никакой автоматический restore поверх live БД.

Bundled SQLite проверяется на известные defects: WAL-reset исправлен в 3.51.3 и новых версиях, есть отдельные backports; выбор образа подтверждается фактической version/build и release notes, не только условием «номер достаточно большой». [SQLite release history](https://www.sqlite.org/changes.html), [WAL](https://www.sqlite.org/wal.html#the_wal_reset_bug). 3.52.0 была отозвана; не закреплять её как новый default.

Регулярный external export D1 1.x не требуется по принятой политике. Одноразовый export при переносе платформы — защищённый transfer artifact OP-07; его consistency/INT64 и возможное влияние на queries проверяются отдельно. Он не создаёт бессрочную scheduled-backup обязанность. Для optional Cloudflare v2 C03 явно называет принятую platform backup policy; Worker не получает возможность запускать rclone автоматически.

## OP-06 — Platform restore, RPO и полнота

**D1 1.x / принятое provider recovery.** Семь дней — retention, не RPO=7 дней и не обещание RPO=0. Перед maintenance фиксируется пригодный PITR point/bookmark, timestamp/target identity/schema и observation manifest. Новый bookmark сам по себе не доказывает новые application writes. Реальную процедуру восстановления с проверкой ledger/zero overrides/schema/callback-outbound holds отрабатывают на **отдельной synthetic TEST D1**, а не на production-клоне через Time Travel: метод восстанавливает на месте. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

При аварии owner отдельно выбирает point и допускаемое окно потери, runtime/writers/outbound останавливаются до restore; сохраняются исходный и возвращённый undo bookmark. После in-place restore обязательны schema/identity check, совместимый artifact, recovery/publication hold, admin command cutoff и сверка изменений/отправок после точки. Provider undo также не подменяет сверку новых writes. Обычный code rollback использует актуальную DB и не вызывает PITR. Нет обязательного регулярного внешнего архива для 1.x; зависимость от account/provider и ограниченного retention — явная граница выбранной поддержки.

**Node v2 external restore runbook**, только по отдельному разрешению для живого сервиса:

1. Зафиксировать incident, целевую generation, причину, известный last good watermark, ожидаемую потерю после snapshot и recovery owner. При доступной текущей DB сначала safety snapshot; не затирать источник расследования.
2. Скачать/проверить/расшифровать в отдельную DB/volume, проверить version/identity/FK/INT64/totals, routes, overrides, audit, roles, snapshots, attempts, boundaries и recovery state.
3. Запустить без production outbound в recovery hold. Старые sessions/admin commands инвалидируются новым recovery epoch; intake boundary не смещается.
4. Определить окна: архив покрывает committed seq до S; после S возможны потерянные подтверждённые updates и уже отправленные публикации. Telegram история не является полным backup. Отсутствие report row в архиве не доказывает, что report не публиковался.
5. Сверить доступные events/messages/receipts и Telegram publications. Missing verified contribution импортируется только с reason/provenance/dedup и проверкой opening/legacy import. UNCERTAIN/возможные утраченные send outcomes остаются на удержании.
6. Получить отдельное решение о смене working DB/consumer. Подтвердить один writer, сохранить прежнюю DB и manifest. Только после сверки разрешать конкретные outbound/intake workflows; silent OFF не выпускает старые holds.
7. Закрыть incident с actual RPO/RTO и проверенным reconciled range. Если часть периода неизвестна, оставить unknown gaps, а не «полностью восстановлено».

Для обеих платформ идемпотентность говорит о полученных событиях, не полноте неполученных. При длительном outage updates могут стать недоступны; retention Bot API ограничена 24 часами. U16 ведомость содержит original time/link, effective amount, revision/override/state и import_batch/coverage provenance. Known covered originals повторно не импортируются; PARTIAL/UNKNOWN требует review или отдельно audited owner risk exception ADR-04 с reservation original key, а не label verified. Ручная сверка подтверждает только явно просмотренный диапазон; скачок update_id и тишина не доказывают конкретную потерю.

## OP-07 — Самостоятельный D1 → SQLite migration stream

Этот runbook и B28 нужны только при фактическом переносе существующих D1 данных. Они не входят в fresh-install/public-release gates: новый instance использует пустую SQLite без D1 account/archive/importer. Local schema compatibility, upgrade/restore самого Node instance проверяются независимо в B29.

Это gate/checklist для будущего оператора, а не разрешение выполнять его по тексту. Входы: identities, code/image SHA, schema mapping/ranges, dry-run receipts, platform recovery evidence (1.x PITR point + TEST runbook; Node v2 verified external backup), supported fallback, окно и OD09. D1 → SQLite дополнительно требует consistent transfer export; это не регулярный 1.x backup. При отсутствии критичного входа STOP. Для narrow maintenance применяется G-MAINT/OP-08, не неявный gate масштабирования.

| Этап | Действие и обязательное evidence | STOP |
|---|---|---|
| M0: inventory | Текущие identities/schema, overrides 32/38/35 **по факту**, import/opening/coverage status, controls/outbox, queue/cutoff и platform recovery point | Неизвестная identity/boundary/recovery point; отсутствие coverage не замалчивается |
| M1: freeze/drain | Проверенным TEST способом остановить старые webhook/Cron/poller mutations и in-flight; при config revoke 1.x остановить invocations со старым ADMIN_IDS | «Удалён Cron»/«сделан redeploy» без доказанного drain; старый env/binary ещё доставляет |
| M2: consistent export | Защищённый export после drain, manifest + ledger watermark; pending Telegram queue сохраняется | Нельзя доказать consistency или INT64 precision |
| M3: import offline | Отдельная SQLite: pinned keys/source IDs, NULL/zero/FK, audit/settings/admins/roles, calendar/snapshots, holds/attempts/UNCERTAIN/recovery | Unsupported mapping/schema, потеря audit/попыток |
| M4: compare | Canonical ledger/audit hashes, sums, original ownership, zero overrides, import coverage/legacy-causality flags, no second opening, delivery states/schema fences | Расхождение либо выдуманный VERIFIED/causal history; нормализуются только оговорённые platform fields |
| M5: switch consumer | Webhook/polling exclusivity и single-writer proof; новый runtime стартует с holds и проверенным inbox acknowledgement | Два consumer, чужой webhook или активный старый invocation |
| M6: replay/reconcile | Проверка переходного окна и фактических new updates/edits, no duplicate original/import, manual report сверка | Receipt gaps/uncertain sends нельзя объявлять успехом |
| M7: reopen | Owner принимает reconciliation и отдельно разрешает новые публикации/интейк | Нет blanket release holds/UNCERTAIN; архив старой DB сохраняется |

D1 contract runner не доказывает live export/import, а migration архивного среза не доказывает актуальное production состояние. Известные старые dups не исправляются молча миграцией; correction отдельная operation. Никакого drop_pending_updates.

Rollback: compatible code с той же **актуальной** DB и поддержкой controls/boundaries/holds либо специально проверенная reverse migration с сохранением новых events. Старый snapshot поверх новых вкладов не является rollback. Пока Cloudflare v2 adapter не готов, обратный импорт SQLite v2 → D1 1.x не поддержан. Разные направления объявляются отдельно в release compatibility matrix.

## OP-08 — Capacity audit Cloudflare и engineering budgets

Сегодня cloud capacity UNKNOWN: нет проверенных account metrics, history distribution и resource sharing. F06 — только механизм роста и прежний local D1 probe. Capacity audit использует явно разрешённый read-only account/metrics scope или предоставленный санитаризированный export; при отсутствии inputs выдаёт UNKNOWN, не запускает load в production и не ищет credentials в приватной истории.

Каждое capacity evidence получает класс и assumptions: CURRENT_1X_OBSERVED — реальный текущий single-campaign 1.x artifact/account; SYNTHETIC_WORKLOAD — seeded SQL/adapter fixtures или extrapolation; V2_DEPLOYED_TEST — работающий v2 D1/Worker artifact на изолированном TEST с заявленными capabilities. Synthetic stimulus внутри deployed TEST тоже маркируется, не объявляется native Telegram traffic. 1.x не умеет независимые 3/10 campaigns, поэтому их модель не становится его actual profile.

Для observed/deployed профиля собрать artifact/version/полное окно, HTTP/Cron counts, CPU p50/p95/max/exceededCpu, rows/query counts, storage/history growth, retry/quota errors, outbox/scheduler lag и соседние приложения. Фиксировать sampling, missing fields и stimulus source; local workerd CPU не cloud CPU.

| Профиль | Сравнение |
|---|---|
| Campaigns 1 / 3 / 10 | Actual 1.x — одна campaign; 3/10 до готового v2 только SYNTHETIC_WORKLOAD. Реальные темы/fairness оцениваются на соответствующем v2 artifact |
| История 1k / 10k / 100k contributions | Insert/edit/override/release/replay и full report/reconciliation отдельно |
| Исходящие функции | Reaction off/on, notices, progress/check burst, reports hold/retry; реальные поддержанные parser policies |
| Логирование | Audit минимум + bounded operational/DEBUG; влияние indexes и retention на read/write/storage |
| SQL варианты | Existing SUM против transactional delta projection; cold install, backfill/drill вне ingest |

Расчёт суточного бюджета: сумма events_i × measured rows_i плюс reports/reconciliation/backup/health/другие apps; writes учитывают audit, index и intents. Мантры ≠ сообщения: goal 1000000 не означает миллион строк. Иллюстрация риска, **не cloud measurement**: 1000 новых операций при локально измеренных 10002 rows на одну goal check дадут ~10 млн rows только на этот check.

Предлагаемый G-SCALE/OD07 при x2 ожидаемой нагрузке: <=70% account day quotas с учётом соседей, p95 CPU <=8 ms отдельно HTTP/Cron, no exceededCpu/quota errors, bounded work/lag и запас storage. Missing metrics → UNKNOWN. Free limits в [EV06](BASELINE_AND_DELTAS.md): 100000 requests/day, 10 ms CPU, 5 млн read/100000 write rows/day, 500 MB/DB, 50 calls/invocation; batch не делает SQL бесплатными. Для 1.x actual single-campaign budget и для v2 multi-campaign budget — разные verdicts. CF v2 GO_TO_SUPPORT требует V2_DEPLOYED_TEST после C02; C01 может дать лишь ограниченный GO_TO_PROTOTYPE с assumptions/budget.

**Сокращённый G-MAINT при недоступной analytics:** A08 документирует ровно исправляемый F03/F04/F05 scope, отсутствие scaling/новых features, адресные regressions и local cost delta, доступные error/ingest/outbox/DB observations, заранее заданное окно контроля и compatible fallback, который понимает controls/final authorization. Owner отдельно принимает residual capacity risk и OD09 artifact/window. Результат MAINTENANCE_ONLY_RISK_ACCEPTED; A07 остаётся UNKNOWN/ожидающим, не PASS. STOP при known quota failures, необъяснённом росте работы, ledger mismatch, старых writers, DB/identity/boundary errors, ухудшении lag относительно оговорённого baseline или отсутствии наблюдаемости результата. Outbound uncertainty удерживается. Такой путь не разрешает scale-up или CF v2.

Если gate не пройден: ограничить scheduler/pagination/log budget → устранить измеренный горячий SUM через проверяемую delta projection → повторить только затронутый профиль → предложить владельцу Paid/self-hosted/ограниченный scope. Увеличение нагрузок/кампаний до закрытия дефицита запрещено. Платный тариф не выбирается автоматически и не является доказательством целесообразности Cloudflare v2.

Синтетические forecast 3/10 campaigns не требуют реализовать multi-campaign в 1.x ради A07. Отсутствие cloud metrics не блокирует G-FIX, изолированные contracts или подготовку narrow fix; не закрытые OD/live evidence блокируют только соответствующие действия.

## OP-09 — Ownership recovery и независимая приёмка

Утрата Telegram owner account: защищённый local operator access → остановка mutating runtime → verified safety snapshot → preview текущих grants и verified нового account → отдельное подтверждение recovery/transfer → audit + auth/recovery epoch → аннулирование старых sessions/invites/exports → scope/restart TEST. Recovery material не хранится только в утраченном аккаунте. Root host access определяет trust boundary; свободная Telegram команда owner не назначает. Последнего owner удалить без завершённого transfer нельзя.

Cold install B29 выполняется с пустой SQLite другим человеком на чистом Linux, только из public release instructions/image и собственного TEST token; D1 credentials/archive/мигратор B28 не требуются. Проверяет bootstrap, topic enrollment, вклад/edit/override, callbacks, report/silent, reboot, remote backup, full restore, upgrade/fallback и diagnostic export. Фиксирует реальные versions/SHA, duration, failed steps и support gaps; исправленные инструкции проходят только нужный повтор. Отсутствие Cloudflare/Bun/domain/private bindings подтверждается процессом установки, не текстом README.

Первый fresh-install release не ожидает B28/SC24-MIGRATE и не заявляет поддержку D1 import до отдельной приёмки.

Публичный release допускается после лицензии OD08, закрытия P0-I/P0-U заявленного feature set, human acceptance и release manifest. Ожидание необязательных reactions/check или Cloudflare v2 не блокирует release, если omissions прямо объявлены и владелец принял scope. Production Сангхи не мигрируется в ходе cold install.

## OP-10 — Trust boundaries и public-release negative checks

Короткий checklist применяется к self-hosted/public release до B29 cold install: B03/B12/B18 реализуют необходимые controls, B29 их проверяет, B31 собирает evidence. Это не новый prerequisite срочного G-FIX и не отдельная security platform. Host/operator с root-доступом — доверенная граница: такой доступ позволяет прочитать local secrets; контейнер не обещает защиту от скомпрометированного host.

| Граница / риск | Control и обязательный negative check | Карточки |
|---|---|---|
| Telegram token / webhook ingress | TLS, identity и webhook-secret checks, no token logs. При утечке owner останавливает mutating/outbound, перевыпускает token через доверенный канал, меняет webhook secret/credentials, проверяет getMe/webhook/consumer и unknown window до restart; чужой token/identity не стартует | B07/B12/B31 |
| Local bootstrap/recovery | Challenge >=128 random bits, одноразовый, actor/instance/epoch-bound, TTL 10 мин; local operator подтверждает identity. Replay, expired/wrong actor, remote self-claim и повторный bootstrap занятой DB не назначают owner | B12/B18 |
| Container / volume / secrets | Non-root process, no privileged mode/Docker socket, read-only root filesystem с явно разрешёнными DB/temp volumes, secret files с минимальным доступом. Нет случайного ephemeral DB fallback; permission denied/disk full дают fail closed, diagnostics не печатают env | B12/B29 |
| OAuth/cloud backup | Минимальные документированные scopes выбранного provider, ciphertext до upload, отдельный key custody. Compromised OAuth может удалить доступные объекты — encryption не гарантирует availability. Revoke/rotate credential, corrupt/delete remote generation и lost key дают честный failed/stale restore | B10/B11 |
| External message/link/export input | Typed/schema/size validation и SQL parameters; /check разбирает допустимую Telegram reference, не fetch произвольного URL. Malformed callback/JSONL, CSV formula, неожиданный path/schema/SQL extension не исполняются как code/commands | B17/B23/B26/B29 |
| Diagnostic package / archive | Audience redaction, auth/integrity/format checks, bounded extraction/import и запрет auto-execution инструкций из данных. Подменённый manifest/payload, path traversal либо foreign identity не импортируются в live DB | B11/B23/B29 |
| Image/dependencies/update | Pinned digest/lock/version manifest, проверяемые release hashes и documented upgrade source; неизвестный/mismatched artifact не становится automatic latest. Проверить фактические driver/SQLite versions и secret scan | B03/B12/B31 |

Credential rotation и account recovery — отдельные owner-authorized операции с audit/reconciliation, без credentials в support export. Checklist доказывает результаты конкретных negative checks, не отсутствие всех уязвимостей; scope unsupported/unknown остаётся в release notes.
