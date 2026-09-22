import type { FeedbackItem, FeedbackRecord } from "../domain/types.js";

export type HtmlFeedbackView =
  | { status: "hidden" }
  | { status: "missing" }
  | { status: "empty" }
  | { status: "items"; items: FeedbackItem[] };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function htmlFeedbackView(
  feedback: FeedbackRecord | null | undefined,
): HtmlFeedbackView {
  if (feedback === undefined) return { status: "hidden" };
  if (feedback === null) return { status: "missing" };
  if (feedback.items.length === 0) return { status: "empty" };
  return { status: "items", items: feedback.items };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const sessionDataScript =
  /<script\s+id="session-data"(?:\s+[^>]*)?>([A-Za-z0-9+/=\s]*)<\/script>/i;

function rewriteSessionData(
  html: string,
  mutate: (data: Record<string, unknown>) => boolean,
): string {
  const match = sessionDataScript.exec(html);
  if (!match || match.index === undefined) return html;
  const raw = match[1] ?? "";
  const encoded = raw.replace(/\s+/g, "");
  if (encoded.length === 0) return html;

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    );
    const record = asRecord(parsed);
    if (!record) return html;
    data = record;
  } catch {
    return html;
  }

  if (!mutate(data)) return html;
  const next = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  return (
    html.slice(0, match.index) +
    match[0].replace(raw, next) +
    html.slice(match.index + match[0].length)
  );
}

function feedbackPayload(
  view: Exclude<HtmlFeedbackView, { status: "hidden" }>,
): {
  status: "missing" | "empty" | "items";
  items?: FeedbackItem[];
} {
  if (view.status === "items") {
    return { status: "items", items: view.items };
  }
  return { status: view.status };
}

export function renderFeedbackMarkup(
  view: Exclude<HtmlFeedbackView, { status: "hidden" }>,
): string {
  const itemsHtml =
    view.status === "items"
      ? view.items
          .map(
            (item) =>
              `<div class="beacon-feedback-item" data-priority="${escapeHtml(item.priority)}" data-category="${escapeHtml(item.category)}"><span class="beacon-feedback-priority">${escapeHtml(item.priority)}</span><span class="beacon-feedback-category">${escapeHtml(item.category)}</span><span class="beacon-feedback-summary">${escapeHtml(item.summary)}</span></div>`,
          )
          .join("")
      : "";
  const body =
    view.status === "missing"
      ? `<div class="beacon-feedback-empty">未提交</div>`
      : view.status === "empty"
        ? `<div class="beacon-feedback-empty">无问题</div>`
        : itemsHtml;
  return `<div id="beacon-feedback" class="beacon-feedback" data-beacon-feedback="${escapeHtml(view.status)}"><div class="beacon-feedback-header">Feedback</div>${body}</div>`;
}

const feedbackStyle = `<style id="beacon-feedback-style">
.beacon-feedback {
  background: var(--customMessageBg, #2b2438);
  padding: var(--line-height, 1em);
  border-radius: 4px;
  margin: 0 16px 16px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}
.beacon-feedback-header {
  font-weight: 700;
  color: var(--customMessageLabel, #c4b5fd);
  margin-bottom: 8px;
}
.beacon-feedback-empty {
  color: var(--customMessageText, #ddd6fe);
}
.beacon-feedback-item {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 8px;
  align-items: start;
  color: var(--customMessageText, #e5e7eb);
  margin-top: 8px;
}
.beacon-feedback-priority,
.beacon-feedback-category {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
}
.beacon-feedback-priority { text-transform: uppercase; letter-spacing: 0.04em; }
.beacon-feedback-item[data-priority="high"] .beacon-feedback-priority {
  background: #7f1d1d;
  color: #fecaca;
}
.beacon-feedback-item[data-priority="medium"] .beacon-feedback-priority {
  background: #78350f;
  color: #fde68a;
}
.beacon-feedback-category {
  background: #1e293b;
  color: #cbd5e1;
}
.beacon-feedback-summary { white-space: pre-wrap; word-break: break-word; }
</style>`;

const feedbackBoot = `<script id="beacon-feedback-boot">
(function () {
  function place() {
    var node = document.getElementById("beacon-feedback");
    if (!node) return;
    var after = document.querySelector(".system-prompt")
      || document.querySelector(".header-info")
      || document.querySelector(".header");
    if (!after || !after.parentNode) return;
    if (node.previousElementSibling === after) return;
    after.parentNode.insertBefore(node, after.nextSibling);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", place);
  } else {
    place();
  }
  new MutationObserver(place).observe(document.documentElement, { childList: true, subtree: true });
})();
</script>`;

function injectFeedbackChrome(html: string, markup: string): string {
  if (html.includes('id="beacon-feedback"')) return html;
  const block = `${feedbackStyle}\n${markup}\n${feedbackBoot}`;
  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  if (bodyOpen && bodyOpen.index !== undefined) {
    const insertAt = bodyOpen.index + bodyOpen[0].length;
    return html.slice(0, insertAt) + block + html.slice(insertAt);
  }
  const session = sessionDataScript.exec(html);
  if (session && session.index !== undefined) {
    const insertAt = session.index + session[0].length;
    return html.slice(0, insertAt) + block + html.slice(insertAt);
  }
  return html + block;
}

export function fillExportedHtmlFeedback(
  html: string,
  feedback: FeedbackRecord | null | undefined,
): string {
  const view = htmlFeedbackView(feedback);
  if (view.status === "hidden") return html;
  const payload = feedbackPayload(view);
  const withData = rewriteSessionData(html, (data) => {
    if (data.beaconFeedback !== undefined) return false;
    data.beaconFeedback = payload;
    return true;
  });
  return injectFeedbackChrome(withData, renderFeedbackMarkup(view));
}
