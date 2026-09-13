import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton } from "./ui";

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Some Linux webviews don't expose the async clipboard API.
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    el.remove();
  }
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <IconButton
      label={copied ? "Copied" : label}
      onClick={() => void copyText(text).then(() => setCopied(true))}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </IconButton>
  );
}
