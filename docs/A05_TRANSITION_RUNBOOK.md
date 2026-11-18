# A05: maintenance transition и recovery

Этот документ не разрешает production deployment, remote restore или смену webhook. A05 использует локальные synthetic D1/workerd. Production SHA, identities, boundary, сумма и исполнение коррекции №35 неизвестны. [Review и границы доказательств](A05_LOCAL_REVIEW_2026-11-14.md).

## Drain → migrations → identity/boundary validation → activation

1. В отдельно согласованном окне записать ответственного, exact candidate SHA/artifact/config digest и совместимый fallback. Сохранить свежий защищённый backup и provider point, проверить восстановление отдельно. Снять приватную сверку contributions (NULL/0 overrides различать), event_log, admin_adjustments, controls/watermarks, reports/audit/resolutions, notices/claims/holds и receipts. В публичном отчёте — только counts, суммы, digests.
2. **Drain:** прекратить webhook, Cron, ручные jobs/probes и все старые invocation/waitUntil/отправки. Gateway возвращает503 для webhook без подтверждения updates; Cron отключён либо переведён на отдельно проверенный maintenance handler без writes/sends. Не использовать drop_pending_updates. Записать доказательства прекращения старых writers и результаты уже разрешённых API calls. 503 и `/silent` сами по себе drain не доказывают: silent не останавливает writers и private admin sends. Окно ограничено доступным сроком хранения upstream updates; полнота требует сверки.
3. **Migrations:** после drain проверить фактическую schema и migration ledger. Fresh: **0001→…→0009**; подтверждённая0006: **0007→0008→0009**. 0007 добавляет controls/boundaries/holds; 0008 читает0007 и добавляет watermarks; 0009 добавляет source_event_key и обязательна **до любого** enqueue/sender нового Worker, включая admin replies. Без0009 ledger может успеть commit до503; retry после исправления не заменяет правильный порядок. Не редактировать исполненные миграции; прямой повтор CREATE/ALTER не идемпотентен. При несовпадении ledger/schema после archive/PITR остановиться и согласовать reconciliation, не выполнять blind apply.
4. **Validation:** сверить все old columns, totals/zero overrides, immutable report snapshots, очереди и foreign keys. Проверить actual account/D1 UUID/bot ID/Worker/source aliases/report destination и deployment_identity соответствующего environment. Миграции не устанавливают identity или boundary. Boundary брать только из подтверждённых original source facts; health200 не доказывает enrollment. Для каждого chat alias нужна собственная boundary. Missing/unknown boundary = NO-GO; не подставлять время миграции/restore/«сейчас».
5. До открытия трафика подтвердить **свежий `/silent on`** новым Worker на изолированном административном пути либо проверенной операцией с атомарным сохранением controls + source watermark + holds. Проверить accepted receipt, фактическую policy, watermark и holds в D1. Исходное время команды должно быть позже legacy/recovery/source barrier; та же секунда после restore может быть отвергнута. Один UPDATE silent=1 не эквивалентен корректной команде. После0006 restore controls/boundaries могут быть пустыми и требуют явной validation.
6. **Activation:** 100% вызовов направить на проверенный artifact/config, исключить mixed writers, вернуть webhook без сброса очереди и Cron. Сверить transition window по original IDs, receipts, event/adjustment deltas, totals, report snapshots, holds, claim/lease и UNCERTAIN. Проверить restart и webhook retry. Повтор key не даёт второй суммы; отсутствие ошибок не доказывает отсутствие пропусков. Не импортировать14950 повторно и не назначать legacy members по отсутствию строки contributions.
7. OFF — только отдельным решением после сверки. OFF сохраняет старые holds; публикации освобождать по одной после проверки Telegram. Нельзя blanket retry UNCERTAIN/FAILED_KNOWN/held queues. Уже разрешённый после последнего D1 gate API call может завершиться после смены source/policy/config.

## ADMIN_IDS: завершение отзыва

Новый env/artifact должен содержать актуальные ADMIN_IDS. Final gate охватывает ui:/admin:/alert:, включая export replies. Отзыв завершён только после **прекращения всех старых writers с прежним env**. Изменение deployment config не меняет старый invocation. Снять queue inventory, затем проверить NOTICE_AUTH_DENIED/FAILED_KNOWN без send/claim. Возврат прав автоматически FAILED_KNOWN не отправляет; явный retry снова проверяет authorization/holds/source. Уже начатый API call не отзывается. Локальный тест не доказывает срок Cloudflare drain.

## Fallback и downgrade/re-upgrade

Проверенный A05 fallback ограничен **тем же замороженным кодом a59c6be**, отдельным Worker с актуальным env на той же D1/schema0009. Это повторная активация известного artifact; безопасность другого старого SHA не доказана. Сохраняются F03/F04/F05, boundary, recovery, report immutability и claim/lease/holds. Иной fallback SHA требует тех же проверок и digest. `6573d24` и `b7cc125` предшествуют новым fences; b7cc125 локально воспроизвёл обход source-order и запрещённые sends.

При невозможности безопасной работы оставить gateway503 и остановленный Cron, сохранить D1 и upstream queue. Не удалять миграции, не возвращать старый Worker/старую базу. При затяжном outage отдельно сверять доступность upstream updates.

Если downgrade всё-таки произошёл: drain всех версий, checkpoint и сверка ledger/reports/outbox. Старый writer меняет controls без source watermark; **redeploy сам расхождение не исправляет**. После re-upgrade обязательна новая подтверждённая `/silent on` с исходным временем позже всех watermarks/recovery. Проверить accepted, silent=1, watermark и holds; прежний receipt не подтверждает текущую policy. OFF — последующим отдельным решением. A05 воспроизводит расхождение и исправление свежим ON; downgrade этим не разрешается.

## Restore старого архива

`restore.ts` пишет только в новый output и отказывается перезаписывать его. Ledger/zero сохраняются; recovery_state добавляется; PENDING/SENDING/FAILED_KNOWN notices/reports переходят в UNCERTAIN, SENT сохраняется, report_audit дополняется. Старые claim metadata могут сохраниться: UNCERTAIN автоматически не отправляется. Restore **не обновляет schema**.

Восстановить архив в отдельную D1 без writers/Telegram/Cron, проверить исходные schema/ledger, применить недостающие миграции до0009 в указанном порядке. Сверить old columns/snapshots, identity, controls/watermarks, boundary и recovery_state. Не выдумывать отсутствующую boundary. Сверить окно exportStartedAt→restore и внешние публикации; затем согласовать recovery и одиночные публикации, без blanket release UNCERTAIN.

**Не восстанавливать старый snapshot поверх новых подтверждённых накоплений.** Сохранить текущее состояние, восстановить snapshot отдельно, сравнить ledger и transition window, подготовить reviewable reconciliation. Ни archive, ни provider undo не возвращают Telegram updates, отсутствующие в snapshot; полнота требует внешних доказательств.

## Legacy rejected notices: операторский triage

0009 оставляет source_event_key=NULL: revision не угадывается по key/created_at. Unheld PENDING rejected:% при silent OFF будут claim-нуты и станут **FAILED_KNOWN**, last_error=`Source revision no longer confirms warning`, audit=`NOTICE_SOURCE_STALE`, claim очищен, sent_message_id=NULL. Это известный отказ **текущей** попытки до API, не доказательство отсутствия исторической публикации.

| State / gate | Новый sender | Triage |
|---|---|---|
| PENDING, no hold, silent OFF | При обработке → FAILED_KNOWN без API | Проверить source; оставить terminal отказ, не привязывать legacy row к revision вручную |
| PENDING held / silent ON | Остаётся PENDING | Не освобождать массово; после обоснованного release source gate всё равно откажет |
| SENDING с живым lease | Остаётся SENDING | Проверить старый invocation/Telegram, не отбирать claim |
| SENDING, claimed_at старше300000ms | → UNCERTAIN | Проверить Telegram; NULL claimed_at не проходит expiry predicate и требует отдельного разбора |
| UNCERTAIN | Нет auto retry | При найденной публикации notice_sent с реальным ID/причиной; не делать слепую переотправку |
| FAILED_KNOWN | Нет auto retry | Сохранить reason; manual retry не обходит source/auth gates и unbound warning снова откажет |
| SENT | Сохраняется | Не повторять и не переписывать историю |

Inventory собирать приватно для своей campaign: `notice_key LIKE 'rejected:%' AND source_event_key IS NULL`, группировка state/publication_hold/claim age плюс silent. `/notices` показывает только10 строк; полный inventory требует защищённой выборки без body/PII. Актуальные invalid/review intents создаёт обычный committed ingestion с proven revision, не ручное редактирование source_event_key. Stale-source и auth-denied — разные причины terminal non-send; оба не отправляются автоматически. Сколько таких rows в production — UNKNOWN.

## Boundary внутри секунды

Telegram message.date и original_not_before имеют целые секунды; predicate `original_date >= original_not_before` включительный. Два originals в одной секунде временной predicate не различает. В известном source chat можно дополнительно задать подтверждённый first_message_id (также inclusive); оба заданных predicate должны выполняться. IDs разных chats не сравниваются; edit_date не является временем original admission. Если разделение legacy/new внутри секунды не доказано source marker, остановить enrollment, не округлять до «сейчас». Boundary не переписывает existing contributions; edits сохраняют override0.

## Provider PITR: отдельный разрешённый TEST drill

**Не исполнен в A05; provider recovery/undo UNKNOWN.** Далее — процедура только для отдельно подтверждённой isolated synthetic TEST D1, не production. Interface проверен по установленному Wrangler4.160.0: локальные `d1 time-travel … --help` и код CLI. Доступность/retention/entitlement recovery points проверять live, не выводить из CLI help.

1. Записать TEST account/UUID, остановить writers/webhook/Cron/outbound, сохранить counts/digests/schema/migration ledger и независимый encrypted export. Проверить отсутствие production bindings и пользовательских данных.
2. `bunx --no-install wrangler d1 time-travel info DB --config "$TEST_CONFIG" --json` — получить point/bookmark, сохранить private receipt и проверить доступность point.
3. Внести только synthetic marker, записать after digest. При сохранённом drain выполнить `bunx --no-install wrangler d1 time-travel restore DB --bookmark "$POINT" --config "$TEST_CONFIG" --json`. Это destructive **remote in-place** operation, она отсутствует в локальном runner. Сохранить result.bookmark и **result.previous_bookmark** (undo reference).
4. Сверить реальную schema/ledger/rows/zeros/reports/queues: marker отсутствует, базовые digests совпадают; записать наблюдаемые RPO/RTO. PITR может вернуть старую schema и pending/sending states; provider restore **не добавляет archive recovery markers**. До sends обязательна отдельно проверенная recovery quarantine и сверка Telegram.
5. Пока нет новых writers/накоплений, только на этой TEST проверить undo к previous_bookmark и повторную schema/data сверку (marker возвращается). Затем проверить необходимые миграции до0009 и полную validation recovery пути. Ошибка = STOP с сохранением receipt/backup, не пробовать production.
6. Подписать receipt с UUID, point/undo, schema/digests, временем/результатами. Local AES-GCM restore/fault drill не заменяет provider receipt.

## Production preflight: GO / NO-GO

GO — возможность предложить serial cutover владельцу, **не разрешение начать его**. Все пункты подтверждаются в live preview A08 и отдельном A09 scope:

- [ ] Одобрены exact candidate SHA/artifact/config digest и fallback; schema0001–0009 и recovery путь проверены.
- [ ] Actual account/D1/Worker/bot/source/report identities совпадают; placeholders заменены отдельно проверенным artifact; secrets приватны.
- [ ] Подтверждена inclusive boundary каждого source с точностью секунды; unknown/missing = NO-GO.
- [ ] Сверены actual total, zero32/38, report35 и actual correction35. Синтетические58550 не production result; коррекцию35 без отдельного решения не выполнять.
- [ ] Есть свежий encrypted backup, доступные provider point/undo и успешный isolated TEST PITR receipt с schema/quarantine checks.
- [ ] Доказан drain webhook/Cron/manual/inflight, ADMIN_IDS актуальны; upstream queue не сброшена; есть временной бюджет и сверка полноты.
- [ ] Подтверждены silent ON/watermark/holds; есть приватный triage legacy rejected, UNCERTAIN, claims/lease и внешних публикаций.
- [ ] Выполнен A06 native human TEST / daily-report-silent cycle; A07 capacity evidence либо явно принят MAINTENANCE_ONLY_RISK_ACCEPTED в разрешённом scope, без capacity PASS при unknown.
- [ ] Назначены monitoring/STOP thresholds и ответственный за transition-window reconciliation; владелец явно разрешил A09 для конкретного окна/artifact.

Любое отсутствующее обязательное доказательство, ошибка сверки, неподтверждённый drain/boundary, несовместимый fallback или отсутствие live approval = NO-GO. До activation сохранять drain; после новых commits не возвращать старую базу. Локальный PASS не объявляет production readiness.
