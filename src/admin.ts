import { isTestSender } from "./test-sender";
import { adminHelp, dateText, inspectText, number, stateText } from "./admin-text";
import { silenceState, setSilence } from "./controls";
import type { Config } from "./types";
import { adjust, DomainError, importContribution, inspect, totals } from "./core";
import { resolveReport } from "./reports";
import { sendTelegramMessage, type ReplyMarkup, type TelegramMessage } from "./telegram";

export async function enqueueNotice(db: D1Database, config: Config, key: string, chatId: number, body: string, now: number, replyId?: number, eventAt = now, sourceEventKey?: string): Promise<void> {
  // Revision-specific intents may replace unsent obsolete warnings. Keep the existing
  // once-per-message behavior once a warning has actually been confirmed SENT.
  await db.prepare(`INSERT INTO notices(notice_key,campaign_id,chat_id,reply_message_id,body,created_at,publication_hold,source_event_key)
    SELECT ?,?,?,?,?,?,CASE WHEN ?<0 AND EXISTS(SELECT 1 FROM campaign_controls WHERE campaign_id=? AND (silent=1 OR notices_not_before>=?)) THEN 1 ELSE 0 END,?
    WHERE ? IS NULL OR NOT EXISTS(SELECT 1 FROM notices n WHERE n.campaign_id=? AND n.chat_id=?
      AND n.reply_message_id=? AND n.notice_key LIKE 'rejected:%' AND n.state='SENT')
    ON CONFLICT(notice_key) DO NOTHING`)
    .bind(key, config.campaignId, chatId, replyId ?? null, body.slice(0, 4000), now, chatId, config.campaignId, eventAt,
      sourceEventKey ?? null, sourceEventKey ?? null, config.campaignId, chatId, replyId ?? null).run();
}

// The committed contribution pointer, not receipt time/update_id, orders processed revisions.
// REVIEW retains the previous unambiguous version_date/is_edit; its last_event_key identifies
// the conflicting event. Original identity must still match. Overrides, including zero, resolve it.
// Legacy rejected: rows have no proven revision and deliberately fail closed.
const currentWarningSource = `EXISTS(SELECT 1 FROM event_log e JOIN contributions c
  ON c.source_chat_id=e.source_chat_id AND c.message_id=e.message_id AND c.campaign_id=e.campaign_id
  WHERE e.event_key=notices.source_event_key AND e.campaign_id=notices.campaign_id
    AND e.source_chat_id=notices.chat_id AND e.message_id=notices.reply_message_id
    AND c.original_date=e.original_date AND c.last_event_key=e.event_key AND c.override_amount IS NULL
    AND ((c.source_state='INVALID' AND e.source_state='INVALID' AND e.outcome='APPLIED'
      AND c.version_date=e.version_date AND c.is_edit=e.is_edit)
      OR (c.source_state='REVIEW' AND e.outcome='NEEDS_REVIEW')))`;

export async function deliverNotices(db: D1Database, config: Config, token: string, now = Date.now()): Promise<void> {
  await db.prepare(`UPDATE notices SET state='UNCERTAIN',last_error='Sender lease expired; inspect Telegram before retry'
    WHERE campaign_id=? AND state='SENDING' AND claimed_at<?`).bind(config.campaignId, now - 300_000).run();
  const pending = await db.prepare(`SELECT notice_key FROM notices WHERE campaign_id=? AND state='PENDING' AND publication_hold=0
      AND (chat_id>0 OR NOT EXISTS(SELECT 1 FROM campaign_controls WHERE campaign_id=? AND silent=1)) ORDER BY created_at LIMIT 2`)
    .bind(config.campaignId, config.campaignId).all<{ notice_key: string }>();
  for (const row of pending.results) {
    const claim = crypto.randomUUID();
    const notice = await db.prepare(`UPDATE notices SET state='SENDING',claim_token=?,claimed_at=?
      WHERE notice_key=? AND state='PENDING' AND publication_hold=0
        AND (chat_id>0 OR NOT EXISTS(SELECT 1 FROM campaign_controls WHERE campaign_id=? AND silent=1)) RETURNING chat_id,body,reply_message_id,reply_markup`)
      .bind(claim, now, row.notice_key, config.campaignId).first<{ chat_id: number; body: string; reply_message_id: number | null; reply_markup: string | null }>();
    if (!notice) continue;
    // Final source/publication fence. A later D1 commit can still race the external API;
    // no await is introduced between this read, A02 authorization and transport invocation.
    const permitted = await db.prepare(`SELECT 1 FROM notices WHERE notice_key=? AND state='SENDING' AND claim_token=?
      AND campaign_id=? AND publication_hold=0
      AND (chat_id>0 OR NOT EXISTS(SELECT 1 FROM campaign_controls WHERE campaign_id=? AND silent=1))
      AND (notice_key NOT LIKE 'rejected:%' OR ${currentWarningSource})`)
      .bind(row.notice_key, claim, config.campaignId, config.campaignId).first();
    if (!permitted) {
      // Terminal known non-send, never SENT. Audit/state are atomic and claim-fenced.
      // Recheck in the cancellation transaction: a lost claim cannot cancel another sender.
      const staleWarning = `notice_key=? AND campaign_id=? AND state='SENDING' AND claim_token=?
        AND notice_key LIKE 'rejected:%' AND NOT ${currentWarningSource}`;
      if (row.notice_key.startsWith("rejected:")) await db.batch([
        db.prepare(`INSERT INTO operational_events(event_key,campaign_id,kind,source_chat_id,message_id,detail,created_at)
          SELECT ?,campaign_id,'NOTICE_SOURCE_STALE',chat_id,reply_message_id,?,? FROM notices WHERE ${staleWarning}`)
          .bind(`notice-source-stale:${claim}`, JSON.stringify({ noticeKey: row.notice_key, reason: "SOURCE_REVISION_NOT_CURRENT" }),
            now, row.notice_key, config.campaignId, claim),
        db.prepare(`UPDATE notices SET state='FAILED_KNOWN',last_error='Source revision no longer confirms warning',
          sent_message_id=NULL,claim_token=NULL,claimed_at=NULL WHERE ${staleWarning}`)
          .bind(row.notice_key, config.campaignId, claim),
      ]);
      await db.prepare(`UPDATE notices SET state='PENDING',publication_hold=1,claim_token=NULL,claimed_at=NULL
        WHERE notice_key=? AND state='SENDING' AND claim_token=?`).bind(row.notice_key, claim).run();
      continue;
    }
    // All administrative outbox producers use these namespaces, including operator alerts.
    // 1.x authority is the executing Worker's config, not a DB grant: old envs require drain.
    // Recheck after the last awaited read. An already authorized API request cannot be revoked.
    if (/^(?:ui|admin|alert):/.test(row.notice_key) && !config.adminIds.includes(notice.chat_id)) {
      await db.batch([
        db.prepare(`INSERT INTO operational_events(event_key,campaign_id,kind,source_chat_id,detail,created_at)
          SELECT ?,campaign_id,'NOTICE_AUTH_DENIED',chat_id,?,? FROM notices
          WHERE notice_key=? AND campaign_id=? AND state='SENDING' AND claim_token=?`)
          .bind(`notice-auth-denied:${claim}`, JSON.stringify({ noticeKey: row.notice_key, reason: "ADMIN_ACCESS_REVOKED" }),
            now, row.notice_key, config.campaignId, claim),
        db.prepare(`UPDATE notices SET state='FAILED_KNOWN',last_error='Administrator access revoked before notice delivery',
          sent_message_id=NULL,claim_token=NULL,claimed_at=NULL
          WHERE notice_key=? AND campaign_id=? AND state='SENDING' AND claim_token=?`)
          .bind(row.notice_key, config.campaignId, claim),
      ]);
      continue;
    }
    const result = await sendTelegramMessage(token, notice.chat_id, notice.body, notice.reply_message_id ?? undefined,
      notice.reply_markup ? JSON.parse(notice.reply_markup) as ReplyMarkup : undefined);
    await db.prepare(`UPDATE notices SET state=?,sent_message_id=?,last_error=?
      WHERE notice_key=? AND state='SENDING' AND claim_token=?`)
      .bind(result.state, result.state === "SENT" ? result.messageId : null, result.state === "SENT" ? null : result.error,
        row.notice_key, claim).run();
  }
}

/** Deterministic keys notify once per incident, including overlapping cron/webhook runs. */
export async function notifyOperators(db: D1Database, config: Config, now = Date.now()): Promise<void> {
  const [reports, reviews, membership, boundaries] = await db.batch<{ day: string; status: string; attempt_count: number; source_chat_id: number; message_id: number; version_date: number; chat_id: number; event_date: number }>([
    db.prepare(`SELECT day,status,attempt_count FROM daily_reports WHERE campaign_id=?
      AND status IN ('UNCERTAIN','FAILED_KNOWN') ORDER BY day LIMIT 30`).bind(config.campaignId),
    db.prepare(`SELECT source_chat_id,message_id,version_date FROM contributions WHERE campaign_id=?
      AND source_state='REVIEW' AND override_amount IS NULL ORDER BY updated_at LIMIT 30`).bind(config.campaignId),
    db.prepare(`SELECT chat_id,status,event_date FROM bot_membership m WHERE campaign_id=?
      AND (status IN ('left','kicked') OR can_send_messages=0)
      AND NOT EXISTS(SELECT 1 FROM operational_events e WHERE e.campaign_id=m.campaign_id
        AND e.kind='CHAT_MIGRATION' AND json_extract(e.detail,'$.oldId')=m.chat_id)
      ORDER BY updated_at LIMIT 30`).bind(config.campaignId),
    db.prepare(`SELECT a.chat_id FROM chat_aliases a WHERE a.campaign_id=?
      AND NOT EXISTS(SELECT 1 FROM automatic_intake_boundaries b WHERE b.campaign_id=a.campaign_id AND b.chat_id=a.chat_id)`)
      .bind(config.campaignId),
  ]);
  const incidents = [
    ...boundaries!.results.map(row => ({key:`boundary:${row.chat_id}`,body:`Не задана проверенная граница начала учёта для чата ${row.chat_id}. Новые вклады не подтверждаются; отчёты приостановлены. Оператору: docs/RUNBOOK.md, подготовить границу без изменения существующих накоплений.`})),
    ...reports!.results.map(row => ({ key: `report:${row.day}:${row.status}:${row.attempt_count}`,
      body: `Требуется проверка отчёта за ${row.day}: ${row.status}. Проверьте чат. Если публикация есть, используйте /report_sent ${row.day} <message_id> <причина>. Если её нет, после проверки используйте /report_retry ${row.day} <причина>.` })),
    ...reviews!.results.map(row => ({ key: `review:${row.source_chat_id}:${row.message_id}:${row.version_date}`,
      body: `Неоднозначные версии вклада ${row.source_chat_id}/${row.message_id}. До проверки вклад равен нулю. Проверьте /inspect ${row.source_chat_id} ${row.message_id} и укажите подтверждённое значение через /override с причиной.` })),
    ...membership!.results.map(row => ({ key: `membership:${row.chat_id}:${row.event_date}:${row.status}`,
      body: `Бот потерял доступ или право отправки в чате ${row.chat_id} (статус ${row.status}). Восстановите доступ и выполните сверку сообщений за период возможного пропуска.` })),
  ];
  const writes = incidents.flatMap(incident => config.adminIds.map(adminId =>
    db.prepare(`INSERT INTO notices(notice_key,campaign_id,chat_id,body,created_at)
      VALUES(?,?,?,?,?) ON CONFLICT(notice_key) DO NOTHING`)
      .bind(`alert:${adminId}:${incident.key}`, config.campaignId, adminId, incident.body, now)));
  if (writes.length) await db.batch(writes);
}


export async function handleAdmin(db: D1Database, config: Config, message: TelegramMessage, key: string, now: number): Promise<boolean> {
  if (message.chat.type !== "private" || !message.from || message.chat.id !== message.from.id || message.service || message.is_automatic_forward || (message.from.is_bot && !isTestSender(config, message, true))
    || !config.adminIds.includes(message.from.id) || message.sender_chat !== undefined
    || message.forward_origin !== undefined || message.forward_date !== undefined) return false;
  const actorId = message.from.id;
  const words = (message.text ?? "").trim().split(/\s+/);
  const command = words[0]?.split("@")[0] ?? "";
  if (["/silent", "/reconcile", "/report_sent", "/report_retry", "/notice_sent", "/notice_retry"].includes(command)) {
    const recovery = await db.prepare("SELECT restored_at FROM recovery_state WHERE campaign_id=?")
      .bind(config.campaignId).first<{ restored_at: number }>();
    if (recovery && message.date * 1000 <= recovery.restored_at) {
      await db.prepare(`INSERT INTO operational_events(event_key,campaign_id,kind,actor_id,source_chat_id,message_id,detail,created_at)
        VALUES(?,?,'STALE_RECOVERY_COMMAND',?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`)
        .bind(key, config.campaignId, actorId, message.chat.id, message.message_id,
          JSON.stringify({ command, commandDate: message.date, restoredAt: recovery.restored_at }), now).run();
      await enqueueNotice(db, config, `admin:${key}`, message.chat.id,
        "Команда отправлена до восстановления базы или в ту же секунду. Выполните проверку после восстановления и отправьте новую команду. Старые команды не разрешают повторную публикацию и не завершают сверку.", now, message.message_id);
      return true;
    }
  }
  const help = adminHelp(config);
  let reply = help;
  const chatId = Number(words[1]);
  const messageId = Number(words[2]);
  const validReference = /^-?[1-9][0-9]*$/.test(words[1] ?? "") && Number.isSafeInteger(chatId)
    && /^[1-9][0-9]*$/.test(words[2] ?? "") && Number.isSafeInteger(messageId);
  try {
    if (command === "/status") {
      const summary = await totals(db, config.campaignId);
      const recovery = await db.prepare("SELECT * FROM recovery_state WHERE campaign_id=?").bind(config.campaignId).first();
      const notices = await db.prepare("SELECT state,COUNT(*) AS count FROM notices WHERE campaign_id=? GROUP BY state").bind(config.campaignId).all();
      const membership = await db.prepare(`SELECT chat_id,status,event_date,can_send_messages FROM bot_membership m WHERE campaign_id=?
        AND NOT EXISTS(SELECT 1 FROM operational_events e WHERE e.campaign_id=m.campaign_id AND e.kind='CHAT_MIGRATION'
          AND json_extract(e.detail,'$.oldId')=m.chat_id)`).bind(config.campaignId).all();
      const [silence, heartbeat, problems] = await Promise.all([
        silenceState(db, config.campaignId),
        db.prepare("SELECT last_cron_at FROM system_heartbeat WHERE campaign_id=?").bind(config.campaignId).first<{last_cron_at:number|null}>(),
        db.prepare(`SELECT
          (SELECT COUNT(*) FROM daily_reports WHERE campaign_id=? AND status IN ('UNCERTAIN','FAILED_KNOWN')) reports,
          (SELECT COUNT(*) FROM contributions WHERE campaign_id=? AND source_state='REVIEW' AND override_amount IS NULL) reviews,
          (SELECT COUNT(*) FROM chat_aliases a WHERE a.campaign_id=? AND NOT EXISTS(SELECT 1 FROM automatic_intake_boundaries b
            WHERE b.campaign_id=a.campaign_id AND b.chat_id=a.chat_id)) missing_boundaries`)
          .bind(config.campaignId, config.campaignId, config.campaignId).first<{reports:number;reviews:number;missing_boundaries:number}>(),
      ]);
      const total = BigInt(summary.total), goal = BigInt(config.goal), percentage = total * 100000n / goal;
      const missingAccess = membership.results.some((r: any) => ["left","kicked"].includes(r.status) || r.can_send_messages === 0);
      const unresolved = notices.results.some((r: any) => ["UNCERTAIN","FAILED_KNOWN"].includes(r.state));
      const recoveryPending = recovery && (recovery as any).reconciled_at === null;
      reply = words[1] === "json" ? JSON.stringify({ summary, recovery, notices: notices.results, membership: membership.results }, null, 2)
        : `Состояние накопления\nНакоплено: ${number(total)} мантр\nОсталось: ${number(total >= goal ? 0n : goal-total)} мантр\nПрогресс: ${percentage/1000n},${String(percentage%1000n).padStart(3,"0")}%\nЗаписей: ${number(summary.messages)}; требуют проверки: ${problems?.reviews ?? 0}\nТишина /silent: ${silence.silent ? "включена" : "выключена"}\nПоследняя фоновая проверка: ${heartbeat?.last_cron_at ? Math.max(0, Math.floor((now-heartbeat.last_cron_at)/60000)) + " мин. назад" + (now-heartbeat.last_cron_at > 900000 ? " — ВНИМАНИЕ, нет свежей проверки" : "") : "ещё не зарегистрирована"}\nПроблемные отчёты: ${problems?.reports ?? 0}; уведомления: ${unresolved ? "есть, см. /notices" : "нет"}\nСверка после восстановления: ${recoveryPending ? "НЕ ЗАВЕРШЕНА, отчёты приостановлены" : "не требуется"}\nГраницы начала учёта: ${problems?.missing_boundaries ? "НЕ НАСТРОЕНЫ, приём новых вкладов и отчёты приостановлены" : "настроены"}\nДоступ к группе: ${missingAccess ? "ТРЕБУЕТ ПРОВЕРКИ" : "нет зарегистрированной потери доступа"}`;
    } else if (command === "/silent") {
      const action = words[1] ?? "on";
      if (!["on","off","status"].includes(action) || words.length > 2) reply = "Используйте /silent on, /silent off или /silent status.";
      else {
        const state = action === "status" ? await silenceState(db, config.campaignId)
          : await setSilence(db, config, action === "on", actorId, key, now,
            { sentAt: message.date * 1000, chatId: message.chat.id, messageId: message.message_id });
        if (action === "status") await db.prepare(`INSERT INTO operational_events(event_key,campaign_id,kind,actor_id,detail,created_at)
          VALUES(?,?,'SILENT_STATUS',?,'Read silence status',?) ON CONFLICT(event_key) DO NOTHING`).bind(key,config.campaignId,actorId,now).run();
        reply = `Тишина: ${state.silent ? "включена" : "выключена"}.\nПоследнее изменение: ${dateText(state.changed_at, config)}; ответственный: ${state.changed_by ?? "неизвестен"}.\nУчёт накоплений и личное управление продолжаются.\n${state.silent ? "Группа молчит. Уже разрешённый запрос в Telegram может завершиться." : "Новые публикации разрешены. Удержанные остаются на проверке: /reports, /notices; /report_retry или /notice_retry разрешает одну после проверки."}`;
      }
    } else if (command === "/inspect" && validReference) {
      const row = await inspect(db, chatId, messageId);
      reply = row && row.campaign_id === config.campaignId ? (words[3] === "json" ? JSON.stringify(row, null, 2) : inspectText(row, config)) : "Запись не найдена в этой кампании.";
    } else if ((command === "/override" || command === "/release") && validReference) {
      const amount = command === "/release" ? null : Number(words[3]);
      const reason = words.slice(command === "/release" ? 3 : 4).join(" ");
      if (!reason || reason.length > 1000 || (amount !== null && (!/^(0|[1-9][0-9]*)$/.test(words[3] ?? "")
        || !Number.isSafeInteger(amount) || amount > config.maxAmount))) {
        reply = "Нужны корректное целое число в допустимых пределах и причина до 1000 символов.";
      } else {
        const row = await inspect(db, chatId, messageId);
        if (!row || row.campaign_id !== config.campaignId) reply = "Запись не найдена в этой кампании.";
        else {
          const result = await adjust(db, config, { key, actorId, chatId, messageId, amount, reason, now });
          reply = `${command === "/release" ? "Административное значение снято" : "Коррекция сохранена"}: ${chatId}/${messageId}.\nБыло → стало: ${number(result.old_amount as number)} → ${number(result.new_amount as number)} мантр.\n${command === "/release" ? "Теперь действует последнее однозначное значение участника." : "Задано приоритетное административное значение; правки участника его не отменяют."}\nПричина: ${String(result.reason)}`;
        }
      }
    } else if (command === "/import" && validReference) {
      const amount = Number(words[3]);
      const dateMs = Date.parse(words[4] ?? "");
      const reason = words.slice(5).join(" ");
      if (!/^[1-9][0-9]*$/.test(words[3] ?? "") || !Number.isSafeInteger(amount) || amount > config.maxAmount
        || !Number.isFinite(dateMs) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(words[4] ?? "")
        || dateMs <= 0 || dateMs > now || !reason || reason.length > 1000) {
        reply = "Нужны допустимое положительное число, исходная ISO-дата с часовым поясом и источник/причина до 1000 символов.";
      } else {
        const alias = await db.prepare("SELECT chat_id FROM chat_aliases WHERE chat_id=? AND campaign_id=?").bind(chatId, config.campaignId).first();
        if (!alias) reply = "Исходный чат не входит в кампанию.";
        else {
          const result = await importContribution(db, config, { key, actorId, chatId, messageId, amount, originalDate: Math.floor(dateMs / 1000), reason, now });
          reply = `Исторический вклад сохранён: ${chatId}/${messageId}.\nБыло → стало: ${number(result.old_amount as number)} → ${number(result.new_amount as number)} мантр.\nИсточник и причина: ${String(result.reason)}`;
        }
      }
    } else if (command === "/reports") {
      const result = await db.prepare(`SELECT day,status,publication_hold,telegram_message_id,last_error FROM daily_reports
        WHERE campaign_id=? AND status<>'SENT' ORDER BY day LIMIT 20`).bind(config.campaignId).all();
      reply = result.results.length ? "Отчёты (до 20):\n" + result.results.map((r: any) => `${r.day}: ${stateText(r.status,r.publication_hold)}`).join("\n") + "\nПри UNCERTAIN проверьте чат: /report_sent ДЕНЬ ID ПРИЧИНА либо /report_retry ДЕНЬ ПРИЧИНА. Для удержанного отчёта — выключить /silent и разрешить один через /report_retry." : "Проблемных или ожидающих отчётов нет.";
    } else if (command === "/report_sent" || command === "/report_retry") {
      const day = words[1] ?? "";
      const sentId = command === "/report_sent" ? Number(words[2]) : undefined;
      const reason = words.slice(command === "/report_sent" ? 3 : 2).join(" ");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !reason || reason.length > 1000
        || (sentId !== undefined && (!Number.isSafeInteger(sentId) || sentId <= 0))) reply = "Нужны день, корректный ID публикации (для report_sent) и причина после ручной проверки чата.";
      else {
        const result = await resolveReport(db, config, { day, action: command === "/report_sent" ? "confirm_sent" : "retry", messageId: sentId, adminId: actorId, reason, idempotencyKey: key }, now);
        reply = result ? `Решение по отчёту за ${day} сохранено: ${sentId === undefined ? "разрешена одна отправка" : "подтверждена публикация " + sentId}. Причина: ${reason}` : "Нет изменения: проверьте /reports. Во время тишины повтор не разрешается; SENT и отправляющийся отчёт не повторяются.";
      }
    } else if (command === "/notices") {
      const result = await db.prepare(`SELECT notice_key,chat_id,state,publication_hold,last_error FROM notices WHERE campaign_id=?
        AND (state IN ('FAILED_KNOWN','UNCERTAIN') OR (publication_hold=1 AND state='PENDING')) ORDER BY created_at DESC LIMIT 10`).bind(config.campaignId).all();
      reply = result.results.length ? "Уведомления (до 10):\n" + result.results.map((r: any) => `${r.notice_key}: ${stateText(r.state,r.publication_hold)}`).join("\n") + "\nПри UNCERTAIN сначала проверить Telegram. /notice_sent КЛЮЧ ID ПРИЧИНА — найдено; /notice_retry КЛЮЧ ПРИЧИНА — разрешить одну отправку после проверки и выключения тишины." : "Проблемных уведомлений нет.";
    } else if (command === "/notice_sent" || command === "/notice_retry") {
      const noticeKey = words[1] ?? "";
      const sentId = command === "/notice_sent" ? Number(words[2]) : null;
      const reason = words.slice(command === "/notice_sent" ? 3 : 2).join(" ");
      if (!noticeKey || !reason || reason.length > 1000 || (sentId !== null && (!Number.isSafeInteger(sentId) || sentId <= 0))) reply = "Укажите ключ уведомления, ID публикации для notice_sent и причину решения.";
      else {
        const result = await db.batch([
          db.prepare(`UPDATE notices SET state=?,sent_message_id=?,resolved_by=?,resolved_at=?,resolution_reason=?,claim_token=NULL,publication_hold=0
            WHERE notice_key=? AND campaign_id=? AND (state IN ('FAILED_KNOWN','UNCERTAIN') OR (? IS NULL AND state='PENDING' AND publication_hold=1))
            AND (? IS NOT NULL OR chat_id>0 OR NOT EXISTS(SELECT 1 FROM campaign_controls WHERE campaign_id=? AND silent=1))
            AND NOT EXISTS(SELECT 1 FROM operational_events WHERE event_key=?) RETURNING state`)
            .bind(sentId === null ? "PENDING" : "SENT", sentId, actorId, now, reason, noticeKey, config.campaignId, sentId, sentId, config.campaignId, key),
          db.prepare(`INSERT INTO operational_events(event_key,campaign_id,kind,actor_id,source_chat_id,detail,created_at)
            VALUES(?,?,'NOTICE_RESOLUTION',?,?,?,?) ON CONFLICT(event_key) DO NOTHING`)
            .bind(key, config.campaignId, actorId, message.chat.id, JSON.stringify({ noticeKey, sentId, reason }), now),
        ]);
        reply = result[0]?.results.length ? "Решение по уведомлению сохранено." : "Нет изменения: уведомление не найдено, уже разрешено, команда повторяется или включена тишина. Проверьте /notices и /silent status.";
      }
    } else if (command === "/recovery" || command === "/reconcile") {
      const backupAt = command === "/recovery" ? Date.parse(words[1] ?? "") : null;
      const reason = words.slice(command === "/recovery" ? 2 : 1).join(" ");
      if (!reason || reason.length > 1000 || (backupAt !== null && (!Number.isFinite(backupAt) || backupAt <= 0 || backupAt > now
        || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(words[1] ?? "")))) reply = "Укажите ISO-дату копии с часовым поясом для recovery и причину до 1000 символов.";
      else {
        const mutation = backupAt === null
          ? db.prepare(`UPDATE recovery_state SET reconciled_at=?,reconciled_by=?,reason=? WHERE campaign_id=? AND reconciled_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM operational_events WHERE event_key=?)`).bind(now, actorId, reason, config.campaignId, key)
          : db.prepare(`INSERT INTO recovery_state(campaign_id,restored_at,backup_at,reason) SELECT ?,?,?,?
            WHERE NOT EXISTS(SELECT 1 FROM operational_events WHERE event_key=?)
            ON CONFLICT(campaign_id) DO UPDATE SET restored_at=excluded.restored_at,backup_at=excluded.backup_at,
              reason=excluded.reason,reconciled_at=NULL,reconciled_by=NULL`).bind(config.campaignId, now, backupAt, reason, key);
        const uncertainAfterRestore = backupAt === null ? [] : [
          db.prepare(`UPDATE daily_reports SET status='UNCERTAIN',last_error='Restored snapshot; inspect Telegram before retry',updated_at=?
            WHERE campaign_id=? AND status IN ('PENDING','SENDING','FAILED_KNOWN')
            AND NOT EXISTS(SELECT 1 FROM operational_events WHERE event_key=?)`).bind(now, config.campaignId, key),
          db.prepare(`UPDATE notices SET state='UNCERTAIN',last_error='Restored snapshot; inspect Telegram before retry'
            WHERE campaign_id=? AND state IN ('PENDING','SENDING','FAILED_KNOWN')
            AND NOT EXISTS(SELECT 1 FROM operational_events WHERE event_key=?)`).bind(config.campaignId, key),
        ];
        await db.batch([mutation, ...uncertainAfterRestore, db.prepare(`INSERT INTO operational_events(event_key,campaign_id,kind,actor_id,source_chat_id,detail,created_at)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`)
          .bind(key, config.campaignId, command === "/recovery" ? "RECOVERY_STARTED" : "RECOVERY_RECONCILED", actorId, message.chat.id, JSON.stringify({ backupAt, reason }), now)]);
        reply = backupAt === null ? "Результат сверки сохранён. Ожидающие отчёты будут обработаны по расписанию." : "Зафиксирован период возможной потери данных. Публикация отчётов приостановлена до /reconcile.";
      }
    } else if (command === "/export") {
      reply = "Для выгрузки ответственный оператор выполняет bun run backup в защищённом рабочем окружении. Архив содержит персональные идентификаторы; не публикуйте его в группе. Процедура и ключи описаны в инструкции эксплуатации.";
    } else if (!["/start", "/help"].includes(command)) {
      reply = `Команда или её аргументы не распознаны.\n\n${help}`;
    }
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    reply = command === "/import"
      ? "Импорт отклонён. Проверьте исходную дату, разрешённый чат и наличие записи через /inspect. Уже учтённые сообщения исправляются через /override."
      : "Коррекция отклонена. Проверьте запись через /inspect. Неоднозначную исходную версию нельзя восстановить через /release; укажите проверенное число через /override.";
  }
  await enqueueNotice(db, config, `admin:${key}`, message.chat.id, reply, now, message.message_id);
  return true;
}
