# Исполняемый backlog и зависимости

Статус: DESIGN, 14.11.2026, CR-01…CR-12 рассмотрены в EV08; четыре последующих решения владельца EV09 имеют приоритет. Задачи не разрешают менять код/внешние системы в текущей docs-only сессии. После отдельного принятия scope берётся одна S/M карточка с SHA/evidence; не все OD/live inputs являются prerequisites каждой задачи. 1.x backup policy уже выбрана: provider Time Travel 7 дней, без нового scheduled external backup task. Контекст: [MASTER_PLAN](MASTER_PLAN.md), [ADR](DECISIONS.md), [UX](ADMIN_UX_SPEC.md), [операции](OPERATIONS_SPEC.md), [сценарии SC](VERIFICATION_MATRIX.md).

## Правила выполнения

- **S:** не более одной небольшой сессии; **M:** одна–две. Если задача не помещается, до кода разделить на меньшие карточки с сохранением parent ID. Оценки не включают ожидание человека/календаря/разрешений.
- **P0-I:** integrity/security gate указанного release; **P0-U:** usability gate указанного release; **P1:** включение по scope. Priority не требует делать весь v2 перед исправлением 1.x.
- **PLANNED:** подготовлена карточка, реализации нет; **DECISION:** нужен названный OD; **LIVE-GATE:** отдельное разрешение и проверенный target/window; **CONDITIONAL:** только если gate покажет необходимость. Ни один product task не DONE по факту этой документации.
- Общий DoD каждой code-карточки: ограниченный diff; соответствующий domain/fault regression; code SHA и environment fingerprint; actual/expected state + event/attempt references; typecheck/build/CI по затронутому scope; обновлённый handoff; отсутствие secrets и неразрешённых изменений. Unit/mock, workerd/D1, реальный Node, synthetic fault, native Telegram и human checks имеют разные evidence labels.
- Перед live работой отдельные gates OP-07 и OD09. Не создавать issue/comment/PR, не commit/push/merge и не выполнять cloud/test deployment автоматически по наличию этой таблицы.
- Риски R1–R9 заданы MASTER_PLAN. U — screen route; SC — acceptance scenario. Указанный SC означает требуемую проверку, а не уже полученный PASS.

## Track A — стабилизация Cloudflare 1.x

| ID / размер / priority | Scope и артефакт | Зависимости / статус | Acceptance и evidence | Риск |
|---|---|---|---|---|
| A01 / M / P0-I merge | Controls: regression F04 + исходная версия silent command/watermark; без v2 schema rewrite | Новый разрешённый code scope; PLANNED | SC08: old first OFF, повтор ON, два actors/одна секунда, restore admin boundary; stale не создаёт holds; workerd + local receipt | R1 |
| A02 / S / P0-I merge | Единый config authorization для ui:, admin:, alerts/экспортов 1.x; scope одного Worker env | Code scope; PLANNED | SC07: enqueue → новый config без admin → no send; два env показывают, что старый invocation требует drain; no instant across-version revoke claim | R2 |
| A03 / S / P0-I production | Warning intent revision fence и отмена stale rejected: перед send | A02; PLANNED | SC09: invalid → valid/override0/другой edit до send; нет старого предупреждения; receipt/outbox согласованы | R3 |
| A04 / M / P0-I | Boundary/incident regression fixtures и evidence manifest текущего audit/legacy coverage; без новых пользовательских экранов | A01–A03; PLANNED | SC05/SC18: old edit x3 delta0, 35 только explicit correction, zero32/38, import14950 один раз; unknown coverage/causality не объявлены полными. UX trace — функциональный B23 после P0 release | R4 |
| A05 / M / P0-I transition | Maintenance migration/compatible fallback drill и provider PITR runbook на изолированной synthetic TEST D1 | A01–A04; **PARTIAL: local verified, provider TEST PITR NOT_RUN**, только в отдельно разрешённом scope | SC11/SC24: local D1/workerd fresh0001–0009, restored0006→0009/faults, old columns/zero/queues и frozen fallback проверены; [review](../A05_LOCAL_REVIEW_2026-11-14.md), [runbook](../A05_TRANSITION_RUNBOOK.md). Provider in-place point/undo/schema receipt остаётся live-gate | R4/R7 |
| A06 / M / P0-I acceptance | Обновлённый human TEST script/receipt: обычный отправитель, callbacks, длинная тишина/report, native permissions | A01–A05; LIVE-GATE только изолированный TEST | SC27: реальные нажатия и daily report cycle; невыполненный шаг UNKNOWN; bot-to-bot не заменяет human | R1/R2/R3 |
| A07 / M / условный P0-I scaling | CURRENT_1X_OBSERVED single-campaign account profile + отдельно SYNTHETIC_WORKLOAD/forecast и local cost delta | A01–A03; для account/TEST нужен OD07 scope; DECISION | SC14: 1k/10k/100k history/x2 нагрузки 1.x, missing metrics UNKNOWN; 3/10 campaigns только future model, no actual multi claim. Не hard gate merge FIX/narrow risk-accepted maintenance | R5 |
| A08 / M / P0-I transition | G-MAINT preview: real identity/cutoff, fresh PITR point/TEST procedure, compatible fallback и доказанный drain | A05/A06 + G-MAINT/OD09; LIVE-GATE подготовка | SC24/SC14: capacity evidence либо explicit MAINTENANCE_ONLY_RISK_ACCEPTED по OP-08, без capacity PASS; one writer/queue/STOP; 35 actual status только по разрешённому read | R4/R6/R7 |
| A09 / M / P0-I transition | Выполнить отдельно одобренный serial narrow cutover и сверку окна, без v2 migration | A08 + explicit OD09 artifact/window; LIVE-GATE | SC24: one writer, exact events/overrides/holds/reports и доступные observations; недоступный CPU остаётся UNKNOWN; нет масштабирования/blanket UNCERTAIN release | R1/R3/R7 |
| A10 / M / условный P0-I до scaling | Убрать измеренный горячий SUM в 1.x через atomic projection либо выбрать меньший проверенный scope; отдельный diff | Только A07 FAIL по измеренной SQL причине и отдельный scope; CONDITIONAL | SC14/SC04: delta на insert/edit/override/release/import, full recomputation equality, migration/drift fault; новый capacity profile | R4/R5 |

G-FIX относится к fixed SHA A01/A02 и независимому review; deployment ждёт A03–A06/A08 и OD09. A07 нужен для G-SCALE; missing analytics в G-MAINT — отдельно принятый риск, не PASS. Принято EV09: сначала P0 проверяются/безопасно выпускаются и сверяются в A09, сразу после этого начинается продуктовый Track B. Новые UX/features и B28 не добавляются в обязательный P0 scope.

## Track B0/B1 — переносимые контракты и Node foundation

| ID / размер / priority | Scope и артефакт | Зависимости / статус | Acceptance и evidence | Риск |
|---|---|---|---|---|
| B01 / M / P0-I | Узкий Storage/Transport/Scheduler boundary под первую функциональную итерацию, без смены прежних domain rules | A09; порядок принят EV09, PLANNED | SC12: corpus/atomic admin semantics сохранены; extraction <=3 small iterations, не новая широкая research/миграционная фаза | R9 |
| B02 / M / P0-I | Event schema contract + shared real-adapter runner/canonical dump; deterministic fixtures и bounded seeded oracle/shrink foundation | B01; PLANNED | SC01–SC05/SC09/SC12: outcomes/precision/NULL/replay, new audit fields обязательны до B15/B20; 3 model cases SC12, reproducible seed/minimal trace; supported subset, CI budget | R4/R9 |
| B03 / S / P0-I | Driver/image spike: Node24 candidate, bundled SQLite/INT64/backup/x64/arm64 под self-hosted функции | A09; PLANNED/RESEARCH | SC11/SC12: точные большие integers, rollback/FK/WAL snapshot и pinned versions. Не зависит от мигратора существующей D1 | R4/R6 |
| B04 / M / P0-I | Реальный Node SQLite Storage adapter для single-campaign supported operations | B02/B03; PLANNED | SC02–SC04/SC12: один corpus, BEGIN IMMEDIATE/Busy/disk faults, canonical equality с D1 | R4/R9 |
| B05 / S / P0-I | Durable normalized inbox/receipts и processing state; typed payload privacy | B04; PLANNED | SC02/SC13: receipt commit before ack, digest conflict, malformed/unknown type без poison loop, no raw text by default | R4 |
| B06 / M / P0-I | Long polling fetch/ack/replay/shutdown loop, webhook preflight и adapter transport | B05; PLANNED | SC13: kill до/после inbox/domain/ack, whole-batch ack, reboot без blind saved offset, no negative/drop; реальные TEST + fault receipts | R4/R7 |
| B07 / S / P0-I | Process lock/DB fencing epoch, schema/identity/recovery startup gates | B04/B06; PLANNED | SC13/SC24: второй процесс, другая DB identity, чужой webhook/409, unsupported schema → fail closed; нет silent takeover | R7 |
| B08 / S / P0-I | Bounded local scheduler, fairness и persisted due cursor, health facts | B07; PLANNED | SC10/SC14: backlog/reboot/DST, не более бюджета, ни одна campaign не starvation; latency/lag evidence | R5 |

B01/B02 не должны строить универсальную transaction framework. Если extraction больше трёх небольших итераций — остановка расширения, ADR-01 review и более тонкая граница с сохранением corpus.

## Track B2 — автономная эксплуатация

| ID / размер / priority | Scope и артефакт | Зависимости / статус | Acceptance и evidence | Риск |
|---|---|---|---|---|
| B09 / S / P0-I | Согласованный SQLite snapshot и authenticated encrypted manifest, автономно от Bun | B03/B04; PLANNED | SC11: активный WAL, concurrent writer, actual snapshot watermark, wrong key/corruption/int64/zero; отдельная restored DB | R6 |
| B10 / M / P0-I | Один выбранный cloud backup adapter, verified generation index, transactional retention и stale incidents | B09 + OD04; DECISION | SC11: upload/download/decrypt/semantic verify до rotation; failed upload/delete не теряет last verified; expired OAuth/quota faults | R6 |
| B11 / M / P0-I | Restore CLI/recovery hold, reconciliation ведомость и полный disposable restore drill | B09/B10, OD04; DECISION | SC11/SC22: intact routes/roles/overrides/attempts, old commands blocked, no prod outbound, actual RPO/RTO измерены | R4/R6 |
| B12 / M / P0-U | Compose image/volume/secrets, guided bootstrap owner, установочные checks и читаемый итог | B06–B11, OD03; DECISION | SC21/SC23: install без Cloudflare/domain/Bun/private bindings; root owner proof, restart, failed-step retry; recovery CLI расширяется B18 | R6/R8 |

До B10/B11 нельзя объявлять Node alpha подходящей для ценных ledger данных. Разработку Multi-Campaign на disposable data это не блокирует.

## Track B3 — независимые кампании, админка и аудит

| ID / размер / priority | Scope и артефакт | Зависимости / статус | Acceptance и evidence | Риск |
|---|---|---|---|---|
| B13 / M / P0-I | v2 schema: B02 event fields, Campaign/Source, current admission policy/original decisions, roles/periods и ImportBatch/Coverage | B02/B04 + относящиеся открытые OD02; PLANNED | SC06/SC17/SC24: unique original/source, zero/default opening, no invented legacy causality; fresh schema создаётся без D1 input/migrator | R2/R4/R7 |
| B14 / M / P0-I | Topic envelope/router, joined_at/historical cutoff и source proof, chat migration/General gates | B05/B13; PLANNED | SC05/SC06/SC26: no fallback, historical marker не DM ID; expired/foreign/replayed setup и missing proof не активируют source. Pause не использует Telegram cutoff markers | R2 |
| B15 / M / P0-I | Atomic source-bound ledger/override/release, first original admission и prospective pause/resume с audit с первой операции | B13/B14/B17; pause решена EV09, прочие OD02 только по своим функциям | SC02–SC06/SC16/SC17: pause только confirm/commit, прежний ledger/total не меняется; message vs pause commit order, rollback/crash/dedup; held original не выпускается replay/edit | R2/R4 |
| B16 / M / P0-I до роста | Campaign delta projection + bounded full reconciliation и drift incident | B15; PLANNED | SC14: каждое изменение, compensation, conflict и rollback; immutable watermark сравнения, no silent repair; measured read/write profile | R4/R5 |
| B17 / M / P0-I | DB scopes/capabilities/auth epoch, CAS guards reads/mutations/final sends и export | B13 + OD03; DECISION | SC07/SC25: cross-campaign deny, revoke pending DM/export/callback, two admins conflict; U14 permissions | R2 |
| B18 / M / P0-I/P0-U | Invitation proof/revoke UI + local recovery/transfer поверх bootstrap/grants; без нового role framework | B12/B17 + OD03; DECISION | SC07/SC23: actor-bound invite, no self-escalation/last-owner removal, lost-account local recovery epoch/audit; U00/U14 | R2/R8 |
| B19 / M / P0-I | v2 outbox attempt/hold state machine и source/policy/auth fences для всех outgoing intents | A01–A03/B15/B17; PLANNED | SC08/SC09: final gate, frozen chat/thread/payload, timeout/429/lease crash, no automatic UNCERTAIN retry; U11/U12 | R1/R3 |
| B20 / M / P0-I/P0-U | Immutable periods/snapshots, schedule/DST и обязательный audit/report ledger watermark с первого snapshot | B08/B16/B19 + OD02; DECISION | SC10/SC17/SC18: snapshot/evidence atomic до B23, continuous periods, one snapshot/period, held delivery и causal correction; U05/U11 | R3/R5 |
| B21 / M / P0-U | U01–U06: campaign list/status, setup wizard, rename/goal/settings, readable paging и empty/error states | B12–B14/B17/B20; PLANNED | SC06/SC15: три независимых campaigns, no SQL/IDs/JSON, duplicate setup safe, goal/name не меняют ledger; human journey | R2/R8 |
| B22 / M / P0-U/P0-I | U09/U10/U19: correction previews, pause/resume/completion/archive и post-close amendment | B15–B17/B20/B21 + OD02; DECISION | SC16/SC25: concurrent edit conflict, goal reached false после edit, explicit completion, no history deletion; no repeat mutation on UI failure | R4 |
| B23 / M / P0-U/P0-I export | Только causal projections/queries U07/U08/U11, updated view и bounded sanitized export поверх обязательного audit B15/B20 | A04/B15/B20 + OD10; DECISION | SC17/SC18: trace35/delta sum, coverage/legacy-causality flags, три времени/commit order; не backfill выдуманного прошлого, no private leak | R4/R5 |
| B24 / M / P0-I/P0-U | U13/U16 incidents/quarantine/reconciliation, coverage-aware missing import и owner risk exception | B14/B17/B23; PLANNED | SC05/SC22/SC26: known covered deny, partial/unknown default REVIEW, exception reason/reserved original key не VERIFIED; no route reassignment/DM storm | R2/R4 |
| B25 / M / P1; P0-I при включении | 🙏/✅/off reaction projection, version fences, removal/mismatch and bounded retries | B15/B17/B19 + OD05; DECISION/OPTIONAL | SC19: commit first, valid→invalid/override0, silent blocks calls, stale intent cancelled, unavailable/429/uncertain не меняют ledger | R3/R5 |
| B26 / M / P1; P0-I при включении | /progress /check /help, scoped command menus, ownership/membership proof и rate budgets | B14–B17/B19 + OD06; DECISION/OPTIONAL | SC20: команды с числами не contributions; exact source, private own check, unknown/no-proof deny, silent/no spam; U18 | R2/R3/R5 |
| B27 / M / P0-I/P0-U acceptance | Frozen RC feature scope и real TEST двух forum тем+группы, human callbacks/report-silent цикл | B18–B24 + только включённые B25/B26; LIVE-GATE isolated TEST | SC06/SC15/SC16/SC26/SC27: enrollment proof, pause confirm/commit/no-retro, source edits/revoke/reports; receipt соответствует feature set без обязательного D1 import | R1/R2/R3 |

Post-close policy, отрицательные adjustments, delegation и timezone transition остаются OD, а не автоматическим разрешением. Если human TEST выявляет, что wizard/формы слишком велики, исправляется конкретный flow до RC; полный web UI из этого не следует.

## Track B4 — первый public release с пустой БД

| ID / размер / priority | Scope и артефакт | Зависимости / статус | Acceptance и evidence | Риск |
|---|---|---|---|---|
| B29 / M / P0-I/P0-U release | Fresh public install с пустой SQLite, local schema upgrade/fallback и применимые OP-10 controls | B12/B18/B27; PLANNED | SC21/SC23/SC24-UPGRADE: install/reboot/remote restore/export/negative checks без D1 credentials/archive/migrator. B28 не prerequisite | R6/R7/R8 |
| B30 / S / P0-I release | Зафиксировать owner выбор лицензии и public feature/support scope | OD08 + owner scope; DECISION | SC28: явное решение с датой, лицензия соответствует release; MIT не считается выбранной по рекомендациям | R8 |
| B31 / M / P0-I/P0-U release | Fresh-install public docs/CI/manifest, adapter corpus и OP-10 evidence; matrix явно отделяет D1 importer | B27/B29/B30 + открытая v2 часть OD04/OD10; PLANNED | SC12/SC28: build/restore/precision/secret scan/support scope; SC24-MIGRATE/B28 не обязательны для первого fresh release и не спрятаны в диапазоне dependencies | R8/R9 |
| B32 / S / P0-I release | Собрать reviewable release artifacts/evidence; публиковать лишь после отдельного owner approval | B29–B31, все обязательные P0 заявленного scope; LIVE-GATE publication | SC28: version/digests/лицензия/known gaps/upgrade/backup evidence, no implied live Sangha migration; список optional omissions | R8 |

## Самостоятельный мигратор — вне critical path fresh release

| ID / размер / priority | Scope и артефакт | Зависимости / статус | Acceptance и evidence | Риск |
|---|---|---|---|---|
| B28 / M / P0-I только migration | D1 1.x→SQLite v2 canonical transfer/import и отдельный cutover/replay drill | B11/B13/B15/B19/B20/B23; отдельная потребность/scope; PLANNED | SC12 migration subset/SC24-MIGRATE: ledger/audit/admission/coverage/controls/UNCERTAIN, zero/INT64/no second opening. Не блокирует B29/B31/B32; до приёмки import D1 не поддержан | R4/R7 |

Для переноса живой базы эта задача и отдельный live gate обязательны. Новый instance создаётся/публикуется без неё; B28 можно выполнить после первого релиза, когда понадобится перенос текущей Сангхи.

## Optional C — Cloudflare 2.0

| ID / размер / priority | Scope и артефакт | Зависимости / статус | Acceptance и evidence | Риск |
|---|---|---|---|---|
| C01 / S / RESEARCH | Оценить дельту D1 v2/стоимость, synthetic forecast и выбрать только GO_TO_PROTOTYPE/NO-GO | B13/B16/B20 + OD07 budget/TEST scope; CONDITIONAL | SC14: assumptions/evidence classes явны; prototype budget bounded, это не capacity GO_TO_SUPPORT; A07 observed input используется при наличии | R5/R9 |
| C02 / M / P0-I опции | Минимальная согласованная D1 v2 дельта и разрешённый isolated deployed TEST; крупнее M разбить до кода | C01 GO_TO_PROTOTYPE; CONDITIONAL | SC06/SC12/SC14: real adapter/parity, actual v2 capability/router work и tagged V2_DEPLOYED_TEST metrics; без второго business core | R2/R4/R5 |
| C03 / M / P0-I опции | GO_TO_SUPPORT: CF v2 capacity + compatibility/migration/platform backup policy и release gate | C02, explicit OD07; live transition только OD09 | SC14/SC24/SC28: real deployed v2 x2 budget, supported directions/fallback, явная recovery policy и owner gate; synthetic forecast/1.x observed не заменяют v2 evidence | R7/R9 |

## Связь с прежним T01–T32

Старые IDs не удалены: таблица показывает, где сохранена работа при изменении порядка платформ. Это mapping scope, не автоматический перенос статуса DONE/READY.

| Старый ID | Новые карточки | Изменение |
|---|---|---|
| T01 | A01–A03 | Репродукции включены непосредственно в regression каждой ошибки |
| T02 | A01 | Порядок silent отделён от dedup |
| T03 | A02 / B17 | Final authorization сначала 1.x, затем DB scopes |
| T04 | A03 | Stale notices включены в maintenance до production |
| T05 | A05 | Архивный drill и compatible fallback |
| T06 | A06 / B27 | Human TEST отделён от bot-to-bot |
| T07 | A07 / C01 | Capacity UNKNOWN до metrics |
| T08 | A08 / A09 | Подготовка отдельно от live execution |
| T09 | B01 | Узкие contracts, не ждать actual production deploy |
| T10 | B02 | Общий настоящий D1/Node corpus |
| T11 | B03 | Driver/image/INT64/backup spike |
| T12 | B13 | Multi-Campaign schema сначала SQLite, D1 v2 опционален |
| T13 | B14 | Thread envelope + evidence routing |
| T14 | B12 / B21 | Bootstrap и human wizard вместо SQL setup |
| T15 | B17 / B18 | Scopes, invitation/revoke/recovery |
| T16 | B15 | Pinned original/source ledger |
| T17 | A10 / B16 | Условный 1.x P0; v2 delta projection до роста |
| T18 | B19 / B20 | Snapshot/calendar и delivery отдельно |
| T19 | B08 | Bounded fair scheduler |
| T20 | B28 | Offline legacy migration, не ранний live D1 переход |
| T21 | B27 | Topic/human TEST на выбранном runtime |
| T22 | B04 | Node adapter раньше Multi-Campaign |
| T23 | B05–B07 | Durable inbox, acknowledgement, exclusivity |
| T24 | B08 | Scheduler и health facts |
| T25 | B09–B11 | Автономный external backup/verified rotation/restore |
| T26 | B12 | Готовый Compose и onboarding |
| T27 | B29 | Upgrade/compatible fallback |
| T28 | B29 | Независимый cold install |
| T29 | B30 | Owner choice license |
| T30 | B31 | Проверенные public инструкции |
| T31 | B31 | CI и release manifest |
| T32 | B32 | Owner-approved public release отдельно от live migration |

Первый рабочий пакет — A01→A02→A03/A04, нужные checks/review, безопасный выпуск и сверка A09. Сразу затем функциональные итерации B; B28/полный новый UX не задерживают P0 и standalone migration не задерживает first fresh release. Текущая сессия закрепляет решения в документах; фактические code/release outcomes не заявляются.
