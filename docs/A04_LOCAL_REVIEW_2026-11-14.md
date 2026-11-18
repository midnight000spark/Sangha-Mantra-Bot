# A04 — boundary / historical incident regression handoff

14.11.2026. Вердикт: **LOCAL_VERIFIED**. Scope: maintenance 1.x, карточка A04 из актуального BACKLOG: boundary/incident fixtures и evidence текущего audit/legacy coverage. Production authorization не выдаётся.

## Точный исходный кандидат и изоляция

Base: `a8105e768d3851c96d7633868299d8e0b08af554` — одобренный A03/F05, содержащий A01/F04 и A02/F03. Candidate SHA записан в `test-results/a04/manifest.json` и внешнем `test-results/a04/HANDOFF.md`: это единственный локальный commit поверх base, включающий данный документ. Полный patch строится от указанного base.

Фактически обнаруженные исходные деревья:

| Дерево | HEAD | Состояние на входе |
|---|---|---|
| `sangha-mantra-bot` | `65e54e3a81197e09c76fad21460c197d2d300e2f` | clean |
| `sangha-mantra-bot-public` | `b7cc125a47c4b791cdafefcd22dbc1859a8f126f` | 7 modified, 4 untracked entries; A01/planning inputs |
| `sangha-mantra-bot-a02` | `729736f83095937d0bfb5b4ea6233857dbd0819e` | clean |
| `sangha-mantra-bot-a03` | `a8105e768d3851c96d7633868299d8e0b08af554` | clean |

Создан отдельный worktree `sangha-mantra-bot-a04`, ветка `local/a04-boundary-regressions`, от exact base. У него отдельные working files/index; Git objects/common metadata общие с A03. Изменение inventory A03 состоит в добавлении этого worktree/ветки; HEAD/ветка A03 и исходные файлы не изменены. Использованы существующие pinned dependencies через локальные symlinks внутри ignored `node_modules/`, без установки или изменения lockfile.

Прочитаны родительский AGENTS.md, SESSION_STATE, BACKLOG A04, SC04/05/18 и EV05. SESSION_STATE сохраняет историческое docs-only состояние и прежние HEAD/PLANNED; это не актуальная оценка уже одобренных A01–A03. Восемь planning-файлов побайтно совпадают с текущими незакоммиченными planning inputs в public; они не переписывались. Текущий запрос, exact Git ancestry и фактические проверки определяют scope A04.

`original-before.json`, `original-after.json`, `preservation.json` фиксируют HEAD/status/worktree inventory и SHA-256 всех tracked/nonignored untracked файлов четырёх исходных деревьев. Сравнение файлов/HEAD/status исходных деревьев строгое; в общем inventory допускается только движение HEAD нового A04 worktree на candidate. Ignored secrets/БД не читались. Первый snapshot сделан после создания A04 worktree; исходный inventory до создания приведён в ходе проверки, а добавленный linked worktree описан выше.

## Результат расследования

Недостающие сценарии сначала добавлены и запущены на неизменённом production-коде A03. **Дефекта `automatic_intake_boundaries` в проверенном scope не обнаружено.** `src/`, migrations, scripts, config, package/lockfile и все прежние tests побайтно равны base. Diff состоит только из трёх новых regression files, этого handoff и JSON evidence manifest. Искусственное исправление runtime не создавалось.

`ingest()` читает boundary в том же D1 batch, где пишет event/вклад. Для отсутствующей строки проверяются оба предоставленных ограничения: `message_id < first_message_id` либо исходный `message.date < original_not_before` дают REJECTED. Сравнение включённое, равенство допускается. `edit_date`, время доставки и update_id не заменяют исходную дату/ключ. Без boundary новая запись не создаётся; webhook возвращает retryable failure, отчёты приостановлены.

Уже существующая строка обрабатывается обычным version ordering и не удаляется при установке boundary. Это сохраняет явные overrides, включая 0, и оставляет уже учтённый дубль №35 до отдельной разрешённой коррекции. Граница предотвращает новый автоматический старый вклад, но не служит массовым ретроспективным пересчётом. Exact replay защищён event key/nonce; административные import/override имеют свои idempotency keys. Import не перезаписывает занятый исходный ключ.

`initialize()` и migrations не назначают boundary. Добавленный config alias и alias после Telegram group migration не наследуют marker другого чата. Синтетическая production identity проверена только локально: повторная инициализация не создаёт policy по текущему времени. Все найденные записи boundary относятся к явному synthetic/TEST enrollment или примеру операторского SQL. `unixepoch()` в example заполняет audit `created_at`, не cutoff; first_message_id там явный example marker. Никакой example не исполнялся против production.

## Обязательные исторические сценарии

Один corpus выполняется на SQLite и настоящем локальном D1/workerd; дополнительный тест собирает реальный Worker с test-only wrapper для ожидания `waitUntil`. Внешний Telegram заменён локальным outbound service.

- **№32/35/38 отсутствуют:** по три различные новые редакции, запоздалый original, exact replays, прямой/обратный порядок. Каждая попытка REJECTED, старые строки не возникают, каждый audit delta равен 0, начальные 14 950 сохраняются. У собранного Worker проверены отсутствие вкладов и всех outbound calls.
- **№32/38 уже есть с override=0:** установка boundary не меняет строки; новые/старые/повторные редакции и восстановление сохраняют 0. Audit прежних corrections не меняется. Даже при утраченной boundary уже существующие строки допускают source edits; неизвестная новая строка остаётся закрыта.
- **№35 уже есть без override:** остаётся 5 000 после установки boundary и повторных edits. Реальный report SQL воспроизводит `32050 + 26500 + 5000 = 63550`, source event deltas №35 дают +5 000. Только explicit idempotent override0 меняет synthetic total на 58 550; дальнейший source edit не отменяет 0. Опубликованный snapshot остаётся 63 550 с correction +5 000.
- **Первоначальные 14 950:** explicit import записывается один раз; exact command replay не добавляет второй IMPORT, новый command key для занятого original отвергается. Source edits не изменяют opening override. Это защита одного доказанного исходного ключа, не доказательство состава агрегата.
- **Новый источник:** alias без своей границы закрыт; собственные ID/time predicates проверяются отдельно, старый source не меняется. У compiled Worker group migration добавляет alias без boundary; health/повторная initialization её не угадывают, reports остаются paused.
- **Restore:** synthetic D1 state → AES-GCM archive → отдельная SQLite restore → SQL reimport в новый D1. Все исходные contribution/event/adjustment/boundary rows равны до replay; сохранены 0 у 32/38 и некорректированный 35, import остаётся один, отсутствующие старые строки отвергаются. Recovery держит reports. Если boundary в восстановленном состоянии отсутствует, initialization не создаёт замену.

Source IDs 900/41/42 и балансирующие 17 100 — **синтетические**. Принадлежность сообщений к реальному переносу 14 950, полнота переноса и исходный aggregate key остаются UNKNOWN. Owner-reported включение №35 не превращено в независимо доказанный состав. Реальное исполнение correction35 и текущий production total не проверялись. Исторические 58 550 не выдаются за сегодняшний баланс.

Машиночитаемый [A04_EVIDENCE_MANIFEST.json](A04_EVIDENCE_MANIFEST.json) разделяет OWNER_OBSERVED_INHERITED, SYNTHETIC_LOCAL_REGRESSION и UNKNOWN, описывает текущие event/admin/report audit fields и PARTIAL causal coverage. Полный v2 causal sequence/ImportBatch/Coverage не внедряется в A04; UX trace остаётся B23.

## Проверки и воспроизведение

Все команды локальные с `CI=true WRANGLER_SEND_METRICS=false`; stdout/stderr и exit codes лежат в ignored `test-results/a04/` и в evidence archive.

| Проверка | Результат | Evidence |
|---|---|---|
| Новый corpus, SQLite + D1/workerd + compiled Worker + restore | 22 PASS, 0 FAIL; 338 assertions | `focused-final.log/.json` |
| Exact base archive + только три новых regression files | 22 PASS, 0 FAIL; production-файлы до/после равны base/candidate | `reproduce-base.log/.json`, `base-replay.*` |
| Полный typecheck + весь suite, включая A01/A02/A03 | 325 PASS, 0 FAIL; 1710 assertions, 23 files; exit 0 | `check-final.log/.json` |
| Отдельный typecheck новых fixtures | exit 0 | `typecheck-initial.*`; итоговый check включает финальную версию |
| Wrangler `deploy --dry-run --env test` | exit 0, без upload | `build.log/.json`, `dist/` |
| `bun run backup:drill` | exit 0: actual local Wrangler D1 export, AES-GCM, separate restore/SQL reimport; boundary/silent order/holds/generated totals; wrong key/tampering rejected | `backup-drill.log/.json` |
| Whitespace, exact patch apply/tree, bundle, source preservation | результаты и hashes в manifest | `packaging-checks.json`, `preservation.json` |

Первый focused run: **21 PASS / 1 FAIL**. Это ошибка нового test-only SQL exporter: он вставлял строки до создания FK parent tables; D1 сохраняет FK enforcement. Helper исправлен на создание всех таблиц, затем parent-first rows, затем triggers. Runtime/backup/restore code не менялся; первый failure сохранён в `focused-initial.log/.json`. Ни один дефект production-кода этим failure не заявляется.

Для повторения в чистой копии exact candidate с pinned dependencies:

```sh
CI=true WRANGLER_SEND_METRICS=false bun test tests/intake-boundary.test.ts tests/intake-boundary-runtime.test.ts
CI=true WRANGLER_SEND_METRICS=false bun run check
CI=true WRANGLER_SEND_METRICS=false bun run build
CI=true WRANGLER_SEND_METRICS=false bun run backup:drill
```

`python3 test-results/a04/reproduce-base.py` из распакованного evidence создаёт временный `git archive` exact base, добавляет только новые tests, запускает их и проверяет production hashes до/после. Сам script и test inputs входят в evidence archive. Base должен быть доступен локально; никакой fetch не выполняется.

`A04.patch`, incremental `A04.bundle` (требует base), `source-files.sha256`, `artifact-files.sha256`, `manifest.json`, его отдельный SHA-256, verification logs и внешний `HANDOFF.md` находятся в `test-results/a04/`; архив evidence лежит рядом. Exact SHA и финальный clean status отражены в manifest после commit.

## Риски будущего rollout

- Нужна доказанная фактическая production boundary на каждый source. Нельзя выбирать текущий момент для уже работающего источника. Если доказательств нет, rollout останавливается. Time-only boundary включительна с точностью до секунды и не доказывает порядок сообщений внутри секунды; это legacy-семантика, не новый enrollment proof/REVIEW из будущего B14.
- Существующий duplicate35 не исчезнет после установки boundary. Коррекция требует отдельно разрешённой операции, проверки исходного состояния и сверки результата. Пакет её в production не выполняет.
- 1.x explicit import доверяет операторской проверке и reason. Отсутствие DB row не доказывает отсутствие в aggregate14950; импорт того же вклада под другим original key не дедуплицируется по составу агрегата. Новая v2 coverage policy не подменяется локальным PASS.
- Восстановление сохраняет только содержащиеся в snapshot строки. Missing updates после snapshot, реальные публикации, restore loss window, one-writer/drain, identity и cutoff требуют операционной сверки. Нельзя восстанавливать потерянную boundary автоматически или повторять uncertain outbound.
- A04 сохраняет все ограничения A01–A03, включая final-read/API TOCTOU и необходимость drain старых Worker versions. Нового deployment artifact/schema не вводится; cumulative candidate всё равно требует их migration/compatibility gates.
- Provider PITR в synthetic remote TEST, human Telegram TEST, capacity, real production identity/PITR readiness/cutover относятся к следующим разрешённым пакетам и здесь не проверены. A05/A06/A08/A09 и отдельное разрешение live window остаются впереди. LOCAL_VERIFIED не является production authorization.

Удалённый Git, PR, реальные Telegram/Cloudflare, production и secrets не изменялись. Выполнены только локальные чтения/изолированные tests, создание нового worktree и локального candidate/evidence.
