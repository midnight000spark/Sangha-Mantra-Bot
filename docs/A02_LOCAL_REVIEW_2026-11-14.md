# A02 / F03 — пакет для независимого локального ревью

14.11.2026. Вердикт исполнителя: **LOCAL_VERIFIED**. Проверяемый scope — maintenance 1.x A02/F03. Независимое ревью A02 ещё требуется; этот результат не разрешает merge или production deployment. A01 принят по входному сообщению с APPROVE и не перерабатывался. Остальные P0-задачи не изменены.

## Base и изоляция

- Исходный репозиторий: `sangha-mantra-bot-public`, HEAD `b7cc125a47c4b791cdafefcd22dbc1859a8f126f`. A01 и planning docs оставались незакоммиченными.
- Все девять файлов реализации A01 совпали с `test-results/a01/source-files.sha256`. Исходное дерево и index оставлены на месте.
- Через временный Git index создан локальный snapshot-коммит **`95d99fae3fef3f7a1dc537a40a5e50e48913f407`**: точный A01-base вместе с существующими planning inputs. Его parent — исходный HEAD. Это локальный base, которого нет на удалённом Git.
- A02 реализован в отдельном worktree `sangha-mantra-bot-a02`, ветка `local/a02-f03`. Отдельный A02-коммит и его точный SHA записаны в `test-results/a02/manifest.json`; patch сравнивается только с указанным snapshot-base.
- Финальная проверка исходного репозитория: HEAD и полный porcelain status прежние, содержимое всех 97 файлов snapshot-base совпало; `original-preserved.json`. Ни один файл A01 там не перезаписан. Сохранённый base и A02 доступны также в локальном Git bundle.

Прочитаны AGENTS.md, карточка BACKLOG A02, SC07/RQ07, ADR-05 и UX-02 с ограничением 1.x. Planning docs остаются входным документом со старым статусом PLANNED/NOT IMPLEMENTED; фактический локальный результат A02 зафиксирован здесь и в manifest. Новая архитектурная фаза не проводилась.

## Причина и исправление

`deliverNotices()` проверял текущий `config.adminIds` лишь для ключей `ui:`. Очереди обычных административных ответов `admin:` и операторских сообщений `alert:` обходили проверку. Авторизация при создании очереди не защищала от последующего отзыва.

Теперь один final gate после последнего awaited D1 read охватывает все существующие административные outbox producers: `ui:`, `admin:`, `alert:`. Ответ `/export` создаётся через `admin:`; отдельной отправки архива через Telegram в 1.x нет. Неадминистративные participant/group keys не проходят административную проверку. Новый административный producer должен использовать один из этих namespaces; отдельный schema/type/role framework не вводился.

При отказе Telegram transport и разбор markup не вызываются. D1 batch атомарно сохраняет `NOTICE_AUTH_DENIED` и `FAILED_KNOWN` с `last_error='Administrator access revoked before notice delivery'`, очищает claim/lease и не устанавливает sent message ID. Оба statement ограничены campaign, `SENDING` и текущим claim token; audit INSERT идёт первым, UPDATE — вторым. Audit содержит ключ уведомления, recipient chat ID, время и код `ADMIN_ACCESS_REVOKED`, без body/markup/token. Падение второго statement откатывает и audit INSERT — проверено реальным локальным D1.

Автоматический sender выбирает только PENDING: отказ не повторяется ни при следующем Cron, ни после возврата прав. `/notice_retry` требует прежней явной процедуры с причиной; каждая повторная попытка снова проверяет адресата. Если права всё ещё отозваны, сохраняется новый отказ для нового claim. `/notice_sent` остаётся существующим ручным подтверждением после проверки Telegram. При исключении проверки или D1 отправка запрещена; незавершённый claim сохраняет прежний переход SENDING → UNCERTAIN по истечении lease и требует проверки оператором.

Production diff ограничен `src/admin.ts`: расширение namespace gate и атомарная запись отказа. Миграций нет. Claim CAS, срок lease, дедупликация, публикационные holds и обычный путь отправки сохранены. Успешный путь не добавляет D1 statements; отказ использует два statement одним batch вместо прежнего финального UPDATE. Масштабирование и capacity PASS не заявляются.

Тестовые изменения: общий corpus `tests/notice-auth-cases.ts`, SQLite и D1/workerd runners, compiled Worker/two-env probe; в существующем `admin-dialog.test.ts` отдельно учтены два новых audit event вместо ожидания только трёх прежних событий.

## Проверки и доказательства

Все команды выполнялись локально с `CI=true WRANGLER_SEND_METRICS=false`. Полные stdout/stderr и exit codes сохранены в `test-results/a02/`.

| Проверка | Результат | Evidence |
|---|---|---|
| До изменения production-кода: `bun test tests/notice-auth.test.ts tests/notice-auth-runtime.test.ts -t 'F03 admin:'` | Ожидаемый red: 0 PASS / 2 FAIL, exit 1. Оба движка фиксируют фактический вызов подменённого transport с административным body для 42 после смены config на `[43]` | `red-on-base.log`, `.json`; source diff пуст |
| Финальные те же regression files на `git archive` точного base: `bun test tests/notice-auth.test.ts tests/notice-auth-runtime.test.ts -t 'F03 (admin\|alert):'` | Ожидаемый red: 0 PASS / 4 FAIL, exit 1. Код base не менялся; тесты скопированы побайтно из итогового пакета | `red-on-base-final.log`, `.json` с SHA-256 исходника и тестов |
| Первый адресный набор после исправления | 42 PASS / 0 FAIL | `focused.log`, `.json` |
| `bun run typecheck` | PASS, exit 0 | `typecheck.log`, `.json` |
| `bun test tests/notice-auth.test.ts tests/notice-auth-runtime.test.ts tests/maintenance.test.ts tests/maintenance-runtime.test.ts tests/silent-order.test.ts tests/admin-dialog.test.ts` | 96 PASS / 0 FAIL, 577 assertions, exit 0 | `focused-final.log`, `.json` |
| `bun run check` (typecheck + полный `bun test`) | 251 PASS / 0 FAIL, 1132 assertions, 19 files, exit 0 | `check-final.log`, `.json` |
| `bun run build` | PASS, exit 0; только Wrangler `deploy --dry-run --env test` | `build.log`, `.json` |
| Собранный Worker, два env на одной локальной D1 | PASS, 9 assertions. Новый `[43]` отклоняет три вида отложенных admin notices, доставляет retained admin и participant/group notices. Старый `[42]` способен доставить новый queued intent для 42 | `compiled-worker.log`, `.json`; также в полном наборе |
| Whitespace, применимость patch к base, Git bundle | Exit codes и результат в manifest | `packaging-checks.json` |

Финальная base-replay команда использует regex `F03 (admin|alert):`; обратная косая в таблице экранирует разделитель Markdown, в JSON хранится точный argv.

Corpus выполняет 21 одинаковый сценарий на SQLite-adapter и на настоящем локальном D1/workerd, затем отдельный compiled Worker test. Проверены три namespace revoke/replay/regrant, нормальная и конкурентная доставка, один audit при concurrent denial, изменение config перед и после final D1 read, exception авторизации, настоящий SQL error в финальном gate, оба отказа denial batch через SQL `RAISE(ABORT)`, rollback audit при сбое UPDATE, потеря claim, запрет разбора payload при отказе, обычные private/group notices, silent ON/OFF/held release, UNCERTAIN, recovery boundary, явный retry с повторным отказом и разрешённая доставка после regrant + fresh release. Существующие A01/runtime/report tests прошли в полном наборе.

Промежуточные ошибки не скрыты: первый расширенный прогон имел 95 PASS / 1 FAIL из-за нового audit count (`focused-initial-failed.*`); исходная версия compiled probe обращалась к неактивному HTTP scheduled endpoint и получила 404 (`compiled-worker-initial-failed.*`), затем заменена на `getWorker(name).scheduled()`; первоначальный typecheck выявил два приведения fetch mock (`typecheck-initial-failed.*`), исправлены. Authoritative результаты — final logs из таблицы.

Окружение: Linux x64; Bun 1.4.4 (`38afee6c8`), Node v22.23.4, TypeScript 7.0.2, Miniflare 4.20260730.0 / workerd 1.20260730.1, Wrangler 4.160.0; pinned dependencies и migrations 0001–0008 сохранены. D1 database instances изолированы и синтетические; весь Telegram transport подменён. Реальный Telegram и remote D1 не вызывались.

## TOCTOU и границы результата

В принятой архитектуре 1.x права находятся в `ADMIN_IDS` исполняющегося Worker, а не в D1 grants. Поэтому тест изменения прав у финального D1 gate меняет config этого invocation; D1 проверяет актуальные state/claim/publication policy. Между завершением D1 read и административной проверкой нет дополнительного await; после успешной административной проверки до вызова transport также нет await. Это уменьшает окно, но не создаёт транзакцию с Telegram API.

Изменение прав, видимое config до final authorization, блокирует вызов API. Уже разрешённый/начатый сетевой запрос может успешно завершиться после отзыва; отдельный regression явно фиксирует эту границу. Silent policy имеет прежнюю аналогичную границу после финального SQL read. Абсолютная атомарность D1 и внешнего API не заявляется.

Старый invocation сохраняет старый env после изменения deployment config. Это показано двумя собранными Workers на общей D1. Межверсионный revoke считается завершённым только после перехода на новый config/artifact и доказанного прекращения старых writers. Мгновенный глобальный revoke, DB epochs и новая модель ролей остаются вне A02. Live drain и реальная задержка провайдера локальными тестами не доказаны.

## Rollout / rollback для следующего согласованного этапа

До rollout нужны независимое ревью точного A02 SHA, остальные применимые maintenance gates и отдельное разрешение на live действия. A02 не добавляет миграций; A01 по-прежнему требует 0008. Обновить `ADMIN_IDS`, использовать проверенный artifact, исключить параллельных старых writers, подтвердить drain и лишь затем объявлять отзыв завершённым. Контролировать отсутствие отправок отозванным адресатам, `NOTICE_AUTH_DENIED`/FAILED_KNOWN, UNCERTAIN и задержку обычной доставки; body для этого логировать не требуется.

Rollback должен сохранять A01 command ordering и A02 final authorization. Возврат к исходному `b7cc125` или к A01-only base снова открывает F03; такой fallback нельзя считать безопасным. При необходимости остановить outbound и удержать очередь до проверенного совместимого artifact. Отказы не выпускать массовым SQL reset; использовать существующую ручную процедуру с актуальной проверкой полномочий. Production readiness, native Telegram acceptance, PITR/cutover и capacity этим пакетом не подтверждаются.

## Состав пакета

`test-results/a02/A02.patch` содержит только шесть A02 файлов относительно snapshot-base: production-файл, четыре тестовых файла и этот handoff. `source-files.sha256` содержит SHA-256 всех шести; `manifest.json` — точные base/candidate SHA, Git status, SHA-256 patch/bundle и полный inventory evidence. `artifact-files.sha256` позволяет проверить все файлы пакета, `manifest.sha256` — сам manifest. Git bundle делает локальный base переносимым.

Для воспроизведения: проверить хеши, проверить bundle, извлечь ветку в отдельный repository/worktree; либо восстановить snapshot-base из bundle и применить patch после `git apply --check`. Установить зависимости из неизменённого lockfile и повторить команды таблицы. При red-on-base скопировать только три новых notice-auth test files на base; код `src/` оставить исходным. Evidence archive находится рядом с каталогом `a02/`.

Удалённые PR, push, merge, deployment, реальные DB, secrets и webhook/Cron настройки не изменялись. Созданы только локальные base/A02 commits и review artifacts.
