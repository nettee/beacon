import { type MouseEvent, useState } from "react";

export type CopyableFeedback = {
  priority: string;
  summary: string;
  kindLabel: string;
  profileId: string;
  runId: string | null;
  acceptedAt: string;
};

export function formatFeedbackCopy(
  item: CopyableFeedback,
  formatTime: (value: string) => string,
): string {
  return [
    `[${item.priority.toUpperCase()}] ${item.summary}`,
    `Kind: ${item.kindLabel}`,
    `Profile: ${item.profileId}`,
    `Run: ${item.runId ?? "(none)"}`,
    `Time: ${formatTime(item.acceptedAt)}`,
  ].join("\n");
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  document.body.removeChild(area);
}

type CopyFeedbackButtonProps = {
  text: string;
  className?: string;
};

export function CopyFeedbackButton({
  text,
  className = "",
}: CopyFeedbackButtonProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await writeClipboard(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={(event) => {
        void onCopy(event);
      }}
      className={`shrink-0 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 ${className}`}
      aria-label="Copy feedback"
      title="Copy feedback"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
