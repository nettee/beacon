export type RunRow = {
  profileId: string;
  acceptedAt: string;
  kind: string;
  scheduleId: string | null;
  kindLabel: string;
  runId: string | null;
  state: string | null;
  failureCode: string | null;
  deliveryState: string | null;
  hasSessionFile: boolean;
  feedback: Array<{ priority: "high" | "medium"; summary: string }> | null;
};

export type ProfileListItem = {
  id: string;
  workspace: string;
  runtime: "pi";
  model: { provider: string; id: string };
  scheduleCount: number;
  hasAdmin: boolean;
  hasListener: boolean;
  error: string | null;
};

export type ProfileNotifyView =
  | { kind: "channel"; name: string; description?: string }
  | { kind: "chat_id"; chatId: string };

export type ProfileScheduleView = {
  id: string;
  cron: string;
  timezone: string;
  input: string;
  notify: ProfileNotifyView | null;
};

export type ProfileListenerView = {
  sources: string[];
  types: string[];
  notify: ProfileNotifyView | null;
};

export type ProfileDetailView = {
  id: string;
  workspace: string;
  runtime: "pi";
  model: { provider: string; id: string };
  admin: { chatId: string } | null;
  schedules: ProfileScheduleView[];
  listener: ProfileListenerView | null;
  secrets: { present: false; note: string };
};
