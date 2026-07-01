"use client";

import { useEffect, useRef, useState } from "react";
import { ImportByUrlForm } from "./import-by-url-form";
import { ImportByFileForm } from "./import-by-file-form";
import { ImportManualForm } from "./import-manual-form";

type Tab = "url" | "file" | "manual";
const TABS: { id: Tab; label: string }[] = [
  { id: "url", label: "URL" },
  { id: "file", label: "File" },
  { id: "manual", label: "Manual" },
];

export function AddCredentialDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("url");
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstTabRef = useRef<HTMLButtonElement>(null);

  // Move focus into the dialog on mount, onto the FIRST TAB (the first meaningful control) rather
  // than whatever happens to be first in DOM order — landing on a bare "✕" close icon is an
  // accessibility smell. The tablist is rendered before the close button in DOM order too, so even
  // a generic first-focusable heuristic would not grab the dismiss control.
  useEffect(() => {
    (firstTabRef.current ??
      dialogRef.current?.querySelector<HTMLElement>(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
      ))?.focus();
  }, []);

  // Escape to close, and Tab/Shift+Tab focus trapping so keyboard focus can't escape the modal
  // into the page behind it (WCAG 2.1.2 / AA modal-dialog requirement).
  useEffect(() => {
    function isVisible(el: HTMLElement): boolean {
      // Note: deliberately not using `offsetParent` here — jsdom (our test environment) never
      // computes layout, so `offsetParent` is always null there and would wrongly exclude every
      // element. Checking `hidden` + inline display/visibility catches the cases this dialog
      // actually produces (conditionally-rendered tab panels use JS `? :`, not CSS hiding), and
      // works identically in jsdom and real browsers.
      if (el.hidden) return false;
      const style = el.style;
      if (style.display === "none" || style.visibility === "hidden") return false;
      return true;
    }

    function getFocusable(): HTMLElement[] {
      const container = dialogRef.current;
      if (!container) return [];
      const nodes = container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]'
      );
      // Exclude anything explicitly taken out of the natural Tab order (tabIndex === -1) — the
      // tablist's inactive tabs use this roving-tabindex pattern intentionally.
      return Array.from(nodes).filter((el) => el.tabIndex !== -1 && isVisible(el));
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const activeIndex = active ? focusable.indexOf(active) : -1;

      if (e.shiftKey) {
        if (activeIndex <= 0) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (activeIndex === -1 || activeIndex === focusable.length - 1) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onTabKey(e: React.KeyboardEvent, index: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = (index + dir + TABS.length) % TABS.length;
    setTab(TABS[next].id);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-cred-title"
        className="w-full max-w-md rounded-t-xl bg-white p-5 shadow-xl sm:rounded-xl"
      >
        <h2 id="add-cred-title" className="mb-4 font-heading text-lg font-semibold">
          Add credential
        </h2>

        {/* Tablist BEFORE the close button in DOM order, so focus/tab order reaches a meaningful
            control (a tab) before the dismiss "✕". */}
        <div role="tablist" aria-label="Import method" className="mb-4 flex gap-1">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              ref={i === 0 ? firstTabRef : undefined}
              role="tab"
              type="button"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => onTabKey(e, i)}
              className={
                "min-h-11 flex-1 rounded-md px-3 text-sm font-medium " +
                (tab === t.id
                  ? "bg-primary text-white"
                  : "bg-foreground/5 text-foreground hover:bg-foreground/10")
              }
            >
              {t.label}
            </button>
          ))}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-11 min-w-11 shrink-0 rounded-md text-foreground/60 hover:bg-foreground/5"
          >
            ✕
          </button>
        </div>

        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === "url" ? <ImportByUrlForm /> : null}
          {tab === "file" ? <ImportByFileForm /> : null}
          {tab === "manual" ? <ImportManualForm /> : null}
        </div>
      </div>
    </div>
  );
}
