// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * In-Page HUD Toast Notification System.
 *
 * Renders non-intrusive, accessible toast alerts inside an isolated Shadow DOM
 * (mode: "closed") to prevent style clashes with host pages.
 *
 * Invariants:
 * - Local-First Zero Egress: never accepts or renders unmasked sensitive text.
 * - Non-blocking: host page interaction remains unaffected (pointer-events: none on host).
 * - Fully accessible: supports screen-reader announcements, keyboard dismissal, and hover-pause.
 */

export type ToastLevel = "info" | "success" | "warning" | "danger";

export interface ToastOptions {
  title: string;
  message: string;
  level?: ToastLevel;
  durationMs?: number;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}

const TOAST_HOST_ATTR = "data-gw-toast-host";

const LEVEL_COLORS: Record<ToastLevel, { border: string; badge: string; bg: string }> = {
  info: { border: "#3b82f6", badge: "#2563eb", bg: "rgba(59, 130, 246, 0.12)" },
  success: { border: "#10b981", badge: "#059669", bg: "rgba(16, 185, 129, 0.12)" },
  warning: { border: "#f59e0b", badge: "#d97706", bg: "rgba(245, 158, 11, 0.12)" },
  danger: { border: "#ef4444", badge: "#dc2626", bg: "rgba(239, 68, 68, 0.12)" },
};

const LEVEL_ICONS: Record<ToastLevel, string> = {
  info: "🛡️",
  success: "✓",
  warning: "⚠️",
  danger: "🛑",
};

const TOAST_STYLES = `
  :host {
    all: initial;
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 2147483647;
    pointer-events: none;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }

  .gw-toast-container {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 380px;
    min-width: 300px;
    pointer-events: none;
  }

  .gw-toast {
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    background: #0f172a;
    color: #f8fafc;
    border-radius: 10px;
    border: 1px solid #334155;
    border-left-width: 4px;
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
    padding: 12px 14px;
    box-sizing: border-box;
    opacity: 0;
    transform: translateX(30px);
    transition: opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1), transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .gw-toast--visible {
    opacity: 1;
    transform: translateX(0);
  }

  .gw-toast--removing {
    opacity: 0;
    transform: translateY(-10px) scale(0.96);
  }

  .gw-toast-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .gw-toast-icon {
    font-size: 14px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .gw-toast-title {
    font-size: 13px;
    font-weight: 600;
    color: #f8fafc;
    margin: 0;
    flex: 1;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .gw-toast-close {
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
    margin: -2px 0 0 0;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .gw-toast-close:hover,
  .gw-toast-close:focus {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.1);
    outline: none;
  }

  .gw-toast-body {
    font-size: 12px;
    color: #cbd5e1;
    line-height: 1.4;
    margin: 0 0 6px 28px;
    word-break: break-word;
  }

  .gw-toast-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
    margin-left: 28px;
  }

  .gw-toast-btn {
    background: #1e293b;
    border: 1px solid #475569;
    color: #f8fafc;
    font-size: 11px;
    font-weight: 600;
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }

  .gw-toast-btn:hover {
    background: #334155;
    border-color: #64748b;
  }

  .gw-toast-btn--primary {
    background: #2563eb;
    border-color: #3b82f6;
  }

  .gw-toast-btn--primary:hover {
    background: #1d4ed8;
  }
`;

class ToastManager {
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private container: HTMLElement | null = null;

  private ensureMounted(): HTMLElement {
    if (this.container && this.host && this.host.isConnected) {
      return this.container;
    }

    const doc = document;
    let existingHost = doc.querySelector(`div[${TOAST_HOST_ATTR}]`) as HTMLElement | null;
    if (!existingHost) {
      existingHost = doc.createElement("div");
      existingHost.setAttribute(TOAST_HOST_ATTR, "");
      (doc.body || doc.documentElement).appendChild(existingHost);
    }
    this.host = existingHost;

    if (!this.shadow) {
      this.shadow = this.host.attachShadow({ mode: "closed" });
      const styleEl = doc.createElement("style");
      styleEl.textContent = TOAST_STYLES;
      this.shadow.appendChild(styleEl);
    }

    if (!this.container) {
      this.container = doc.createElement("div");
      this.container.className = "gw-toast-container";
      this.container.setAttribute("role", "region");
      this.container.setAttribute("aria-label", "GovernWorld notifications");
      this.shadow.appendChild(this.container);
    }

    return this.container;
  }

  public show(options: ToastOptions): () => void {
    try {
      const container = this.ensureMounted();
      const level = options.level ?? "info";
      const colors = LEVEL_COLORS[level];
      const icon = LEVEL_ICONS[level];
      const duration = options.durationMs ?? 4500;

      const toast = document.createElement("div");
      toast.className = "gw-toast";
      toast.style.borderLeftColor = colors.border;
      toast.setAttribute("role", level === "danger" || level === "warning" ? "alert" : "status");
      toast.setAttribute("aria-live", level === "danger" ? "assertive" : "polite");

      // Header
      const header = document.createElement("div");
      header.className = "gw-toast-header";

      const iconEl = document.createElement("span");
      iconEl.className = "gw-toast-icon";
      iconEl.style.backgroundColor = colors.bg;
      iconEl.style.color = colors.badge;
      iconEl.textContent = icon;
      header.appendChild(iconEl);

      const titleEl = document.createElement("h4");
      titleEl.className = "gw-toast-title";
      titleEl.textContent = options.title;
      header.appendChild(titleEl);

      const closeBtn = document.createElement("button");
      closeBtn.className = "gw-toast-close";
      closeBtn.type = "button";
      closeBtn.setAttribute("aria-label", "Dismiss notification");
      closeBtn.textContent = "\u00d7";
      header.appendChild(closeBtn);

      toast.appendChild(header);

      // Body
      const body = document.createElement("div");
      body.className = "gw-toast-body";
      body.textContent = options.message;
      toast.appendChild(body);

      // Optional action button
      if (options.actionLabel) {
        const actions = document.createElement("div");
        actions.className = "gw-toast-actions";

        const actionBtn = document.createElement("button");
        actionBtn.className = "gw-toast-btn gw-toast-btn--primary";
        actionBtn.type = "button";
        actionBtn.textContent = options.actionLabel;
        actionBtn.addEventListener("click", () => {
          options.onAction?.();
          dismiss();
        });
        actions.appendChild(actionBtn);
        toast.appendChild(actions);
      }

      container.appendChild(toast);

      // Animation entrance
      requestAnimationFrame(() => {
        toast.classList.add("gw-toast--visible");
      });

      let timer: ReturnType<typeof setTimeout> | null = null;
      let remainingMs = duration;
      let startTime = Date.now();

      const startTimer = (ms: number) => {
        startTime = Date.now();
        timer = setTimeout(() => {
          dismiss();
        }, ms);
      };

      const pauseTimer = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
          remainingMs -= Date.now() - startTime;
        }
      };

      const resumeTimer = () => {
        if (!timer && remainingMs > 0) {
          startTimer(remainingMs);
        }
      };

      toast.addEventListener("mouseenter", pauseTimer);
      toast.addEventListener("mouseleave", resumeTimer);

      const dismiss = () => {
        if (timer) clearTimeout(timer);
        toast.removeEventListener("mouseenter", pauseTimer);
        toast.removeEventListener("mouseleave", resumeTimer);
        toast.classList.remove("gw-toast--visible");
        toast.classList.add("gw-toast--removing");
        setTimeout(() => {
          toast.remove();
          options.onDismiss?.();
          if (container.children.length === 0 && this.host) {
            this.host.remove();
            this.host = null;
            this.shadow = null;
            this.container = null;
          }
        }, 220);
      };

      closeBtn.addEventListener("click", dismiss);

      if (duration > 0) {
        startTimer(duration);
      }

      return dismiss;
    } catch {
      // Fail closed: a toast fault must never disrupt page execution
      return () => undefined;
    }
  }
}

export const toastManager = new ToastManager();

export function showToast(options: ToastOptions): () => void {
  return toastManager.show(options);
}
