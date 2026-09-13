import { RotateCcw } from "lucide-react";
import { useStore } from "../store";
import { errorTitle } from "../errors";
import { Button, Notice } from "./ui";

/** App-level notices shown above the conversation. */
export function Banners() {
  const announcement = useStore((s) => s.config?.config.announcement);
  const storage = useStore((s) => s.auth?.storage);
  const modelsStatus = useStore((s) => s.modelsStatus);
  const modelsError = useStore((s) => s.modelsError);
  const modelCount = useStore((s) => s.models.length);
  const loadModels = useStore((s) => s.loadModels);
  const dismissed = useStore((s) => s.dismissed);
  const dismiss = useStore((s) => s.dismiss);

  const announcementId = `announcement:${announcement}`;
  const notices = [];

  if (modelsStatus === "error" && modelsError) {
    notices.push(
      <Notice
        key="models"
        tone="error"
        title={errorTitle(modelsError)}
        details={modelsError.message}
        actions={
          <Button onClick={() => void loadModels()}>
            <RotateCcw size={14} />
            Try again
          </Button>
        }
      />,
    );
  } else if (modelsStatus === "ok" && modelCount === 0) {
    notices.push(
      <Notice
        key="no-models"
        tone="warn"
        title="Your key doesn't have access to any models. Ask your administrator to check it."
        actions={<Button onClick={() => void loadModels()}>Check again</Button>}
      />,
    );
  }
  if (announcement && !dismissed[announcementId]) {
    notices.push(
      <Notice key="announcement" tone="info" title={announcement} onDismiss={() => dismiss(announcementId)} />,
    );
  }
  if (storage === "file" && !dismissed.storage) {
    notices.push(
      <Notice
        key="storage"
        tone="warn"
        title="No system keychain was found, so your key is saved in a private file in Alpha's data folder."
        onDismiss={() => dismiss("storage")}
      />,
    );
  }

  return notices.length ? <div className="mb-4 space-y-2">{notices}</div> : null;
}
