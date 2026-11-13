export interface Env {
  TEST_INPUT_DIAGNOSTICS?: string;
  TEST_SENDER_BOT_ID?: string;
  TEST_SENDER_CHAT_ID?: string;
  DB: D1Database;
  DEPLOYMENT_ENV: string;
  EXPECTED_D1_ID: string;
  EXPECTED_BOT_ID: string;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_IDS: string;
  CAMPAIGN_ID: string;
  TIMEZONE: string;
  CAMPAIGN_START: string;
  REPORT_TIME: string;
  GOAL: string;
  MAX_AMOUNT: string;
  ALLOWED_CHAT_IDS: string;
  REPORT_CHAT_ID: string;
}

export interface Config {
  testSender?: { botId: number; chatId: number };
  deployment?: { environment?: "test" | "production"; databaseId: string; botId: number; sourceChatIds: string; reportChatId: number };
  campaignId: string;
  timezone: string;
  startDay: string;
  reportTime: string;
  goal: number;
  maxAmount: number;
  allowedChatIds: number[];
  adminIds: number[];
  reportChatId: number;
}

export interface ContributionEvent {
  key: string;
  updateId: number;
  chatId: number;
  messageId: number;
  userId: number | null;
  originalDate: number;
  versionDate: number;
  isEdit: boolean;
  amount: number;
  state: "VALID" | "INVALID";
  reason: string | null;
  now: number;
}

export interface Contribution {
  source_chat_id: number;
  message_id: number;
  campaign_id: string;
  original_date: number;
  local_day: string;
  user_id: number | null;
  source_amount: number;
  source_state: "VALID" | "INVALID" | "REVIEW";
  version_date: number;
  is_edit: number;
  override_amount: number | null;
  effective_amount: number;
  last_event_key: string;
  updated_at: number;
}
