# A05 — интеграционная приёмка maintenance 1.x

14.11.2026. **PARTIAL**: локальная интеграционная часть **LOCAL_VERIFIED**; обязательный по карточке BACKLOG provider TEST PITR in-place point/undo/schema drill **NOT_RUN**. Production readiness и разрешение deployment не выдаются.

## Кандидат и исходное состояние

Проверенный runtime: **`a59c6be6e84beccf5ff050f04310bed240d670d8`**. Код `src/`, миграции0001–0009, package/lock/config в A05 не изменены. Review candidate с добавленными tests/runbook фиксируется отдельным локальным commit; **его точный SHA, tree, patch hash и SHA runtime находятся в `test-results/a05/manifest.json`**. Manifest создаётся после commit, чтобы избежать самоссылочного SHA. A05 patch применим к a59c6be.

| Включённый пакет | Локальный Git anchor | Основание статуса |
|---|---|---|
| A01/F04 | `95d99fa` (snapshot одобренного A01) | Независимый APPROVE унаследован из задания владельца; проверен исходный состав в Git |
| A02/F03 | `729736f` (полный SHA в manifest) | APPROVE унаследован; code/runtime tests повторены в интеграционном прогоне |
| A03/F05 | `a8105e768d3851c96d7633868299d8e0b08af554` | APPROVE унаследован; code/runtime tests повторены |
| A04 | `a59c6be6e84beccf5ff050f04310bed240d670d8` | APPROVE унаследован; historical/boundary/restore corpus повторён |

Это не новое независимое code review A01–A04. Архивные документы пакетов описывают момент до независимого APPROVE; в A05 их содержание не переписано.

Рабочий каталог верхнего уровня сам не Git repo. На старте: private `sangha-mantra-bot` HEAD65e54e3 чист; public HEADb7cc125 содержит прежние пользовательские изменения A01/planning; A02 HEAD729736f чист; A03 HEADa8105e7 чист; A04 HEADa59c6be чист. A03/A04 — связанные worktrees одного Git repo. Создан **отдельный** `sangha-mantra-bot-a05`, ветка `local/a05-integration`, от точного a59c6be. Одобренные деревья и public changes не редактировались; конечные HEAD/status inventories сохранены в evidence. Никакая production-копия не использовалась; fixtures созданы локально. Новая Cloudflare copy не скачивалась.

## Независимо выполненные локальные проверки

Все команды: `CI=true WRANGLER_SEND_METRICS=false`. Полные stdout/stderr сохранены в `test-results/a05/`; каждый вызов Wrangler в migrations/ содержит argv и exitCode. Все DB команды drill имеют `--local`; outbound Telegram в runtime полностью подменён. SQL — настоящие migrations и неизменённые production functions, D1 исполняется workerd/Miniflare, не только SQLite adapter.

| Проверка | Результат / authoritative evidence |
|---|---|
| Baseline `bun run check` | Typecheck + **325 PASS, 0 FAIL**, `baseline-check.log` |
| Финальный `bun run check` | Typecheck + **329 PASS, 0 FAIL**, 1788 assertions, 24 files, `check-final.log` |
| `bun scripts/a05-migration-drill.ts` | PASS, `migration-drill.log`, `migrations/receipt.json`, 68 подробных CLI logs |
| `bun run backup:drill` | PASS: actual Wrangler local export, AES-GCM restore, reimport, tampering/wrong-key rejection, `backup-drill.log` |
| `bun run build` | PASS: Wrangler **dry-run** с фиктивным TEST config, `build.log`; worker bundle digest в manifest; deployment не выполнялся |

Среда: Linux x64, Bun1.4.4, Node22.23.4, TypeScript7.0.2, Wrangler4.160.0, Miniflare4.20260730.0, workerd1.20260730.1. Dependencies pinned; package/lock не менялись.

### Миграции и бухгалтерская сохранность

`scripts/a05-migration-drill.ts` создаёт disposable fresh local D1, применяет0001–0009 через **Wrangler migrations apply**, проверяет9 ledger entries и отсутствие придуманной boundary. Отдельно создаёт populated0006 local D1, экспортирует **Wrangler D1 export**, пакует authenticated encrypted archive, восстанавливает `restoreBackup` в новый output и импортирует SQL в **другую** local D1. Затем последовательно применяет0007→0008→0009.

Для каждого перехода в точную копию migration добавлен последний заведомо ошибочный SQL statement. Проверены rollback **всей** schema/data и migration ledger, отсутствие частичных ALTER/CREATE, повторное применение исходной миграции после сбоя, сохранение **каждого старого столбца всех application tables** (включая пустые таблицы, generated effective_amount, adjustments, event/operational receipts, reports/audit/resolutions и notices/claim fields). Каждый CLI вызов стартует новый local workerd process; успешные/откаченные состояния сохраняются между запусками. Сбой SQL не выдаётся за OS kill или реальный provider outage.

| Контроль | Доказанный результат |
|---|---|
| Contribution32 /38 | source amounts500/2700, override_amount=**0**, effective_amount=**0**, не NULL |
| Contribution35 | effective_amount5000 без синтетической correction; остаётся5000 после upgrade |
| Сумма migration fixture | **5000** до/после authenticated restore и upgrade, три contributions, две zero adjustments |
| Ledger hash до/после restore | Одинаковый **`d8a6cacccc4052bde5ff90f4eeb844613a03af563068b0afb1c892c2b1a3df88`** для contributions/event_log/admin_adjustments |
| Synthetic report35 | SENT snapshot total**63550** неизменен; pending другой report при restore→UNCERTAIN, report_audit дополнен |
| Notices | Все5 legacy rows сохранены; PENDING/SENDING/FAILED_KNOWN при restore→UNCERTAIN, UNCERTAIN/SENT сохранены;0009 добавляет NULL source revision |
|0007 | Никакой автоматической boundary; старые столбцы идентичны |
|0008 | Watermark schema добавлена после0007; отдельные существующие D1 legacy-policy tests проверяют sentinel backfill с сохранением controls |
|0009 | Старые строки/holds/watermarks сохранены, legacy association не выдумана |
| Порядок |0008 до0007 отклонена с rollback; точный порядок0007→0008→0009 и все перед activation обязателен |
| Foreign keys | `PRAGMA foreign_key_check` → [] |

Полные before/after SHA каждого перехода и backup SQL SHA — `migrations/receipt.json`; SQL содержит только synthetic данные. Random archive key и plaintext disposable DB удаляются после drill. `PRAGMA integrity_check` D1 запретил SQLITE_AUTH; PASS для неё не заявляется. Authenticated backup semantic validation и full-row migration comparisons выполнены отдельно.

### Исторические32/35/38, boundary и restore/replay

В финальном прогоне **заново выполнены** существующие A04 SQLite и D1/workerd corpora и compiled Worker tests (`tests/intake-boundary*`), а не только процитирован прежний manifest:

- Отсутствующие32/35/38: три edits, поздний original, reverse/replay не создают contributions, deltas0, synthetic opening14950 неизменен; duplicate import key не добавляет второе открытие.
- Существующие32/38: override0 сохраняется при старых/новых edits, restore и replay. Existing35 остаётся5000 до explicit idempotent correction. Boundary не пересчитывает прежние contributions.
- Synthetic incident35 воспроизводит32050+26500+5000=63550; только явная коррекция даёт**58550**, опубликованный snapshot не переписывается. Это **не доказательство фактического исполнения** production correction35 и не current production total.
- Без подтверждённой boundary новый intake fail-closed, reports pause, initialize/health не назначают boundary даже при synthetic production identity. У нового chat alias boundary не наследуется. Existing contributions можно редактировать при отсутствующей boundary с сохранением override.
- ID/time predicates inclusive и conjunctive, edit_date не заменяет original date; предел точности внутри секунды описан в runbook. Настоящая production boundary **UNKNOWN**.
- A04 authenticated restore/new-D1 reimport/replay повторно проверил opening14950 once, zero32/38, uncorrected35, events/adjustments/boundaries и publication pause. Migration fixture5000 и incident fixture63550/58550 различны; они не изображают восстановленный production ledger.

### Совместные notifications и версии Worker

Новый `tests/a05-transition-runtime.test.ts` содержит4 интеграционных сценария на compiled Worker и настоящей общей D1:

1. **Реальный старый b7cc125**, собранный из локальных Git objects, исполняется рядом с кандидатом. Старый OFF отменяет более новый ON без обновления watermark; старый sender отправляет admin notice отозванному адресату и unbound rejected notice. Это положительная репродукция несовместимости, **не разрешённый fallback**. Свежий ON после re-upgrade восстанавливает фактическую policy/watermark/holds.
2. **F03+F04+F05 вместе:** silent ON удерживает group notices, private admin/ui/alert для отозванного42 становятся FAILED_KNOWN без send. Source invalid→valid, override0 и unbound legacy после explicit release становятся FAILED_KNOWN; unchanged invalid revision доставляется ровно1 раз при concurrent Cron двух экземпляров. OFF/stale OFF не освобождают holds. Старые SENDING по lease→UNCERTAIN; UNCERTAIN/FAILED_KNOWN/SENT не повторяются автоматически.
3. **0009 перед activation:** на schema0008 invalid webhook даёт503 после durable ingestion, но без notice; после0009 retry одного update создаёт ровно1 event/contribution/bound notice/send. Доказывает необходимый порядок и recovery replay; не оправдывает activation до migrations.
4. **Согласованный переход:** synthetic maintenance handler не пишет и не отправляет, возвращает503, upstream harness удерживает update. Ingestion SQL failure откатывает event/contribution; failure heartbeat после ledger commit до ACK даёт503, retry считает один раз. Затем literal dispose/new Miniflare с persistent D1, сохранённые silent/holds/queue, expired claim→UNCERTAIN и повтор update через **замороженный совместимый fallback**: итог108,1 event, без group sends. Реальный Cloudflare drain/upstream Telegram retention этим не доказаны.

Существующие A01–A03 suites тоже независимо перезапущены: claim CAS/concurrency, lease/UNCERTAIN, auth/source final gate failures и transactional rollback, before/after final gate races, report holds/resolutions. Граница D1↔Telegram сохраняется: уже разрешённый API call может завершиться после изменения source/auth/silent; атомарность БД с внешним API не заявляется.

Legacy triage подробно задан в [runbook](A05_TRANSITION_RUNBOOK.md): unbound unheld PENDING при silent OFF → FAILED_KNOWN/NOTICE_SOURCE_STALE; held остаются PENDING; expired SENDING→UNCERTAIN, не FAILED_KNOWN; прочие terminal states сохраняются. Число production rows неизвестно, авто retry запрещён.

### Сбои тестовой оснастки сохранены

`migration-drill-initial.log`/`migrations-initial`: Wrangler export не принимает --persist-to; runner переведён на отдельный cwd/config/state по каждому target. `migration-drill-second.log`/`migrations-second`: D1 отказал integrity_check; ограничение явно отражено, неподдерживаемая pragma убрана из PASS criteria, остальные assertions сохранены. Финальный drill прошёл.

`transition-initial`…`transition-fourth` и `transition-restart-*`: сначала unbound fixture был правильно удержан OFF cutoff, поэтому ожидание отправки старым Worker было неверно — fixture перенесён за cutoff. Минимальный gateway, не читавший POST body, вызывал ECONNRESET в Miniflare service proxy при следующей операции; несколько проб/попыток локализовали это. Gateway теперь читает тело перед503, не ACK-ит и не пишет D1; restart scenario и final329 прошли. Production implementation ради tests не менялась. `drain-probe*` сохранены; промежуточные FAIL не скрыты и не считаются authoritative результатом.

## Проверенный fallback и закрытые эксплуатационные замечания

Fallback — тот же immutable runtime a59c6be, отдельный Worker на **той же D1/schema0009**, с актуальными ADMIN_IDS/identity/config. Сам runtime code в A05 не меняется. Другой older fallback SHA не проверен/не разрешён. При отсутствии безопасного binary — сохранить D1/queue, gateway503 и stop Cron; **не** restore старой базы поверх новых подтверждённых вкладов. OS/provider downtime и drain duration требуют live receipt.

[Runbook](A05_TRANSITION_RUNBOOK.md) содержит обязательные drain→migrations→identity/boundary validation→activation, fresh silent confirmation после downgrade/re-upgrade, migrations после old archive, ADMIN_IDS revoke с прекращением старых writers,0009 до enqueue/sender, legacy triage и ограничения boundary внутри секунды. Прежний совет fallback6573d24 удалён. Provider point/undo/schema/RPO/RTO процедура подготовлена, но **не исполнена**. A05 BACKLOG актуализирован PARTIAL, SESSION_STATE дополнен текущим checkpoint поверх исторического planning baseline.

## Унаследованные результаты и неизвестные live-факты

Унаследованы **только** независимые APPROVE A01–A04 и owner-observed исторические величины из A04 manifest/EV05. A05 самостоятельно проверил локальную совместимость и повторил tests; актуальные production данные не читал.

Отдельные live UNKNOWN / NO-GO до соответствующего gate:

- Actual deployed SHA/config, account/D1/Worker/bot identities, source/report routing и native permissions; шаблоны содержат fictitious IDs.
- Подтверждённая production boundary каждого source, original membership/completeness aggregate14950, legacy causality, текущие totals/zero32/38 и actual correction35.
- Состав реальных legacy/rejected/UNCERTAIN queues, claims/inflight sends, external Telegram publications; полнота webhook/retained updates и transition window.
- Provider PITR availability/retention/point/**undo reference**, schema/data/quarantine checks и измеренные RPO/RTO: **NOT_RUN**, local archive не является provider PITR.
- Доказанный live drain всех старых writers, конфигурация ADMIN_IDS каждого env и фактическое завершение ранее разрешённых API calls.
- A06 native human actions и daily-report/silent cycle; capacity/CPU/analytics либо отдельно принятый maintenance risk по A07/A08.
- Свежий production backup/recovery preflight и explicit owner approval на конкретный A09 artifact/window. Никакого разрешения из local PASS не следует.

Полный production GO/NO-GO checklist — последняя секция runbook; пока live-факты не подтверждены, production **NO-GO**. Для закрытия самой карточки A05 остаётся отдельно разрешённый provider synthetic TEST drill; подготовка runbook не заменяет receipt.

## Patch, manifest и воспроизведение

В `test-results/a05/`: `A05.patch`, `manifest.json`, `source-files.sha256`, `evidence-files.sha256`, `bundle-files.sha256`, Git bundle и полные логи. Git bundle содержит local A01–A05 history (sanitized repo), не secrets/private production repo. Manifest перечисляет точные candidate/base/package SHA, integrated commits, commands/exit codes, evidence digests и границы проверки. Артефакты игнорируются Git намеренно.

В новой **изолированной** копии base a59c6be с pinned dependencies:

```bash
git apply --check /ABS/A05.patch
git apply /ABS/A05.patch
bun install --frozen-lockfile
mkdir -p test-results/a05
CI=true WRANGLER_SEND_METRICS=false bun run check >test-results/a05/check-replay.log 2>&1
CI=true WRANGLER_SEND_METRICS=false bun scripts/a05-migration-drill.ts >test-results/a05/migration-replay.log 2>&1
CI=true WRANGLER_SEND_METRICS=false bun run backup:drill >test-results/a05/backup-replay.log 2>&1
CI=true WRANGLER_SEND_METRICS=false bun run build >test-results/a05/build-replay.log 2>&1
```

Каждую команду проверять на exit0; не продолжать после failure. Для блока использовать `set -e` или проверку exitCode runner. Runtime transition test читает локальные objects b7cc125; полный history есть в bundle, shallow checkout недостаточен. Тестовые timestamps/archive nonces случайны; сравнивать invariant PASS, не требовать одинакового encrypted SQL SHA между запусками. `sha256sum -c …` проверяет сохранённые исходные artifacts, не новый random output. Для exact commit из bundle можно сразу checkout manifest.candidateCommit вместо применения patch.

Production Cloudflare/D1, настоящий Telegram/webhook/Cron, реальные secrets и remote Git не изменялись. Push, merge, deployment и remote restore не выполнялись.
