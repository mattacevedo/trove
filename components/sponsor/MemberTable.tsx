"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

export interface MemberRow {
  handle: string | null;
  status: string;
  consentSkills: boolean;
  consentCredentials: boolean;
  joinedAt: string;
}

type SortKey = "handle" | "status" | "consentSkills" | "consentCredentials" | "joinedAt";

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "handle", label: "Member" },
  { key: "status", label: "Status" },
  { key: "consentSkills", label: "Skills shared" },
  { key: "consentCredentials", label: "Credentials shared" },
  { key: "joinedAt", label: "Joined" },
];

function formatJoined(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function compare(a: MemberRow, b: MemberRow, key: SortKey): number {
  const av = a[key];
  const bv = b[key];
  if (typeof av === "boolean" && typeof bv === "boolean") {
    return av === bv ? 0 : av ? -1 : 1;
  }
  return String(av ?? "").localeCompare(String(bv ?? ""));
}

export function MemberTable({ rows }: { rows: MemberRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("joinedAt");
  const [asc, setAsc] = useState(false);

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-foreground/20 p-6 text-center text-sm text-foreground/60">
        No members yet. Invite your cohort to get started.
      </p>
    );
  }

  const sorted = [...rows].sort((a, b) => {
    const c = compare(a, b, sortKey);
    return asc ? c : -c;
  });

  function toggle(key: SortKey) {
    if (key === sortKey) {
      setAsc((v) => !v);
    } else {
      setSortKey(key);
      setAsc(true);
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" aria-label="Cohort members">
        <thead>
          <tr className="border-b border-foreground/15 text-left">
            {COLUMNS.map((col) => {
              const active = col.key === sortKey;
              const dir = active ? (asc ? "ascending" : "descending") : "none";
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={dir}
                  className="p-0 font-medium"
                >
                  <button
                    type="button"
                    onClick={() => toggle(col.key)}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-1 px-3 text-left text-foreground",
                      "hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
                    )}
                  >
                    {col.label}
                    {/* Sort direction is conveyed to assistive tech via aria-sort on the <th>,
                        not via this glyph — rendered as a CSS background image (not a text node)
                        so it never leaks into the header's accessible/text content. */}
                    <span
                      aria-hidden="true"
                      className="h-3 w-3 shrink-0 bg-contain bg-center bg-no-repeat opacity-50"
                      style={{
                        backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(
                          active
                            ? asc
                              ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 3l5 6H3z" fill="black"/></svg>'
                              : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 13l5-6H3z" fill="black"/></svg>'
                            : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 2l4 4H4zm0 12l-4-4h8z" fill="black"/></svg>'
                        )}")`,
                      }}
                    />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={`${row.handle ?? "pending"}-${i}`} className="border-b border-foreground/10">
              <th scope="row" className="px-3 py-2 text-left font-normal">
                {row.handle ? `@${row.handle}` : <span className="text-foreground/60">Pending sign-up</span>}
              </th>
              <td className="px-3 py-2 capitalize">{row.status}</td>
              <td className="px-3 py-2">{row.consentSkills ? "Yes" : "No"}</td>
              <td className="px-3 py-2">{row.consentCredentials ? "Yes" : "No"}</td>
              <td className="px-3 py-2 tabular-nums">{formatJoined(row.joinedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
