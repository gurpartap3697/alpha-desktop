import { useEffect, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { X } from "lucide-react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export type Variant = "primary" | "outline" | "quiet" | "danger" | "danger-outline";

const variants: Record<Variant, string> = {
  primary: "bg-river text-ground hover:brightness-110 disabled:brightness-100",
  danger: "bg-brick text-ground hover:brightness-110 disabled:brightness-100",
  "danger-outline": "border border-brick/50 text-brick hover:bg-brick-soft",
  outline: "border border-line text-ink hover:bg-river-soft",
  quiet: "text-ink-2 hover:bg-river-soft hover:text-ink",
};

export function Button({
  variant = "outline",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-[7px] px-3 text-[13px] font-medium whitespace-nowrap",
        "transition-colors disabled:cursor-default disabled:opacity-50",
        variants[variant],
        className,
      )}
    />
  );
}

export function IconButton({
  label,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cx(
        "inline-flex size-8 items-center justify-center rounded-[7px] text-ink-3 transition-colors",
        "hover:bg-river-soft hover:text-ink disabled:opacity-40",
        className,
      )}
    />
  );
}

type Tone = "error" | "warn" | "info";

const tones: Record<Tone, string> = {
  error: "bg-brick-soft text-ink [--tone:var(--brick)]",
  warn: "bg-amber-soft text-ink [--tone:var(--amber)]",
  info: "bg-river-soft text-ink [--tone:var(--river)]",
};

/** A message with optional details and actions. Used for banners and for errors under an answer. */
export function Notice({
  tone,
  title,
  details,
  actions,
  onDismiss,
  className,
}: {
  tone: Tone;
  title: ReactNode;
  details?: string;
  actions?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx("flex items-start gap-3 rounded-lg border-l-[3px] border-(--tone) py-2.5 pr-2 pl-3.5", tones[tone], className)}
    >
      <div className="min-w-0 flex-1 leading-5">
        <div>{title}</div>
        {details && (
          <details className="mt-1 text-xs text-ink-2">
            <summary className="cursor-pointer select-none">Details</summary>
            <p className="mt-1 font-mono break-words whitespace-pre-wrap">{details}</p>
          </details>
        )}
        {actions && <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
      </div>
      {onDismiss && (
        <IconButton label="Dismiss" onClick={onDismiss} className="-my-1 size-7">
          <X size={14} />
        </IconButton>
      )}
    </div>
  );
}

/** Render children only after a short wait, so fast loads don't flash a loading state. */
export function Delayed({ ms = 250, children }: { ms?: number; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return shown ? <>{children}</> : null;
}

/** A placeholder bar for content that is loading. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden style={style} className={cx("animate-pulse rounded-[5px] bg-line/70", className)} />;
}

export function Kbd({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-line bg-ground px-1 font-sans text-[11px] text-ink-2"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

export { cx };
