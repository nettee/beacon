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
  observabilityFeedback: Array<{
    priority: "high" | "medium" | "low";
    summary: string;
  }> | null;
};

export type ProfileListItem = {
  id: string;
  playbook: string;
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

export type ProfileSkillsView = {
  mode: "explicit";
  paths: string[];
};

export type ProfileDetailView = {
  id: string;
  playbook: string;
  runtime: "pi";
  model: { provider: string; id: string };
  admin: { chatId: string } | null;
  schedules: ProfileScheduleView[];
  listener: ProfileListenerView | null;
  /** Present when profile.yaml declares `skills`; omit/null = Pi default discovery. */
  skills: ProfileSkillsView | null;
  secrets: { present: false; note: string };
};
