type ImportMetaWithEnv = ImportMeta & {
  readonly env?: {
    readonly DEV?: boolean;
    readonly PROD?: boolean;
  };
};

let didScheduleRegistration = false;

export function registerServiceWorker(): void {
  if (didScheduleRegistration) {
    return;
  }

  const metaEnv = (import.meta as ImportMetaWithEnv).env;
  if (metaEnv?.DEV) {
    return;
  }

  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return;
  }

  if (!("serviceWorker" in navigator) || !navigator.serviceWorker) {
    return;
  }

  didScheduleRegistration = true;

  const register = () => {
    try {
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch(() => undefined);
    } catch {
      return;
    }
  };

  if (typeof document === "undefined" || document.readyState === "complete") {
    register();
    return;
  }

  if (typeof window.addEventListener === "function") {
    window.addEventListener("load", register, { once: true });
  }
}

export default registerServiceWorker;
