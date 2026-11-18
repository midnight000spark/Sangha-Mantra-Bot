# Telegram Admin UX и пользовательские сценарии

Статус: DESIGN, 14.11.2026. Это спецификация будущего 2.0, а не перечень работающих сегодня команд. Основа: RQ06–RQ10, RQ15–RQ23 в [MASTER_PLAN](MASTER_PLAN.md), ADR-03…ADR-07 в [DECISIONS](DECISIONS.md). Сценарии SC и текущие gaps — [VERIFICATION_MATRIX](VERIFICATION_MATRIX.md). Все показанные экраны — текстовые макеты, не live данные.

## UX-01 — Правила интерфейса

Основной интерфейс — DM с ботом, inline buttons, понятные ответы и «Назад / Отмена». Название кампании и контекст темы видны на каждом изменяющем экране. SQL, JSON, raw Telegram IDs и внутренние VALID/REVIEW не нужны для обычной операции. Диагностика доступна отдельным действием по правам. Общие операции занимают 2–4 перехода; первичная настройка и recovery длиннее и показывают шаг/результат.

В DM главное меню: «Кампании», «История», «Отчёты», «Требует внимания», «Проверка состояния», «Настройки», «Администраторы», «Помощь». Кнопки, недоступные по scope, скрыты; server-side проверка обязательна независимо от видимости. Групповой интерфейс ограничен participant commands и явным setup trigger. Админские суммы/экспорты в группу не публикуются.

Пустое состояние объясняет следующий шаг: «Кампаний пока нет. Подключите тему из нужной группы». Loading не объявляет успех операции. Ошибка доставки UI не повторяет бухгалтерское действие. При отказе editMessageText можно создать новый экран с тем же operation result; старые handles становятся stale. Устаревший экран: «Данные изменились. Обновите запись и проверьте новый итог».

Доступность: текстовые названия кнопок, статусы словами рядом с иконками, суммы с разделителями, timezone и дата явно. Основные различия не передаются одним цветом или emoji. Для длинного списка — cursor pagination и показ диапазона; предлагается 6 кампаний/страницу, 20 записей истории. Имена-дубликаты различаются подписью группы/темы. Ни pager, ни поиск не раскрывает недоступные кампании.

## UX-02 — Матрица прав

Это предлагаемая capability model OD03, не автоматически утверждённое делегирование.

| Действие | Владелец | Campaign admin с соответствующим scope | Участник |
|---|---|---|---|
| Читать status/history/trace | Все кампании | Только read назначенных кампаний | /progress в своём route; /check своей записи |
| Override/release, missing import, adjustment | Да | adjust; с reason/CAS | Нет; редактирует своё исходное Telegram-сообщение |
| Rename/goal/report/silent/pause | Да | manage_campaign / reports по выданному набору | Нет |
| Завершить кампанию | Да | manage_campaign по OD02 | Нет |
| Post-close amendment / archive | Да | По умолчанию только read после completion; расширение явно OD02 | Нет |
| Пригласить/отозвать campaign admin | Да | Только при явном owner delegation в пределах своих прав | Нет |
| Изменить owner, system backup/secrets/recovery | Защищённая system процедура | Нет | Нет |
| Экспорт ledger | Да | read/export в своём scope, санитаризированный формат | Только ответ о своём вкладе; массового экспорта нет |

1.x сохраняет ADMIN_IDS исполняющегося Worker; A02 применяет этот gate ко **всем** ответам. Межверсионный revoke завершён после перехода на новый env/artifact и доказанного drain старых invocations: redeploy сам по себе не отзывает старый config. Полная DB capability model не prerequisite F03. В 2.0 grants/epoch проверяются текущими supported writers в DB при mutation/final delivery; несовместимый старый writer должен быть остановлен.

## UX-03 — Карта экранов

| Экран | Вход и содержимое | Действия / результат / возврат |
|---|---|---|
| U00 — Первый запуск | DM /start; «владелец подтверждён / требуется локальная настройка» | Произвольный первый пользователь не получает owner. Инструкция локального bootstrap; без токена в ответе |
| U01 — Главное меню | DM /admin или разрешённый /start | Обзор доступного, счётчик открытых случаев; переходы в U02/U07/U11/U13/U15 |
| U02 — Кампании / status | /status или «Кампании» | Имя, total/goal/%, состояние, тишина, отчёт, число проблем; пагинация → U03 |
| U03 — Кампания | Выбор из U02; campaign context зафиксирован в handle | «Накопления», «Изменения», «Исправить», «Отчёты», «Тишина», «Настройки», «Завершить/Архив»; назад U02 |
| U04 — Подключение темы | /setup в конкретной теме от уполномоченного инициатора | Одноразовая привязка topic → DM wizard → preview → atomic activation либо DRAFT |
| U05 — Настройки | U03 | Rename, goal, report time/timezone/destination, publication enabled; preview diff и effective-from; назад U03 |
| U06 — Последние накопления | U03 /recent | 20 по original_date; сумма, исходное время, override/review label, доступная ссылка; → U08 |
| U07 — Последние изменения / log | U03 либо «История» с выбором campaign | По commit sequence: edits/corrections/import/settings/roles; фильтр времени/типа; → U08 |
| U08 — Трассировка | Запись из U06/U07, /inspect или /trace | Original/version/received times, effective before/after, reason, автор действия, causal events и reports; → U09/U11 |
| U09 — Исправление | U08 либо «Исправить» | Раздельно override/release и accounting adjustment; ввод → preview → confirm → audited result |
| U10 — Жизненный цикл | U03 | Pause/resume/complete/archive; последствия и pending cases, preview, confirm; → U03 |
| U11 — Отчёты | U03 или главное меню с выбором campaign | Snapshot + updated view отдельно; цель/календарь, delivery/hold/attempts и contributing events; → U12 или resolution |
| U12 — Тишина / delivery resolution | U03/U11 | Silent state и влияние; ON/OFF с versions. Для одного held/UNCERTAIN — отдельная сверка/разрешение, не «отправить всё» |
| U13 — Требует внимания | Главное меню / U03 | REVIEW, quarantine, delivery uncertainty, backup/health/gaps; severity, first/last, count, open/ack/resolved; → U08/U14/U15/U16 |
| U14 — Администраторы | Главное меню / U03 | Только доступные grants; invitation proof, capabilities preview, grant/revoke confirm; stale/ineligible запрет |
| U15 — Проверка состояния | Меню / U13 | DB/schema/consumer, last received update, confirmed delivery, pending/held/gaps, verified backup/restore age; понятное следующее действие |
| U16 — Сверка и экспорт | U13 / история | Campaign + period; CSV/JSONL ведомость, reconciled range/unknown gaps, missing import preview; scope проверяется при выдаче |
| U17 — Помощь | /help, контекстная кнопка | Кратко: писать одно число; редактировать исходник; удаление не гарантирует отмену; silent/pause и контакты ответственного |
| U18 — Participant status/check | /progress, reply /check, приватный путь | Только разрешённый контекст, свежий total/свой вклад; rate limit, no group output in silent |
| U19 — После завершения | Из U10/U13 | Final snapshot и поздние изменения отдельно; owner preview amendment, reason, completion revision и разрешение корректирующей публикации |

Для общих /recent, /log, /reports сначала выбор кампании; краткая форма допустима при единственной доступной. «Все кампании» — отдельный диагностический режим с campaign label в каждой строке и scope на каждую строку. Mutation всегда имеет campaign ID/server handle, даже когда UI показывает только имя.

## UX-04 — Онбординг темы без ID и SQL

Сценарий: «Общалка» и «Новости» остаются без учёта; Мани, Ваджрасаттва и Симхамукха подключаются отдельными кампаниями.

1. Владелец заранее прошёл local bootstrap U00. Default OD03 для MVP: инициатор имеет bot manage/enroll scope **и** является creator/administrator исходной группы. Telegram group admin не получает bot owner/scope автоматически. Для гарантируемого getChatMember proof бот тоже должен быть administrator; ненужные create/delete/manage_topics права не запрашиваются. Недоступный proof → DRAFT, не обход «достаточно чужого username/ID». [Bot API getChatMember](https://core.telegram.org/bots/api#getchatmember).
2. /setup вызван **в нужной теме**. Route берётся из authenticated Telegram update, не из свободного текста. >=128-bit одноразовый nonce связывает bot/actor/chat/thread/session/expiry 10 мин; другой actor/chat/thread не может register этот route. Bot проверяет getChat/forum metadata и getChatMember для себя и инициатора (verified user ID из update/DM), а не только Telegram username. Anonymous sender без доказанной user identity не активирует route. General с неподтверждённым mapping остаётся закрытым.
3. Пользователь сам открывает DM по предложенному переходу. Если бот не может первым написать, wizard ждёт DM, а не считает сообщение доставленным. При silent существующей кампании групповой setup reply подавляется; продолжение возможно через уже открытый DM с валидным handle либо новый разрешённый setup путь.
4. Wizard: отдельное имя кампании → goal → timezone/HH:mm → место отчёта и enabled → admins → стартовый баланс и boundary. Новая кампания не наследует историю по названию. Минимальный new opening — 0; ненулевой требует причины и доказанного отсутствия двойного импорта.
5. Показываются confirmed/unknown joined_at и отдельная historical boundary против старых originals. Source marker при необходимости относится к исходному chat, не DM ID. Это initial-cutoff proof, не механизм pause. Route activation выполняется после confirm/commit; прежние принятые записи не пересматриваются из-за новой boundary.
6. Preview: имя/группа/тема, goal/opening/import coverage, начало учёта, report period/destination, права, silent/reaction и platform backup policy. Показывается MVP ограничение OD02: «После архива для новой кампании потребуется новая тема; повторное использование этой темы пока не предусмотрено». Ошибка destination не открывает intake частично; DRAFT можно сохранить.
7. Перед confirm заново получаются membership/admin proofs; предлагаемая freshness <=60 сек, expired 10-minute nonce требует нового setup. Сеть вне DB transaction; затем scope/epoch/nonce/route uniqueness/versions/boundary и proof age проверяются атомарно с activation/audit. Смена ролей, о которой известно до commit, запрещает activation. Внешний proof фиксирует факт на проверенное время, не вечную гарантию Telegram роли. Duplicate confirm возвращает ту же кампанию; первый вклад/edit проверяется в TEST.

Повтор /setup в уже занятом route открывает доступную существующую кампанию или отказ; вторую на том же route не создаёт. Rename темы не требует re-enrollment; вновь созданная одноимённая тема требует его.

## UX-05 — История и incident 35

U06 отвечает «что было исходно отправлено», U07 — «что бот фактически изменил сейчас». Сортировка U07 — commit_seq, не original_date и не update_id. U08 соединяет обе истории и попытки публикации.

Пример U08 по историческому EV05, **не текущий production inspect**:

> Запись 35. Исходное сообщение: 12 ноября, 5000. Позднее редактирование: 13 ноября. Бот впервые добавил +5000 к прошлому дню. Это вошло в поправку отчёта за 13 ноября. По данным владельца сумма уже была в начальном переносе. Предложенное обнуление пока не подтверждено.

U11 для этого fixture показывает: предыдущий published total 32050; day 26500; correction +5000 → U08 contributing event; published total 63550. Значение 58550 обозначается только как preview результата возможной correction, пока нет committed audit. Для мигрированной записи без достаточного event trace UI говорит «часть происхождения не восстановлена», а не сочиняет цепочку.

Ссылка на оригинал предлагается, если технически доступна пользователю. «Ссылка недоступна» не меняет ledger. /check «не найдено» не трактуется как доказанный REJECTED; отдельные labels: «не было получено / нет записи», «отклонено по границе», «требует разбора», «учтено …».

## UX-06 — Коррекции, цель и завершение

U09 не объединяет три разных смысла «изменить количество»:

| Операция | Preview | Commit / повтор / запрет |
|---|---|---|
| Изменить цель | Старый/новый goal, актуальный total/%, превышение и milestone | Settings revision + audit; прошлые отчёты не меняются |
| Override / release записи | Source amount/state, override (0 явно), прежний/новый effective, delta, reason | Expected contribution revision; override переживает edit; release при конфликте source запрещён |
| Accounting adjustment | +/- delta, effective period, новый total, reason/provenance | Отдельная ledger operation; отрицательный итог/overflow запрещены; компенсация вместо удаления |

Шаги correction: выбрать запись → сумма/режим → reason → preview delta → confirm. При source edit между preview/confirm показать conflict и новый preview; не переносить старое подтверждение. Повтор callback не начисляет delta дважды. При editMessageText failure допускается новый UI response, но mutation не повторяется.

U10: preview «Пауза будет включена после окончательного подтверждения» не меняет приём. Confirm → atomic policy commit → «Пауза включена». Никакой даты в прошлом, source marker или пересчёта прежних вкладов; уже accepted ledger/total сохраняются. При rollback — ошибка и прежнее состояние, при потерянном UI ответе — чтение сохранённого результата без повторного перехода. Новые admission после commit удерживаются; resume после своего commit не выпускает старые holds/replays. Известные source edits и явные corrections работают по самостоятельным правилам. Completion показывает cases/сверку и ограничение reuse OD02; milestone сам кампанию не закрывает.

После COMPLETED/ARCHIVED известный edit попадает в POST_CLOSE_REVIEW с сохранением прежнего confirmed effect. U19 показывает proposed delta и новый updated final view; только санкционированный amendment меняет учёт и completion revision. Published final snapshot остаётся прежним. Корректирующая публикация имеет отдельный preview/permission. Used campaign архивируется, обычной кнопки стирания истории нет.

U05 report edit показывает timezone, ближайший UTC/local period и effective-from. При timezone change отдельно подтверждается transition period; при DST неоднозначности виден выбранный момент. OFF/ON отчётов, silent OFF и destination change не переотправляют held/UNCERTAIN. Settings preview не переосмысливает закрытые дни.

## UX-07 — Приглашение, отзыв и безопасность диалога

Invitation: U14 → campaign/capabilities → одноразовое приглашение → кандидат сам открывает бота → назначающий подтверждает **проверенную** identity и scope → grant/audit. Чужой username или текстовый ID не назначает права. Pending/expired/cancelled invite имеет читаемое состояние. По умолчанию delegation off; admin не может пригласить owner, выдать чужой campaign scope, повысить себя либо удалить последнего владельца.

После revoke старые menus/callbacks, pending DM, export requests и sessions проверяют новый auth epoch и отказывают без раскрытия чужих данных. На уже отправленный Telegram payload отмена прав не действует; предел final gate объяснён в ADR-05. Restore/ownership recovery аннулирует старые mutating sessions и invites; не продолжает их автоматически.

Протокол session/callback:

- Handle opaque, actor/DM/screen/action-bound, random nonce; привязаны campaign/source/record, expected versions, auth/policy epoch. Предлагаемый TTL mutating wizard — 10 минут, preview — 2 минуты; actual limits проверяются human TEST.
- Text input связывается с конкретным force-reply prompt/session. При двух открытых формах нельзя применить произвольное сообщение к «последней кампании». Пользователь отвечает нужному prompt либо явно выбирает форму.
- answerCallbackQuery быстро снимает spinner; «готово» означает только подтверждённый storage outcome. При DB failure — retry того же idempotency key. При expiry/permission conflict — refresh, без автоматического повторения mutation.
- Cancel закрывает только wizard; уже committed correction отменяется только компенсирующим действием. «Назад» сохраняет draft, не меняет ledger. Неизвестный/чужой handle — нейтральный отказ, без утечки campaign name.
- Два admins с одной expected revision: commit одного, у второго conflict с новым preview. Изменяющий callback никогда не зависит от глобального selected campaign.

## UX-08 — Разбор проблем, quarantine и delivery

U13 группирует incidents по типу/campaign/source/revision. Видны first/last occurrence, count, severity, open/acknowledged/resolved, конкретное следующее действие. Acknowledged означает «оператор увидел», resolved — проверенный результат; не «сообщение пользователю доставлено». Повторный сбой увеличивает count, не создаёт DM storm.

Quarantine card показывает context/ссылку, cause (unknown topic / metadata / initial historical boundary second / conflicting edit / post-close), прежний эффект и preview. Неоднозначная секунда относится к первичному historical cutoff, не к pause. Resolution требует scope/reason/revision; existing original нельзя перенести другой кампании. U16 показывает ImportBatch/coverage: «состав подтверждён / частично известен / неизвестен». Отсутствие DB row не доказывает отсутствие в opening/aggregate. Covered original повторно не начисляется; при PARTIAL/UNKNOWN default REVIEW без delta. Только owner может явно принять IMPORT_RISK_ACCEPTED с preview возможного двойного счёта и reservation original key; UI не называет это проверенным импортом. 14950 не разбивается на выдуманные записи.

UNCERTAIN card: snapshot, frozen destination, время/attempt и инструкция посмотреть Telegram. «Подтвердить отправку» требует message reference/evidence и reason; «Разрешить одну повторную попытку» — отдельное подтверждение риска дубликата после сверки. Удержанный без попыток report отличается от UNCERTAIN. FAILED_KNOWN, видимый в Telegram, помечается incident до разбора; обычный retry не предлагается как автоматическое лечение.

U15 различает платформы: 1.x D1 — выбранные 7 дней provider Time Travel, доступный point/TEST runbook status; Node v2 — verified external snapshot/restore drill age и выбранные RPO/RTO. Upload не равен verified; hourly stale alert не применяется к 1.x. Утрата owner account направляет к local recovery; /claim-owner в DM нет.

## UX-09 — Участники, реакции и исправление сообщения

P1 scope по OD05/06:

- /progress в зарегистрированной ACTIVE теме выводит campaign name, total/goal, осталось max(0,goal−total), процент и время расчёта. Unknown/inactive route по default молчит. Нельзя выбирать соседнюю кампанию. В silent группового ответа нет.
- /check как reply на собственный original показывает фактический effective amount и outcome. Проверяется авторство и доступ; чужая запись не раскрывается. Для длинной ссылки в DM проверяется original key и текущий доступ, сам URL не является разрешением. Если нет proof либо reply недоступен, предлагается admin reconciliation.
- Приватный /progress требует подтверждённого текущего доступа к группе/кампании; owner/admin — свой scope, участник — проверяемое membership proof. Если API/permissions не позволяют его подтвердить, статус не раскрывается; бот объясняет, как обратиться к администратору. Silent не открывает обход privacy. Пользователь сам начинает DM.
- Предлагаемый anti-spam: /progress не чаще одного группового ответа за 30 секунд на source, плюс actor limit; /check — один запрос/10 секунд на actor и общий source budget. Duplicate commands coalesce, stale queued replies истекают; 429 уважает retry delay. Значения — OD06 / TEST tuning.
- Любая command message целиком исключается **до** numeric parser, включая числовые аргументы и случаи отсутствующей entities разметки. Бот не считает собственные ответы. Command menu показывает /progress, /check, /help участнику и admin команды в DM, но не заменяет authorization.
- Принятый вклад effective > 0 может получить 🙏 после commit и final version fence. Zero/INVALID/REVIEW/quarantine не подтверждаются; при ошибке удаления фиксируется mismatch. Silent блокирует и cleanup: ранее поставленный 🙏 может устареть. После OFF U13/U12 предлагает адресный reconcile текущего desired state, не «отправить всю очередь». Scope reactions/commands фиксируется до RC/B27 по OD05/06.
- Help: «Чтобы исправить число, отредактируйте исходное сообщение. Удаление сообщения обычно не отменяет учтённый вклад. Если редактирование недоступно — запросите сверку». Self-correction через DM и strict/flexible parser profiles отложены; текущие правила 1.x не меняются.

Первый public self-hosted setup предназначен для новой пустой DB и собственного bot identity. В мастере нет обязательного шага «импортировать D1» или запроса production credentials/архива Сангхи. Самостоятельный B28 показывается в support matrix как отдельная неподдержанная до приёмки функция; это не ошибка готовности fresh install.

## UX-10 — Ошибки и человеческая приёмка

| Состояние | Обычный ответ / безопасное действие |
|---|---|
| Нет прав / revoke | «Доступ изменился. Обновите список доступных кампаний»; без нового чтения/изменения |
| Version conflict | «Запись изменилась после открытия. Проверьте новый расчёт»; новый preview |
| Invalid amount/reason | Показать допустимый формат/диапазон; draft сохранён, ledger не изменён |
| Route/boundary не подтверждены | «Учёт ещё не включён. Завершите подключение темы»; нет начисления/реакции |
| Source/link недоступен | История сохранена; запросить evidence/reconciliation, не удалить вклад |
| DB/Telegram failure | ID случая для support в расширении, outcome pending/uncertain честно; mutation не повторять новым ключом |
| Backup stale / gaps | Показать возраст/неизвестный диапазон и конкретный runbook; health green не подменяет полноту |

Human acceptance SC15/SC21/SC27: человек без SQL/JSON/Telegram IDs подключает «Симхамукху», задаёт имя/goal/отчёт, отличает её от Мани и Ваджрасаттвы, проверяет первый вклад/edit, делает override=0 с reason, находит trace, меняет goal, добавляет помощника и отзывает доступ, видит backup/restore статус, pause/resume и archive последствия. Отдельно проходят реальные callback clicks, stale screens, два администратора, General и длинный silent/report цикл. Bot-to-bot receipt не закрывает эту приёмку.

Receipt содержит TEST identity fingerprint, code SHA, шаги/время, actual outcome/screens, audit/event/attempt references и список непроверенного. Реальные персональные данные остаются в защищённом TEST evidence, публичная сводка санитаризируется.
