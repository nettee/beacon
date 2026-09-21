import { useEffect, useId, useRef, useState } from "react";

type HeaderFilterProps = {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
};

export function HeaderFilter({
  label,
  options,
  selected,
  onChange,
}: HeaderFilterProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const active = selected.length > 0;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((item) => item !== value));
      return;
    }
    onChange([...selected, value]);
  };

  return (
    <div ref={rootRef} className="relative inline-flex items-center">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[11px] font-semibold tracking-wide uppercase ${
          active
            ? "bg-sky-100 text-sky-800"
            : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
        }`}
      >
        {label}
        <svg
          viewBox="0 0 16 16"
          className="h-3 w-3 opacity-80"
          aria-hidden="true"
        >
          <path fill="currentColor" d="M3 4h10L9.5 9.2V13l-3 1.5V9.2z" />
        </svg>
        {active ? (
          <span className="rounded bg-sky-200 px-1 text-[10px] normal-case tracking-normal text-sky-900">
            {selected.length}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          className="absolute top-full left-0 z-30 mt-1 max-h-72 min-w-52 overflow-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-xl"
        >
          <div className="flex items-center justify-between px-2 py-1 text-[11px] text-zinc-500">
            <span>Multi-select</span>
            <button
              type="button"
              className="text-sky-700 hover:text-sky-900"
              onClick={() => onChange([])}
            >
              Clear
            </button>
          </div>
          {options.length === 0 ? (
            <p className="px-3 py-2 text-xs text-zinc-500">No values</p>
          ) : (
            options.map((option) => {
              const checked = selected.includes(option);
              return (
                <label
                  key={option}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-zinc-800 hover:bg-zinc-50"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(option)}
                    className="rounded border-zinc-300 bg-white text-sky-600"
                  />
                  <span className="truncate font-mono text-xs">{option}</span>
                </label>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
