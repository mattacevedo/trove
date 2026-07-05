/** Read-only roster of current cohort members + pending invites. Status is conveyed as TEXT
 *  (never color alone) per WCAG-AA. Consented per-member data is NOT shown here — this table lists
 *  only membership status the sponsor is entitled to see (their own invites + members). */
export interface CohortRosterRow {
  email: string;
  status: string;
  accepted: boolean;
}

export function CohortRosterTable({ rows }: { rows: CohortRosterRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-foreground/70">
        No members or invites yet. Send your first invitations above.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">Cohort members and outstanding invitations</caption>
        <thead>
          <tr className="border-b border-foreground/20">
            <th scope="col" className="py-2 pr-4 font-medium">
              Email
            </th>
            <th scope="col" className="py-2 font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.email} className="border-b border-foreground/10">
              <td className="py-2 pr-4">{r.email}</td>
              <td className="py-2">{r.accepted ? "Active" : "Invite sent"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
