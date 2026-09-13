// Fields shared by a chat's own settings and the defaults for new chats in Settings.

import { useId } from "react";

const input = "rounded-[7px] border border-line bg-ground placeholder:text-ink-3 focus:border-river focus:outline-none";

export function SystemPromptField({
  value,
  onChange,
  help,
  rows = 4,
}: {
  value: string;
  onChange: (value: string) => void;
  help: string;
  rows?: number;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="font-medium">
        System prompt
      </label>
      <p className="mt-0.5 text-ink-2">{help}</p>
      <textarea
        id={id}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="For example: Answer briefly and cite sources."
        className={`${input} mt-2 w-full resize-y px-2.5 py-2 leading-5`}
      />
    </div>
  );
}

/** `null` = the model's default, shown as `fallback`. */
export function TemperatureField({
  value,
  fallback,
  onChange,
}: {
  value: number | null;
  fallback: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const shown = value ?? fallback;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="font-medium">
          Temperature
        </label>
        <span className="text-ink-2 tabular-nums">{value === null ? `Model default (${fallback.toFixed(2)})` : shown.toFixed(2)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={shown}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-(--river)"
      />
      <div className="flex justify-between text-xs text-ink-3">
        <span>Focused</span>
        <span>Varied</span>
      </div>
    </div>
  );
}

/** `null` = the model's default. */
export function MaxTokensField({
  value,
  placeholder,
  limit,
  onChange,
}: {
  value: number | null;
  placeholder: string;
  limit?: number;
  onChange: (value: number | null) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="font-medium">
        Maximum answer length
      </label>
      <p className="mt-0.5 text-ink-2">In tokens. A token is about three quarters of a word.</p>
      <input
        id={id}
        type="number"
        min={1}
        max={limit}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => {
          const n = Math.floor(Number(e.target.value));
          onChange(e.target.value === "" || !(n > 0) ? null : Math.min(n, limit ?? n));
        }}
        className={`${input} mt-2 h-8 w-40 px-2.5 tabular-nums`}
      />
    </div>
  );
}
