# Архитектура и рекомендуемые решения

Редакция: 14.11.2026, после независимого review. ADR ниже — **DESIGN / рекомендовано к принятию**, кроме явно отмеченного решения владельца о platform-specific backup. Это не утверждение о готовом коде. Подтверждённые ограничения задания и учётные инварианты обязательны; продуктовые defaults и эксплуатационные компромиссы перечислены как OD в [MASTER_PLAN](MASTER_PLAN.md). Факты и разбор CR-01…CR-12: [EV01–EV09](BASELINE_AND_DELTAS.md). Задачи: [BACKLOG](BACKLOG.md); проверки: [VERIFICATION_MATRIX](VERIFICATION_MATRIX.md).

## ADR-01 — Порядок платформ

**Решение:** рекомендовать B: стабильная Cloudflare 1.x + self-hosted-first 2.0. Модульный монолит сохраняется. Вынести узкие транзакционные контракты, доказать один набор правил на D1 1.x и настоящем Node/SQLite, получить single-campaign self-hosted foundation, затем добавить Multi-Campaign и полную Telegram-админку в SQLite. Поддержка Cloudflare v2 — отдельный ограниченный gate, а не условие self-hosted release.

| Критерий | A: D1 Multi-Campaign → Node | B: Cloudflare 1.x stable + Node-first | C: thin contracts + Multi-Campaign только в TEST D1 |
|---|---|---|---|
| Ценность по этапам | Темы раньше на существующем hosting; самостоятельная установка позже | Сначала переносимость, backup и восстановление; темы после рабочего Node runtime | Ранняя проверка модели, но ещё нет нового продукта у пользователя |
| Один сопровождающий | Один runtime до переноса; затем повторная эксплуатационная приёмка | Раньше появляется Linux packaging/backup burden; нужны ясные границы поддержки | Временно нужно держать experimental D1 и старый код; риск затяжного исследования |
| Риск миграции живой базы | Переход на новую схему D1 требуется раньше полезного self-hosted | Production 1.x можно не мигрировать весь период разработки 2.0 | Production не затронут; эксперимент ещё надо перенести в поставку |
| Риск расхождения моделей | Меньше до Node; D1 constraints могут проникнуть в общие правила | Выше из-за двух версий схемы; ограничивается corpus и отсутствием двух accounting cores | Высок, если TEST реализация превращается в третью ветку поведения |
| Cloudflare Free | Нужен ранний реальный capacity gate; сегодня нет метрик аккаунта | Не служит ограничителем дизайна 2.0; Track A всё равно нуждается в capacity audit | Достаточно ограниченного TEST бюджета; не доказывает cloud production capacity |
| Стоимость двух adapters | Отложена, но обязательна для публичной переносимости | Общие контракты проверяются сразу; feature parity Cloudflare v2 не обещается | Не устраняет будущую стоимость Node/backup/upgrade |
| Публичный релиз | Позже достигается цель «без Cloudflare/домена/Bun» | Прямой путь к этой цели; задержка тем до runtime foundation | Полезен только как короткий ответ на конкретный технический вопрос |
| Обратимость | До migration простая; после нужен совместимый D1 fallback | В любой момент можно остаться на исправленной 1.x; Node alpha не импортирует live данные | Эксперимент можно удалить, если нет live данных; sunk cost ограничить |

Основание выбора B — пользовательская цель самостоятельной установки и отсутствие необходимости рано переводить живой ledger на Multi-Campaign. F06 подтверждает дорогой SUM, но не исчерпание Free. У B есть реальная цена: обслуживание хоста, ключей, диска и двух schema generations. Docker не устраняет эту работу.

**Когда лучше A:** оператор не готов поддерживать постоянно доступный Linux-хост; независимые темы нужны раньше переносимости; измеренный Cloudflare кандидат проходит budget; оплата подходящего тарифа допустима владельцу; одна D1 migration/drill дешевле более раннего Node foundation. Тогда ADR пересматривается до schema work, corpus и узкие contracts сохраняются.

**Когда применить C:** есть конкретный нерешённый D1/SQL вопрос, способный изменить B. Выделить не более одной–двух S-сессий, disposable данные, заранее сформулированный вопрос и выходной receipt. Полный UI/production transition в C не входит.

**Ограничитель абстракций:** B01/B02 — максимум три небольшие итерации без изменения доменных правил. При превышении остановить выделение интерфейсов, сохранить corpus, упростить границу и пересмотреть объём. ORM, DI framework, универсальная transaction framework, PostgreSQL, broker, SaaS и перепись не обоснованы.

**Решение владельца EV09:** сначала исправления P0, их проверка и безопасный выпуск A09; сразу затем функциональные итерации B. Прежний допуск начать продуктовую реализацию B до A1 отменён. Мигратор B28 — самостоятельный поток, не gate первого fresh-install релиза. Остальные технические альтернативы ADR сохраняются для оценки; четыре принятых решения повторного согласования не требуют. Конкретный live artifact/window проверяется отдельно.

## ADR-02 — Одно ядро правил и атомарный Storage

Один экземпляр = один bot token, одна instance identity, одна database identity. Несколько независимых кампаний внутри него; несколько токенов в одной БД не поддерживаются. Общие нормализация, parsing/version rules, decimal arithmetic, policy decisions, report rendering и сценарии контрактов живут в одном репозитории. SQL, transaction execution, polling/webhook, secrets и filesystem — adapters. Общая SQL-сборка допустима внутри storage; одинаковые имена интерфейсов не доказывают эквивалентности.

Storage принимает **предметные операции**, а не произвольный пользовательский callback транзакции:

| Операция | Что обязано commit вместе | Результат |
|---|---|---|
| receive/apply contribution | durable receipt, route/boundary/policy/version decision, source row, effective delta, audit, totals, актуальные outgoing intents | APPLIED / UNCHANGED / STALE / REVIEW / REJECTED / QUARANTINED с event ID |
| apply admin transition | current authorization, expected versions, receipt, override/release/adjustment либо session step, завершение session, audit и ответное intent | одно применение либо conflict/denied; повтор возвращает прежний результат |
| change settings/roles | scope, CAS, effective-from, diff, versions, invalidation pending sessions/exports/intents | новая revision, без скрытого переноса истории |
| enroll source | ownership proof, route uniqueness, source identity, boundary/provenance, activation, audit | ACTIVE либо безопасный DRAFT, без частично открытого route |
| create snapshot | один report period, consistent ledger watermark, суммы/goal/name/calendar revision, immutable body/hash и delivery intent | существующий либо новый snapshot |
| claim/finish delivery | lease/attempt identity, frozen destination/payload revision; state transition только владельцем claim | один claim; истёкшая начатая попытка UNCERTAIN |
| resolve quarantine/delivery | scope, expected case revision, proof/reason, audit, учётная операция либо разрешение одной отправки | отсутствие повторного эффекта при повторном callback |

Нельзя разносить «override», «закрыть диалог», «записать аудит», «поставить ответ» на независимые commits. Любая ошибка до commit откатывает всё. Receipt ingestion может быть отдельной короткой durable inbox transaction; ledger application затем атомарна и идемпотентна по этому receipt. Подтверждение Telegram допускается только после durable receipt с достаточными данными для повторной обработки либо после всей domain transaction.

D1 adapter использует условный SQL/batch без интерактивной транзакции с сетевыми await. Атомарность, rollback и nonce/CAS guards проверяются под workerd; [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/). Node adapter: короткий BEGIN IMMEDIATE, FK включены, ограниченный SQLITE_BUSY retry, один ledger writer, сеть вне транзакции. Семантика блокировок: [SQLite transactions](https://www.sqlite.org/lang_transaction.html).

Contract runner выполняет один corpus на реальном workerd/D1 и Node/SQLite. Сравниваются canonical decimal strings, NULL, оригинальные ключи, effective amounts, events/causal links, reports, controls, holds и outcomes; платформенные IDs/таймеры нормализуются явно. Мок D1 поверх bun:sqlite не заменяет ни один из этих runners. Сохранение 1.x schema в D1 допускает feature subset; отсутствующие v2 операции возвращают UNSUPPORTED, не другую арифметику.

B02 фиксирует event schema/version и минимальную независимую модель ledger до нового учёта; B13 задаёт её durable representation; B15 пишет обязательные before/after/delta, commit/correlation/causation и policy revisions с **первой** transaction, B20 — snapshot watermark с первого snapshot. B23 строит queries/UI/export поверх уже записанных facts. Legacy backfill маркирует CAUSALITY_PARTIAL/UNKNOWN: новое import/recorded sequence не выдаётся за восстановленный исторический commit order.

К адресным fixtures добавить bounded seed-воспроизводимые valid/invalid sequences и сравнение с простой oracle-моделью, не использующей SQL adapters. Проверяются totals, original uniqueness, overrides, revisions, outcomes и audit deltas; допустимые race outcomes заданы явно. Один seed/feature set проигрывается на обоих adapters только для общего supported subset; v2 pause/recovery cases на D1 1.x не объявляются parity. Неудача сохраняет seed и shrinking/minimal trace (удаление шагов/упрощение inputs). Размер и время CI corpus ограничены; он растёт вместе с B15/B20, не превращает B01 в framework и не заменяет production regressions или доказательство всех возможных последовательностей.

Node 24 LTS + better-sqlite3 — кандидат B03; версия driver, bundled SQLite и image digest закрепляются только после проверки INT64/backup/x64/arm64. Node 26 рассматривается при измеримом выигрыше; одновременно два Node majors и Bun runtime не обещаются. Bun может остаться dev-инструментом; готовая поставка и операции не требуют его у пользователя. [Node releases](https://nodejs.org/en/about/previous-releases), [driver API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md).

## ADR-03 — Identity, темы и граница учёта

| Сущность | Неизменяемое / ограничение |
|---|---|
| Instance | bot_id, instance_id, логический database_id, environment; отдельные supported schema range и recovery epoch |
| Campaign | campaign_id; изменяемые display name, goal, settings revision и lifecycle |
| Source | source_id; route (bot_id, original chat_id, thread_id или NULL), campaign_id, enrollment evidence; source нельзя перепривязать другой кампании |
| Destination | chat_id + optional thread_id, revision; независим от Source |
| Contribution | оригинальный ключ (bot_id, original_chat_id, message_id), pinned campaign_id/source_id, original_date; thread не входит в ключ |
| AdmissionPolicy / OriginalAdmission | текущая ACTIVE/PAUSED revision и transition sequence; original key, итог первого admission, policy revision/sequence. Historical source boundary хранится отдельно |
| ImportBatch / Coverage | связь с существующим aggregate entry, declared amount/date, protected evidence reference/hash, known original keys/amounts и completeness status; не второй баланс |
| Inbox/Quarantine | receipt identity, digest нормализованного события, минимальные routing/version facts, reason, processing state |

В одном bot/DB физический существующий PK (chat_id,message_id) допустим. Добавление source_id или thread_id не ослабляет эту уникальность. Для routes нужны две partial unique constraints: chat route при thread IS NULL и topic route при thread IS NOT NULL; обычный UNIQUE с NULL недостаточен. Дополнительно forum chat запрещает whole-chat fallback. MVP: один активный intake route на новую кампанию; legacy aliases и chat migration — специально проверяемое исключение, не функция объединения разных групп.

Enrollment сохраняет проверенный chat kind/forum mode с provenance/revision. Отсутствие is_forum в очередном update не превращает известный forum в обычный чат. Противоречие нового metadata сохранённому mode требует проверки/quarantine, а не расширения route. Логическая database identity сохраняется при переносе; физический D1 resource ID/SQLite volume fingerprint фиксируется отдельно в transition manifest и проверяется для нового backend.

Маршрутизация в порядке:

1. Исключить commands, bot/service/media/forward inputs согласно parser policy. Bot-to-bot исключение остаётся только в изолированном TEST.
2. Сначала найти известный оригинал по original key. Отсутствие thread в edit использует сохранённый source; явно противоречащая тема → quarantine без переноса или изменения прежнего эффекта.
3. Новый original проходит initial historical boundary и current admission policy внутри атомарной операции. Pause проверяется по committed DB state ADR-06; уже учтённый original не пересматривается из-за pause. Неизвестная тема не переходит в whole-chat campaign. Для known chat — minimal quarantine; для unknown chat — bounded ignore/diagnostic без накопления чужих текстов.
4. Missing/inconsistent forum metadata не трактуется как General topic. General подключается лишь после отдельного реального TEST и описанного adapter mapping; до этого мастер честно сообщает, что такой маршрут пока не поддержан.
5. Pause/source disable действует для новых admission после commit подтверждённого перехода, не пересматривает уже принятый ledger. Safety disable из-за недостоверного route/metadata удерживает новые решения до проверки. Известные edits остаются у прежней кампании по отдельным version rules. Rename/close/reopen/restart не меняют historical boundary; новая одноимённая тема — новый route.
6. При migration chat ID старые original keys сохраняются; новый alias проверяется отдельно. Одинаковые message IDs в старом и новом chat не объединяются. Service update — evidence для оператора, не разрешение автоматически открыть route.

joined_at хранит подтверждённое событие membership с provenance и временем получения; при неизвестном историческом вступлении значение UNKNOWN. activated_at/intake_boundary — отдельное утверждённое правило source. Повторный add/restart/restore не сдвигает его автоматически. Граница проверяется по **исходной дате** и при наличии минимальному message ID, внутри транзакции. Если заданы оба ограничения, должны выполняться оба. Cutoff внутри одной секунды требует marker/message-ID evidence либо консервативной более поздней границы; edit_date не доказывает допустимость оригинала.

Historical cutoff первичного enrollment отделён от pause/resume. Если нужен marker для original-date границы, его ID относится к тому же source chat; DM ID нельзя сравнивать с group ID. Такой cutoff проверяет новые originals, не обнуляет прежние вклады. Pause не требует marker/сравнения Telegram секунд: её начало — DB commit ADR-06. Authorization/proof подключения — UX-04.

Переиспользовать тот же chat/thread для новой кампании в MVP нельзя, даже после архива: нужен другой topic/route или будущая явная migration policy. Иначе lifetime uniqueness и pinned history противоречили бы друг другу.

Это предлагаемое ограничение OD02, которое показывается при setup и completion, а не утверждённый запрет навсегда. Если owner выберет reuse, потребуется отдельное решение source generations/non-overlapping windows при сохранении original uniqueness; просто удалить unique constraint нельзя. Сейчас generations не добавляются.

Boundary не удаляет legacy вкладов. Для incident 35 нужна отдельная проверка текущей записи и authorised correction, а не automatic backfill. Редакция неизвестного pre-boundary сообщения x3 → три объяснимых receipt, effective delta 0, никакой подтверждающей реакции. Existing override=0 сохраняется.

## ADR-04 — Ledger, точность, причинный аудит и отчёт

Для вклада: effective = override, если override IS NOT NULL; иначе подтверждённый source amount; при INVALID/REVIEW без override — 0. Zero override является значением. Override переживает пользовательские edits; release берёт последнюю однозначную исходную версию. При version conflict release запрещён. Старое событие не воскрешает прежнюю сумму; update_id служит receipt, а не доменным порядком редакций. Одинаковое время + различный смысл → REVIEW с аудитом, не молчаливый last-write-wins. Поведение 1.x не меняется под видом extraction.

Текущий total = opening balance + SUM(effective contributions) + SUM(явных accounting adjustments). Для legacy campaign opening balance **0**: существующий ручной import остаётся вкладом, включая исторические 14950; второй баланс из него не создаётся. Новый opening balance — отдельная однократная операция с причиной/provenance. Изменение opening после activation — компенсирующий adjustment, не UPDATE истории.

Для aggregate import сохраняется ImportBatch: batch ID, ссылка на существующую ledger operation, declared total/effective date, actor/provenance, защищённый evidence reference/hash. Coverage items связывают известный original key, amount at import и evidence confidence с этим batch; это metadata, не дополнительные начисления. Status: COVERAGE_COMPLETE_VERIFIED только при доказанном составе/согласованной сумме, иначе COVERAGE_PARTIAL либо COVERAGE_UNKNOWN. Сведения владельца об отдельных originals сохраняются как OWNER_ASSERTED, не автоматически complete verified.

Batch исторических 14950 мигрирует с фактически известным coverage; список неизвестных участников не выдумывается. Отсутствие contribution row не доказывает, что число не входило в aggregate/opening. Missing import сначала проверяет known coverage и остаточную неопределённость: известный covered original повторно не начисляется; доказанный uncovered допустим; PARTIAL/UNKNOWN по умолчанию → REVIEW без новой дельты. Исключение может принять только owner после preview возможного двойного счёта и reason IMPORT_RISK_ACCEPTED; операция атомарно резервирует original key, сохраняет risk/provenance и не получает label VERIFIED. Последующий user update не создаёт второй original, спорный release требует нового разбора. Это принятое ручное решение с неопределённым происхождением, не гарантия отсутствия дубля.

Goal change, override/release и +/- accounting adjustment — три разных операции. Корректировка требует reason, actor, expected revision, effective period и preview delta; не позволяет без следа «установить total». Отрицательная дельта — предлагаемый default только при total >= 0; итог за пределами signed INT64 отклоняет всю операцию. Отмена correction создаёт компенсацию, audit не удаляется.

Amounts/aggregates на границе SQL ↔ runtime/JSON/CSV передаются decimal strings либо bigint. Сначала canonical decimal/range validation, затем точный SQL bind/cast; Number для INT64 не используется. Проверки включают 2^53+1, signed limits, overflow SUM, NULL и zero через оба adapters, export, encryption, restore и rendering. Нельзя считать CAST AS TEXT после уже неточного JS bind исправлением точности.

Материализованный total — восстановимая проекция, а не новый источник истины: delta = new_effective − previous_effective; row, adjustment, projection и audit меняются в одной transaction. Full SUM + adjustments/opening сверяется отдельно с ledger watermark. При drift — incident и проверка согласованного checkpoint, а не исправление проекции по несогласованным reads. В Track A оптимизация условно P0 перед ростом, если capacity gate не пройден; в v2 проектируется до расширения нагрузки.

Audit event содержит event_id, monotonic commit_seq внутри одной БД, event ordinal, occurred_at/original_date/edit_date, received_at/recorded_at, correlation_id/causation_id, receipt/update ID, original key, source/campaign, type, previous/new effective, delta, decision/reason, actor/scope, policy/schema revision. Независимым экземплярам не приписывается общий глобальный порядок. Raw тексты участников не нужны для replay бухгалтерского решения: достаточно нормализованных facts, parser revision и audit; admin reason хранится осознанно, в ограниченном объёме.

Snapshot хранит immutable period_id, UTC bounds, calendar revision/timezone/label, ledger watermark, totals/day amount/correction, goal/name на момент снимка, rendered body/hash. Delivery отдельно. Обновлённый вид периода вычисляется из актуального ledger; он явно подписан «пересчитано на …» и не подменяет опубликованный snapshot.

Для объяснения correction сохраняется causal projection contributing events: effective deltas к оригиналам до начала данного периода, записанные после watermark предыдущего snapshot и включённые в текущий. Для initial balance/import, post-close amendment и смены календаря причины выделяются отдельно. Сумма строк trace должна совпасть с correction; несходство — incident, а не догадка. Legacy reports без полноценной причинной истории сохраняют пометку «доказательства частичны».

Incident 35: snapshot 32050 → поздний edit старого оригинала +5000 → следующий snapshot 63550 при day 26500. Отдельная потенциальная correction −5000 не считается существующей до audit/receipt. UI показывает оригинал, времена, причину и дельту, не приписывает edit администратору.

## ADR-05 — Права, диалоги и восстановление владельца

Telegram group admin и bot campaign admin — разные полномочия. Scope проверяется для чтения, mutation, callback/session step, export и **окончательного допуска** admin delivery. Владелец экземпляра имеет system scope; campaign admin — только выданные capabilities. По умолчанию приглашать/отзывать может владелец; ограниченное делегирование выключено до OD03.

Callback содержит opaque action/session handle; сервер хранит actor, campaign/source, expected revisions, expiry, action, authorization epoch и nonce. Campaign ID не берётся из «последней выбранной» mutable переменной. Все mutating шаги требуют current authorization и CAS в той же transaction. Повтор callback возвращает сохранённый outcome. TTL и stale callback дают Refresh/Back, не повторное действие. Быстрый answerCallbackQuery не означает commit; ответ «сохранено» появляется после результата storage.

В 2.0 отзыв прав повышает authorization epoch и делает pending UI/actions/exports недоступными. Поддерживаемые cooperating writers перед отправкой читают актуальные DB grants и scopes payload; old binaries, игнорирующие epoch, должны быть остановлены migration/drain gate. В 1.x A02 проверяет ADMIN_IDS **конфигурации исполняющегося Worker**, включая все префиксы ui:/admin:. Старый invocation может иметь старый env даже после redeploy: межверсионный revoke завершён только после перевода на новый artifact и доказанного прекращения старых writers. A02 не обещает мгновенный revoke across versions и не требует v2 grants. Даже актуальный final gate не отзывает уже разрешённый сетевой запрос; уже прочитанные данные также не возвращаются.

Приглашение: выбрать campaign/capabilities → одноразовый actor-bound invite → кандидат сам открывает DM → назначающий видит подтверждённую identity и подтверждает → grant + audit. Username и введённый вручную чужой Telegram ID не являются proof. Нельзя выдать scope шире своего, повысить себя или отозвать последнего владельца.

Локальное recovery требует защищённого доступа к хосту, остановки mutating runtime, recovery backup, preview нового owner и явного операторского подтверждения. Записываются audit/recovery epoch, аннулируются старые sessions/invites/exports; Telegram-only /claim-owner отсутствует. Конкретная процедура, допускающие лица и хранение recovery material — OD03. Это будущее действие с отдельным разрешением, не шаг текущей сессии.

## ADR-06 — Жизненный цикл и календарь

Pause принята владельцем в EV09; остальные lifecycle defaults остаются в соответствующей части OD02.

| Состояние | Новые оригиналы | Известные edits | Admin correction / отчёты |
|---|---|---|---|
| DRAFT | Нет до подтверждённой activation | Не создают историю | Настройка/TEST, без публикаций |
| ACTIVE | Exact source, historical cutoff и текущая DB admission policy | Обычные version rules | Scoped corrections и snapshots |
| PAUSED | Новые admission после pause commit удерживаются, без начисления | Уже зарегистрированные originals обрабатываются по прежним version/override rules | Сама pause не меняет effective amounts; reports по отдельной policy, default hold |
| COMPLETED | Нет | POST_CLOSE_REVIEW, прежний confirmed effect сохранён | Санкционированное amendment с новой completion revision |
| ARCHIVED | Нет | POST_CLOSE_REVIEW, без автоматической дельты | Read/export; owner amendment; регулярные публикации прекращены |

**Pause только после окончательного confirm и commit.** Preview/draft не изменяет приём и не выбирает effective-from в прошлом. Confirm transaction проверяет actor/scope, nonce, expected state/revision, затем сохраняет новую policy revision, transition sequence и audit. Commit этой операции — точка начала pause. Ответ «Пауза включена» отправляется после подтверждённого commit. Ошибка/rollback оставляет прежнее состояние; crash после commit до UI ответа не отменяет переход, повтор возвращает сохранённый outcome.

Admission и pause читают/меняют policy в сериализуемых атомарных storage operations. Если ledger/admission commit сообщения раньше pause commit, вклад сохраняется. Если первой фиксируется pause, операция admission нового original видит PAUSED и сохраняет HELD без начисления. Lock/CAS не позволяет применить старое ACTIVE решение после pause commit; конфликт требует повторной проверки policy. Raw inbox receipt ещё не является принятым вкладом. Одинаковая Telegram second, порядок update_id/DM message_id и дата сообщения меню не используются как момент pause. В audit видны admission policy revision и commit sequence; authoritative ordering — DB, не предположение о точности wall clock.

Уже принятые contributions, totals, overrides и snapshots **не аннулируются и не обнуляются самой pause**, нет сканирования/переоценки прежнего диапазона. Effective amount может измениться по обычным правилам новой source revision или явной authorised correction со своим аудитом; опубликованный snapshot остаётся immutable. Новая историческая boundary также не служит обходом этого запрета; legacy cutoff semantics сохраняются при extraction/import.

Resume симметрично вступает в силу после confirm/commit. Ранее удержанные originals и publication holds не выпускаются автоматически; original admission decision сохраняется по original key, поэтому duplicate/replay/edit не превращает PAUSED/HELD в ADMITTED. Для их принятия нужна отдельная явная сверка/операция. Впервые обрабатываемый после resume original проходит текущую policy и initial historical cutoff; pause ограничивает приём в DB, не обещает восстановить хронологию написания неполученных updates. COMPLETED/ARCHIVED одной кнопкой resume не открываются.

Текущее goal achieved = total >= current goal, вычисляется заново после edit/goal change. Milestone — историческое событие с goal revision и временем. Auto-complete при превышении цели запрещён. Completion делает администратор после preview итогов и неразобранных случаев; «поднесено Гуру» — необязательная ручная метка P2, не автоматическое действие бота.

Final snapshot имеет отдельный kind FINAL, completion revision, момент закрытия и ledger watermark; он не выдаётся за полный суточный period. Неразобранные financial cases блокируют обычное подтверждение; при невосполнимых gaps только owner может явно закрыть с reason и сохраняемой пометкой неполноты. Такой итог не называется полностью сверенным. Post-close amendment добавляет новый audited результат и разницу к final snapshot, не перезаписывает его.

Переименование меняет только display name и revision. Имена могут совпадать; UI добавляет краткий контекст группы/темы. Предлагаемый лимит 1–80 видимых символов, без управления markup; IDs скрыты в обычном UI. Физическое удаление использованной кампании не входит в MVP. Пустой DRAFT без любого ledger/audit/delivery usage можно удалить отдельным подтверждением; retention used data — OD10.

Календарь проектируется через immutable UTC periods, а не один mutable timezone у старых строк. Изменение HH:mm, timezone, enabled и destination показывает следующий period и момент отправки. Расписание применяется с явного будущего effective-from; уже созданный snapshot не пересоздаётся. При timezone change нужен transition period [последний end UTC, следующий согласованный local midnight), затем обычные дни новой зоны. Preview показывает его фактические bounds/длительность и предотвращает gap/overlap; local label может потребовать timezone/revision для различения. Уникальность snapshot — campaign + period_id.

DST: дни 23/25 часов допустимы; несуществующее HH:mm переносится на первый допустимый момент, повторяющееся — на первое допустимое наступление, но snapshot публикуется максимум один раз по period ID. Эти defaults требуют TEST и OD02. Выключение отчётов выключает публикацию, а bookkeeping snapshots продолжаются bounded scheduler до completion; накопившиеся holds автоматически не публикуются при включении.

## ADR-07 — Outbox, тишина и реакции

Outbox intent имеет отдельные hold/cancel reasons. Попытка хранит attempt_id/claim token (не bot credential), неизменяемый target chat/thread, rendered payload hash, authorization/policy/source revisions, timestamps, результат и Telegram message ID при доказанном успехе. Claim/finish условны по token. Никакой общей DB/Telegram transaction нет.

SENT — подтверждённый успешный ответ; FAILED_KNOWN — доказанный отказ без принятой отправки; timeout/неразобранный ответ/потеря результата/expired SENDING → UNCERTAIN. Suppressed до сети — отдельный outcome intent, не фиктивный SENT и не Telegram failure. Retry после доказанного отказа — только bounded policy с 429 delay/backoff; UNCERTAIN sendMessage — ручная сверка, затем одно audited confirm-sent или retry. Для инцидента «видимый отчёт + FAILED_KNOWN» сначала trace/reconciliation.

Смена destination не меняет начатую попытку; pending intents прежнего destination удерживаются. Администратор выбирает отмену либо новую отдельно подтверждённую delivery того же snapshot. Нельзя тихо перенести очередь. Warning перед send сверяет последнюю source revision/state, route и silent policy; исправленный/старый input не получает устаревшее предупреждение.

Silent independent от pause: ledger продолжает работать, групповые reports/warnings/progress/check/reactions блокируются; private admin reads доступны по scope. ON commit перед final send gate запрещает новый запрос; уже разрешённый запрос может завершиться. OFF не снимает старые holds и не выпускает backlog.

Упорядочение silent: receipt dedup отдельно от source command order; команды принимаются в подтверждённом private admin context. Хранятся исходное время, actor/chat/message ID, expected policy revision для UI и watermark. Более старое время не меняет новую policy; для одного actor/chat в одну секунду сравниваются message IDs. Между разными actors в одну секунду ON доминирует независимо от доставки; OFF требует более позднего момента либо нового актуального CAS-действия с явным конфликтом. Повтор ON продвигает watermark, но не changed_at без смены состояния. Stale command не создаёт побочных holds/releases. После restore действует отдельная admin command boundary/recovery epoch.

Reaction — desired-state projection, не ledger evidence. После commit валидного effective > 0, без REVIEW/quarantine/hold, предложено 🙏; ✅/off доступны по campaign policy OD05. INVALID/zero override/conflicting route требуют отсутствия подтверждения. Intents имеют source version fence и читают актуальную policy перед запросом. Отказ Telegram не откатывает вклад; unsupported/429/UNCERTAIN дают bounded reconciliation и incident при расхождении. Повтор set желаемого состояния может быть допустим как idempotent convergence только после нового fence; это отдельная политика, не разрешение повторять UNCERTAIN sendMessage.

Reaction attempts сериализуются по original key; завершение каждой вновь сверяет desired state/revision и при необходимости планирует актуальную reconciliation. Уже начатый запрос может физически завершиться после edit; это pending/mismatch, а не доказанное мгновенное соответствие реакции ledger. При недоступном подтверждении UI честно сохраняет unknown outcome; API реакции не используется как полноценное чтение истории сообщения.

По умолчанию silent подавляет и добавление, и удаление реакций. Если уже поставленная реакция устарела во время тишины, ledger меняется, возникает mismatch incident; отсутствие сетевого действия не считается успешным удалением. Cleanup при OFF — явное решение для текущего desired state, не массовое освобождение старых intents. Исключение «разрешать cleanup в silent» не включается без OD05. UI /check объясняет, что реакция может запаздывать.

## ADR-08 — Backup, восстановление и перенос

**Решение владельца OD04, часть 1.x:** Cloudflare/D1 опирается на provider Time Travel с историей 7 дней. Регулярный external backup/executor не требуется для Track A. Перед maintenance transition фиксируются подходящий restore point/bookmark и проверенная на synthetic TEST D1 процедура восстановления; это не encrypted remote round-trip. Семь дней — retention, не RPO и не обещание независимой от аккаунта/провайдера копии. Фактическое состояние production PITR пока не проверено.

Для v2 self-hosted Node/SQLite обязателен полноценный внешний encrypted backup B09–B11. Provider, retention, key custody, RPO/RTO остаются открытой частью OD04: предлагаются 4 hourly + 7 daily либо выбранные владельцем 4 hourly. Четыре hourly точки охватывают 3 часа между крайними. RPO около часа плюс snapshot/upload относится только к исправному часовому процессу v2; RPO=0 не обещается. Политика optional Cloudflare v2 явно фиксируется в C03; внешний executor не добавляется в 1.x задним числом.

Согласованный SQLite snapshot → проверка → шифрование до upload → immutable generation + manifest → download/hash/decrypt/integrity verification → mark verified → retention. Старое поколение удаляется только после нового подтверждённого; ошибка upload/rotate не уничтожает последнюю рабочую копию. Recovery key хранится отдельно от cloud account и bot token, не в Telegram audit/export. rclone crypt/Drive/Yandex — self-hosted adapters; Worker не запускает rclone и требует external executor/API adapter. Детальный порядок и faults — [OPERATIONS_SPEC](OPERATIONS_SPEC.md).

Node external restore выполняется в отдельную DB с schema/identity/ledger проверкой и TEST без production outbound. D1 Time Travel выполняет destructive in-place restore; procedure drill проводится **только на изолированной TEST D1**, не через восстановление production ради проверки. В обоих случаях runtime удержан до schema/recovery/command boundary и reconciliation; отсутствовавшие после restore отправки могли произойти. PITR — аварийное восстановление с анализом потери после точки, не обычный binary rollback поверх актуальных данных. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

Самостоятельный мигратор B28 (D1 ↔ SQLite только в явно поддержанных направлениях) имеет canonical export/import manifest, точность INT64/NULL/FK/keys, mappings schema versions, все controls/roles/historical boundaries/admission decisions/audit/snapshots/outbox attempts/UNCERTAIN и recovery state. Normalized ledger hashes сравниваются до старта нового writer. Pause/drain webhook/Cron/poller и их lease fences доказываются в TEST. Ни drop_pending_updates, ни snapshot overwrite после новых вкладов не используются. Rollback — совместимый binary над актуальной БД либо отдельно проверенная обратная migration с согласованной сверкой. D1 contract equivalence не заменяет live migration drill. Production переход — только OD09.

B28 не блокирует установку нового instance с пустой DB, B29 cold install, B31 packaging/CI или первый B32 public release. До отдельной приёмки мигратора import D1 отмечен UNSUPPORTED/отдельной задачей; новый setup не вызывает importer. Миграционные проверки обязательны перед использованием/объявлением соответствующей функции, а не перед каждым fresh install. Local schema upgrade/backup/restore нового Node instance остаются release gates.

## ADR-09 — Runtime, наблюдаемость и границы поддержки

Node runtime: один процесс/consumer, persistent volume, no inbound domain/port requirement для polling; host должен оставаться доступным. Startup fail closed при identity/schema mismatch, configured webhook, занятой DB/process lease, recovery hold. Миграции — отдельная явная операция, обычный startup не меняет существующую схему. Локальная блокировка не доказывает отсутствие другого consumer на другом хосте; Telegram conflict останавливает обработку и вызывает проверку single-writer procedure.

Durable inbox перед Telegram acknowledgement, crash/replay в каждой границе; при reboot первый getUpdates получает ранние неподтверждённые events без слепого применения старого глобального offset. После durable записи **всей** возвращённой пачки допускается ack этой пачки; обработка inbox имеет отдельный idempotent state. Не подтверждать хвост, если предыдущий valid update потерян. Удалённые/неполученные сообщения не восстанавливаются обещанием «exactly once». [Telegram getUpdates](https://core.telegram.org/bots/api#getupdates).

Scheduler — bounded due-work и fairness между campaigns, один плановый trigger/instance, не Cron на каждую кампанию. Профили CPU, rows, backlog и latency раздельны для HTTP/Cron/poller. Logs разделяют immutable audit, bounded operational journal и diagnostic projections. Health показывает фактические даты/исходы, никогда не объявляет полноту истории по heartbeat.

Compatibility matrix: 1.x D1 поддерживается исправлениями; Node 2.0 имеет новый schema range и feature set; Cloudflare 2.0 до C01–C03 — не поддержан. CI проверяет shared corpus, startup schema fences и release manifest. При отсутствии D1 v2 adapter импорт SQLite v2 → D1 1.x не рекламируется; двусторонний перенос требует отдельного mapping/drill, не механического SQL dump.

Бюджеты и stop criteria CF определяются в [OPERATIONS_SPEC](OPERATIONS_SPEC.md), а отсутствие live metrics остаётся UNKNOWN. Public release требует независимого cold install, restore/upgrade evidence и owner choice лицензии OD08. Стабильная 1.x может продолжать работу без завершения всех v2 features.
