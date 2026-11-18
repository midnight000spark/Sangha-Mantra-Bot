# Матрица требований, отказов и доказательств

Срез: 14.11.2026. [BASELINE](BASELINE_AND_DELTAS.md) — единственный реестр полученных/унаследованных свидетельств этой ревизии. Таблицы ниже задают **будущую приёмку**. Новый product code, product test run, live Telegram, migration и capacity load в текущей docs-only сессии не выполнялись. Успешная запись документов не закрывает ни один runtime gate.

## V-01 — Уровни evidence и receipt

| Уровень | Что доказывает | Чего не доказывает |
|---|---|---|
| NOW-LOCAL-STATIC | Прочитанный код/schema и SHA, clean исходное дерево | Реальную доставку/гонку/production |
| NOW-REMOTE | Metadata PR/CI/reviews; официальный документ | Live состояние Worker/DB/Telegram |
| INHERITED-LOCAL | Прежний локальный test/probe на указанном SHA | Новый прогон либо cloud profile |
| INHERITED-TEST | Repository/private receipt прежнего TEST, с указанными ограничениями | Human/General/native failure, если их там не было |
| REQUIRED-LOCAL | Будущий domain/unit/contract test с actual state | Live Telegram |
| REQUIRED-D1 / REQUIRED-NODE | Настоящий workerd/D1 / Node SQLite adapter | Внешнюю migration/host crash, если не проверены |
| REQUIRED-FAULT | Контролируемый kill/error/reorder/timeout с точкой инъекции | Native сбой Telegram только по имитации |
| REQUIRED-TELEGRAM / REQUIRED-HUMAN | Реальные TEST updates/permissions/callbacks и действия человека | Production состояние или полноту всех сообщений |
| PRODUCTION-OBSERVED | Разрешённый target, время, version и наблюдаемый факт | Состояние позже среза или автоматически весь сервис |

Receipt: scenario ID, code SHA/image/schema/platform versions, sanitized environment fingerprint, inputs и provenance, clock/timezone/seed, actual vs expected ledger/events/attempts/outputs, fault point, observation interval, PASS/FAIL/UNKNOWN и непроверенное. Для backup — generation/hash/watermark и restore result; для capacity — metric availability/sampling/окно; для human — фактические шаги/screens. Secrets/personal identifiers в публичный receipt не входят.

После review EV08 для capacity дополнительно обязателен tag CURRENT_1X_OBSERVED / SYNTHETIC_WORKLOAD / V2_DEPLOYED_TEST с functional capabilities и assumptions. Synthetic 3/10 campaigns не является actual 1.x; deployed v2 TEST с искусственными inputs не называется native Telegram load. Для 1.x recovery receipt — PITR target/point/schema и synthetic TEST in-place restore, а не external upload/generation. OD04 этой платформы принят владельцем; v2 backup choices ещё открыты.

INHERITED PASS относится только к прежнему scope. Включение нового сценария в таблицу, mocked transport или успешный CI не превращает его в PASS. После product изменений повторяют затронутые checks и обязательные release gates, а не весь исследовательский набор без причины.

## V-02 — RQ → ADR → task → acceptance

| RQ / сценарий | ADR / карточки | Проверяемый invariant и отказ | Требуемое evidence / текущий статус |
|---|---|---|---|
| RQ01 / SC01 | ADR-02/03; B02/B26 | Одно согласованное положительное ASCII число; emoji допустимы по текущим rules; ambiguous/decimal/zero/media/caption/forward/bot не начисляются. Command с числом целиком исключён, включая missing entities | D1+Node corpus, human input matrix. Legacy parser INHERITED-LOCAL/TEST; v2 NOT RUN |
| RQ02 / SC02 | ADR-02; B02/B04/B05 | Повтор receipt/original не меняет total; duplicate after failed attempt не переиспользует прежний APPLIED без guard. SQL ошибка между audit/row/total/intent даёт полный rollback | D1+Node state comparison и fault injection каждой transaction boundary. Legacy partial INHERITED; v2 NOT RUN |
| RQ03 / SC03 | ADR-04; B02/B15 | 5+ edits, reverse delivery, text tombstone/edit-before-original; stale number не воскресает. Same-time contradictory versions → REVIEW, не last-write-wins | D1+Node, replay/fault, реальные Telegram edits отдельно. Legacy INHERITED partial; v2 NOT RUN |
| RQ04 / SC04 | ADR-04; A04/B04/B15/B16 | Override0 → user edits → restore/replay остаётся 0; release берёт latest unambiguous source, REVIEW release denied. delta/effective/total/audit согласованы | Exact state dumps; values >2^53 в aggregate/adjustment precision fixture, overflow fail atomic. Legacy zero overrides INHERITED; v2 NOT RUN |
| RQ05 / SC05 | ADR-03/04/06; A04/B14/B24 | Joined_at отдельно от activation; old unknown edit x3 delta0/no🙏. Same-chat marker либо boundary-second REVIEW, не DM ID/order. Legacy cutoff семантика сохранена; old35 не исчезает. Import14950 coverage PARTIAL/UNKNOWN не доказывает отсутствие дубля | D1/Node fixtures + membership/topic TEST. Boundary static, actual cutoff/35 correction/complete import coverage UNKNOWN |
| RQ06 / SC06 | ADR-03/05; B13–B15/B17/B21/B27 | Две темы+группа изолированы; unknown/missing metadata не fallback. Enrollment требует bot scope + verified actor/admin proof и same-route nonce; wrong actor/chat/thread, expired/replayed challenge, missing permission/network proof не активируют route | Real constraints/native topic/proof TEST, SC26; F01/F02 static, v2 NOT RUN |
| RQ07 / SC07 | ADR-05; A02/B17/B18 | 1.x pending ui:/admin:/alerts/export с новым env deny; старый env может отправлять до verified drain — это отдельный тест границы. v2 current DB revoke блокирует cooperating writers/callbacks/exports; forged scope deny. In-flight final-authorized запрос не отзывается | Two-config local races + human revoke/drain TEST. F03 static/repro INHERITED; fix NOT IMPLEMENTED |
| RQ08 / SC08 | ADR-07; A01/B19 | Старый впервые доставленный OFF после нового ON не меняет state/watermark побочно; duplicate ON обновляет order без changed_at. Разные admins в одну секунду: ON dominates. OFF не снимает holds; admin recovery boundary | D1+Node permutations/faults, native long silent cycle. F04 cause NOW-LOCAL; fix NOT IMPLEMENTED |
| RQ09 / SC09 | ADR-04/07; A03/B19/B20 | Invalid→valid до send подавляет stale warning. Claim/final authorization/finish fences; 429 known fail bounded retry; lost response/expired SENDING UNCERTAIN. Destination/payload attempt immutable, нет blind resend | D1+Node + transport fault at each stage; реальные report attempts и manual resolution отдельно. F05 NOW-LOCAL; visible FAILED_KNOWN root cause UNKNOWN |
| RQ10 / SC10 | ADR-06/09; B08/B20 | 23/25h дни, gap/fold HH:mm, timezone transition contiguous UTC periods, schedule change/reboot/backfill: один snapshot/period. Enabled/OFF/destination не выпускают старую очередь | Deterministic calendar fixtures + native scheduler/report TEST. Legacy time tests INHERITED; v2 transition NOT RUN |
| RQ11 / SC11 | ADR-08; A05/B03/B09–B11 | D1 1.x: выбранные 7 дней PITR, пригодный point и TEST-only in-place restore/undo/schema/ledger check, no production restore probe. Node v2: consistent active-WAL encrypted external generation, wrong key/corruption/upload/rotation/OAuth faults, отдельная restored DB; lost key → FAIL | Platform-specific receipts, actual v2 RPO/RTO/drill. Старый synthetic archive drill INHERITED; PITR target/current prod и v2 external UNKNOWN |
| RQ12 / SC12 | ADR-01/02; B01–B04/B15/B20/B28 | Deterministic + bounded seeded model/differential corpus, independent oracle, normalized ledger/audit outcomes и shrink minimal failing trace. Общий supported subset; D1 1.x UNSUPPORTED v2 не считается parity. No Bun requirement пользователя | Real D1/Node runners, seed/corpus version/CI budget/reduced fixture; model cases ниже. NOT RUN, не formal proof |
| RQ13 / SC13 | ADR-09; B05–B07 | Kill до inbox/после inbox/после domain/до ack/после ack, batch partial failure: ни один подтверждённый input не теряется. Reboot без blind global offset; second consumer/webhook/409 fail closed, queue не сбрасывается | Node process fault suite + isolated native polling; local lock limitation across hosts видна. NOT RUN |
| RQ14 / SC14 | ADR-04/09; A07/A10/B08/B16/C01–C03 | CURRENT_1X_OBSERVED single campaign; 3/10 до v2 — SYNTHETIC_WORKLOAD. CF v2 GO_TO_SUPPORT требует V2_DEPLOYED_TEST artifact/capabilities/x2 budget после C02. Projection==ledger/fair bounds. Missing metrics UNKNOWN; narrow G-MAINT risk acceptance не capacity PASS | Class/assumptions/sampling/SQL/cloud receipts. Только local F06 INHERITED; current cloud UNKNOWN. C01 лишь prototype verdict |
| RQ15 / SC15 | ADR-05/06; B21/B22/B27 | Человек проходит U01–U11: readable scoped status/recent/changes/setup/correction, no SQL/IDs/JSON; paging/empty/back/cancel работают; multi-campaign смешения нет | HUMAN TEST обычного администратора, callback click evidence. Старые readable replies INHERITED; v2 UX NOT RUN |
| RQ16 / SC16 | ADR-04/06; B15/B20/B22 | Pause preview не меняет state; commit final confirm — начало. Contribution commit до pause сохраняется, после pause новое admission HELD; same-second/network reorder читаются по DB revision/sequence. Rollback/crash/replay не обнуляют прежние суммы; resume не выпускает holds. Goal/FINAL/post-close отдельно | Contract/concurrency + human U10; pause принята EV09, прочие OD02 открыты; NOT RUN |
| RQ17 / SC17 | ADR-02/04/09; B02/B13/B15/B20/B23/B31 | С первого ledger commit есть event schema/seq/correlation/causation/before/after/delta/policy; с первого report — watermark. Fault не оставляет учёт без audit. B23 только projection; legacy causality explicit PARTIAL/UNKNOWN. Bounded/redacted export, CSV/precision/revoke checks | Producer contracts проверяются до UI; export threat checks OP-10. OD10 открыт; NOT RUN |
| RQ18 / SC18 | ADR-04; A04/B20/B23 | Fixture35: 32050+26500+5000=63550; exact contributing edit+delta раскрыты в U08/U11. Correction −5000 только после explicit operation, preview58550 не current balance. Updated period отдельно от published | Deterministic incident regression, state/trace/sum receipt; live case only OWNER-OBSERVED EV05, actual correction UNKNOWN |
| RQ19 / SC19 | ADR-07; B25 | Commit before reaction; VALID>0 → 🙏, INVALID/zero/REVIEW/quarantine → no confirmation/removal вне silent. Stale intent до final fence не отправляется; старый in-flight completion после edit вызывает current-state reconciliation; silent suppresses add/remove, mismatch честно; 429/unsupported/uncertain bounded | Version-race local tests + actual permissions/native reaction TEST; OD05 и включение открыты. NOT RUN |
| RQ20 / SC20 | ADR-03/05/07; B26 | /progress scope/total/as-of; /check только own original/proof; not-found не REJECTED. Commands/bot output не contributions; unknown source silent, rate limit/coalescing/expiry; silent no group response, DM access verified | Parser/router/security/queue tests + human/native group/DM. OD06; NOT RUN |
| RQ21 / SC21 | ADR-02/09; B03/B12/B18/B29/B31 | Clean public install без CF/domain/Bun/private bindings; getMe/DB/owner/backup/reboot. OP-10 до cold install: non-root/volume permissions, no ephemeral fallback, bootstrap replay/expiry/foreign identity, artifact/secret/input negatives | Independent install/negative-check receipts; root host trust boundary явно ограничен. NOT RUN |
| RQ22 / SC22 | ADR-03/04/09; B11/B24 | Unknown gaps/fullness_not_verified; coverage-aware reconciliation: missing DB row + UNKNOWN14950 не verified uncovered. Known covered deny, incomplete default REVIEW, owner risk exception audited/flagged/reserves original key и не удваивается при later update | Outage/import fixtures + human U13/U16; unknown past/coverage не становится complete после exception. NOT RUN |
| RQ23 / SC23 | ADR-05; B12/B18/B29 | Первое DM не owner, invite proof не username, no scope/self escalation/last-owner removal. Потеря owner Telegram → protected local recovery с backup/epoch/audit; старые sessions/exports blocked | Local CLI threat/fault test + human TEST, owner policy OD03; NOT RUN |
| RQ24 / SC24 | ADR-08/09; A05/A08/A09/B07/B28/B29/C03 | Два scope: UPGRADE — fresh Node schema/fallback/reboot/restore; MIGRATE — отдельный B28 D1→SQLite canonical transfer/admission/coverage/UNCERTAIN/zero/INT64/single writer. Migration не gate first fresh release | SC24-UPGRADE нужен B29; SC24-MIGRATE только для заявленного переноса. Current production/live migration NOT DONE |

SC24-UPGRADE (local schema/fallback/restore нового Node instance) и SC24-MIGRATE (D1 transfer) имеют разные release scopes. Наличие B28 в SC12/SC24 матрице не делает весь migration subset обязательным для B29/B31/B32. CI первого fresh релиза запускает supported adapter corpus и Node upgrade tests; D1 importer явно не поддержан до собственного verdict.

Дополнительные сквозные сценарии:

Три bounded model/differential case SC12 (будущие tests, не выполненные сейчас):

- **Ledger sequences:** seeded originals/old/same-time edits, override0/release/import/goal и invalid inputs; independent oracle проверяет effective amounts, conservation delta и original uniqueness; real D1/Node shared subset.
- **Admission sequences:** final confirm/rollback, pause/message commit order, same Telegram second, pending inbox, held original/replay/edit и resume. Oracle использует committed policy revision и first admission, сохраняет прежние ledger effects; нет retroactive source-date range reclassification. V2 capability проверяется Node-vs-model до появления D1 v2, не как D1 1.x parity.
- **Crash/recovery sequences:** SQL failure/kill/replay/restore на доступных operation boundaries; state/audit/projection/outbox outcome не теряется и не дублируется. Reducer сохраняет fault point и минимизирует последовательность. Seed/corpus version/limits фиксируются, адресные F03/F04/F05/35 fixtures остаются отдельными.

| ID | Scope / задачи | Приёмка и текущий статус |
|---|---|---|
| SC25 | Concurrency/session; B17/B22 | Два admins подтверждают одну revision; source edit между preview/confirm; два параллельных campaign dialogs; expiry/cancel/editMessage failure. Один effect либо explicit conflict, никогда silent overwrite или wrong campaign. D1+Node+human; NOT RUN |
| SC26 | Topic lifecycle/quarantine; B14/B24/B27 | Rename/close/reopen сохраняют source; delete/unavailable incident; recreated same-name не наследует; chat migration original keys не сливаются; General в реальном TEST, missing thread не fallback. NOT RUN |
| SC27 | Human/native acceptance; A06/B27 | Обычный человек, реальные callbacks, membership/permissions, новая тема, edit/override0, revoke, длинная silent последовательность через daily report/Cron и restart. Bot-to-bot/fault injection не закрывают native/human части. NOT RUN |
| SC28 | Public release; B30–B32/C03 | Owner license/scope, pinned artifacts/compatibility matrix, required P0 evidence, independent install/restore/upgrade, sanitized support docs. Optional features/CF v2 только по заявленной поддержке; release отдельно от live migration. NOT RUN |

## V-03 — Минимальный user journey corpus из пакета §23

Каждая строка имеет пользовательский путь, invariant и адресный сценарий; технические tasks и требуемое evidence раскрыты выше.

| Journey | UI route | Invariant / тест |
|---|---|---|
| J01: Бот впервые добавлен в forum | U00→U04→U15 | joined_at evidence != activation; не открыты все темы; SC05/SC27 |
| J02: Мани, Ваджрасаттва, Симхамукха | U02→U04→U03/U05 | Три source/campaign IDs, отдельные goal/report/rights/ledger; SC06/SC15 |
| J03: Число в «Общалке» | U13 при необходимости; участнику тишина | Не начислено никуда; known-chat quarantine bounded; SC06 |
| J04: Старый original edit x3 | U08/U13 | Отсутствующий pre-boundary original не добавлен, delta0/no🙏; SC05 |
| J05: Принят → исправлен → override0 | U06→U08→U09/U18 | Актуальный effective и реакция/статус с fence, zero сохранён; SC04/SC19 |
| J06: Report correction +5000 | U11→U08→U07 | Точный contributing edit/original/version/delta; SC18 |
| J07: /progress /check в теме | U18/U17 | Не contributions; scope/rate/silent/privacy; SC01/SC20 |
| J08: Два администратора правят запись | U09→refresh | CAS conflict без перезаписи, новый preview; SC25 |
| J09: Отзыв администратора | U14→попытка старого U09/export | Старые callbacks/pending DM/mutations/exports blocked; SC07 |
| J10: Порог достигнут, edit снижает total | U03/U10/U19 | Current achieved false, milestone есть, completion не автоматический; SC16 |
| J11: Отчёт опубликован, потом уточнён | U11→updated view→U08 | Published snapshot immutable, новая delta traceable; SC18/SC09 |
| J12: Rename/close/recreate темы | U05/U13/U04 | Same source при rename, новый route при recreate, никакой name routing; SC26 |
| J13: Неполученный update / outage | U15→U13→U16 | Unknown gaps, proof-based reconciliation без обещания полноты; SC22 |
| J14: Upload успешен, архив повреждён | U15/U13→restore TEST | Новый не VERIFIED, last good сохранён, restore не PASS; SC11 |
| J15: Владелец потерял Telegram | U00/U17→protected local procedure | Нет Telegram self-claim, есть backup/audit/recovery epoch; SC23 |
| J16: D1 → SQLite — самостоятельный поток | U15 recovery hold→U16 | Canonical state/one consumer/zero/UNCERTAIN; SC24-MIGRATE/B28. Не gate первого fresh-install релиза |
| J17: Независимый cold install | U00→U04→U03→U15 | Только public release, first contribution/edit и restore; SC21/SC28 |

## V-04 — Fault injection plan

| Граница отказа | Требуемый outcome |
|---|---|
| После receipt SQL, до contribution/audit/total/intent в одной transaction | Всё откатилось либо весь atomic result committed; отдельный durable inbox явно остаётся pending |
| После mutation commit, до UI ответного send | Повтор возвращает тот же outcome, не делает повторную delta |
| После outbox claim, до final gate | ON/revoke/source revision может удержать/отменить intent; сети ещё нет |
| После final gate, во время network | Результат может завершиться после ON/revoke; потерянный ответ UNCERTAIN, не повтор |
| После Telegram success, до DB finish | Expired SENDING → UNCERTAIN; manual reconcile, не новый send |
| В середине polling batch, до durable commit/ack | Неподтверждённые events доступны для replay; никаких blind offset advances |
| После whole-batch durable inbox, до/после ack | Inbox replay применяет один effect; restart не теряет ещё pending events |
| Во время SQLite backup/upload/verify/rotation | Last verified external generation доступна; partial new не latest; no live overwrite |
| После schema upgrade, при запуске старого binary | Startup fence rejects unsupported schema; compatible fallback использует актуальную DB |
| Message и pause transactions конкурируют, confirm доставлен поздно | Preview не действует. После final confirm/commit новые admission удержаны; ранее committed rows/total не изменяются. Rollback не включает pause, post-commit crash не отменяет её |
| Missing original при неполном составе aggregate import | Default REVIEW, либо owner risk exception с provenance/reserved key; не label «дубль исключён» |
| При manual import/quarantine resolution одновременно с исходным update | Original identity + CAS дают один ledger effect, pinned campaign и полный audit |

Проверять обе стороны каждой границы и фактические database invariants; отсутствие thrown error само по себе не PASS. Ошибка тестового инструмента фиксируется отдельно от product failure и не маскируется успешным повтором без объяснения.

## V-05 — Раздельные gates

| Gate | Нужно | Статус на срезе |
|---|---|---|
| Документация | 8 связанных файлов; RQ/ADR/task/SC/UX links; owner gaps, source hashes и docs-only diff | Итоговая проверка записывается в SESSION_STATE; не product GO |
| Merge maintenance | Fixed corrected SHA, F03/F04 regressions, независимое review; F05 в ограниченном maintenance scope | NO-GO текущего HEAD: F03/F04 открыты; CI success не отменяет |
| Production 1.x / G-MAINT | A03–A06/A08, PITR point/TEST runbook/cutoff/identity/fallback/drain/observations и OD09; missing analytics — только scoped MAINTENANCE_ONLY_RISK_ACCEPTED, не capacity PASS | Сейчас NO-GO: нет fixed artifact/нужных receipts/OD09; provider-only policy сама по себе принята |
| Node alpha с ценными данными | Durable runtime, external verified backup и measured restore/RPO/RTO | NOT READY / NOT RUN; product code не создавался |
| Node public 2.0 / G-RELEASE-FRESH | P0 заявленных fresh-install функций, empty DB cold install/upgrade/backup/restore/SC27/SC28, license/owner publication gate; B28 исключён | NOT READY по своим checks; отсутствие D1 importer само по себе не blocker |
| D1→SQLite / G-MIGRATION | Standalone B28/SC24-MIGRATE и отдельный live gate перед переносом | Отдельный NOT RUN; не распространяется на fresh install/release |
| Cloudflare v2 / G-SCALE | C01 prototype decision → C02 real adapter/deployed TEST → C03 measured capacity/parity/migration/recovery policy + owner GO_TO_SUPPORT | OPTIONAL / NOT EVALUATED; synthetic/current1.x не GO, не blocker Node release |

Human/live gaps/current production и открытые OD остаются видимыми; OD04 закрыт лишь для provider-only 1.x. Независимое текстовое review EV08 получено и критически разобрано; это не code/live evidence. Синтаксическая проверка, seeded corpus и review не считаются доказательством всей семантики.
