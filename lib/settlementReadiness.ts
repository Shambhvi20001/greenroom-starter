import type { Deal, Expense, Recoup, Settlement } from "@/db/schema";

export type ReadinessSeverity = "critical" | "warning" | "info";

export type ReadinessIssue = {
  severity: ReadinessSeverity;
  title: string;
  body: string;
  evidence: string;
  action: string;
  owner: "Mariana" | "Marcus" | "Agent" | "Tour manager";
  moneyAtRisk?: number;
};

export type SettlementReadiness = {
  status: "blocked" | "needs_review" | "ready";
  score: number;
  summary: string;
  issues: ReadinessIssue[];
  agentMessage: string;
};

const POSITIVE_SIGNOFF =
  /\b(ok|okay|looks good|good night|sign off|approved|wire monday)\b|👍/i;

export function assessSettlementReadiness({
  deal,
  expenses,
  recoups,
  settlement,
}: {
  deal: Deal;
  expenses: Expense[];
  recoups: Recoup[];
  settlement?: Settlement | null;
}): SettlementReadiness {
  const issues: ReadinessIssue[] = [];
  const passThroughExpenses = expenses.filter((expense) => !expense.absorbedByVenue);
  const totalPassThrough = sumAmounts(passThroughExpenses);
  const notes = deal.dealNotesFreetext ?? "";

  const disputedRecoups = recoups.filter((recoup) => recoup.status === "disputed");
  const agreedRecoups = recoups.filter((recoup) => recoup.status === "agreed");
  const recoupTotal = sumAmounts(recoups);

  if (disputedRecoups.length > 0) {
    issues.push({
      severity: "critical",
      title: "Disputed recoup still changes the story",
      body:
        "The settlement has at least one contested recoup line. Treating the rest of the worksheet as signed hides the part the agent is most likely to reopen.",
      evidence: disputedRecoups
        .map((recoup) => `${recoup.label}: ${formatInlineMoney(recoup.amount)}`)
        .join("; "),
      action: "Resolve or withdraw each disputed recoup before final sign-off.",
      owner: "Mariana",
      moneyAtRisk: sumAmounts(disputedRecoups),
    });
  }

  if (
    disputedRecoups.length > 0 &&
    settlement?.signoffText &&
    POSITIVE_SIGNOFF.test(settlement.signoffText)
  ) {
    issues.push({
      severity: "critical",
      title: "Badge and sign-off contradict each other",
      body:
        "The status says disputed, but the artist-team note reads like approval. This is exactly the kind of paper-trail gap that turns into a next-day agent thread.",
      evidence: `Status: ${settlement.status}. Sign-off: "${settlement.signoffText}"`,
      action:
        "Capture the exception explicitly: which line was signed, which line remains disputed, and who accepted the revised amount.",
      owner: "Mariana",
      moneyAtRisk: sumAmounts(disputedRecoups),
    });
  }

  if (deal.expenseCap != null && totalPassThrough > deal.expenseCap) {
    issues.push({
      severity: "warning",
      title: "Passed-through expenses exceed the cap",
      body:
        "The current passed-through expenses are above the structured cap. If Mariana is absorbing the overage, that needs to be visible before the walkthrough.",
      evidence: `${formatInlineMoney(totalPassThrough)} passed through vs ${formatInlineMoney(deal.expenseCap)} cap`,
      action: "Mark over-cap expenses as absorbed or get written agent approval.",
      owner: "Mariana",
      moneyAtRisk: totalPassThrough - deal.expenseCap,
    });
  }

  if (deal.hospitalityCap != null) {
    const hospitality = expenses.filter((expense) => expense.category === "hospitality");
    const passThroughHospitality = sumAmounts(
      hospitality.filter((expense) => !expense.absorbedByVenue),
    );
    const absorbedHospitality = sumAmounts(
      hospitality.filter((expense) => expense.absorbedByVenue),
    );

    if (passThroughHospitality > deal.hospitalityCap) {
      issues.push({
        severity: "warning",
        title: "Hospitality overage is being passed through",
        body:
          "Hospitality is one of the recurring 2am arguments. Passing through more than the cap needs a receipt-backed explanation.",
        evidence: `${formatInlineMoney(passThroughHospitality)} passed through vs ${formatInlineMoney(deal.hospitalityCap)} cap`,
        action: "Split the overage into absorbed vs artist-approved before sending.",
        owner: "Mariana",
        moneyAtRisk: passThroughHospitality - deal.hospitalityCap,
      });
    } else if (absorbedHospitality > 0) {
      issues.push({
        severity: "info",
        title: "Hospitality overage is already absorbed",
        body:
          "This is good settlement hygiene. Keep it visible so the tour manager sees the venue is not passing the overage through.",
        evidence: `${formatInlineMoney(absorbedHospitality)} absorbed by venue`,
        action: "Show the absorbed amount in the walkthrough and agent recap.",
        owner: "Mariana",
      });
    }
  }

  if (deal.expenseCap != null && recoups.some((recoup) => recoup.category === "marketing")) {
    const explicitInsideCap = /\b(marketing|recoup).{0,40}\b(included|inside|within)\b.{0,40}\b(cap|expenses)\b/i.test(
      notes,
    );
    const explicitOutsideCap = /\b(marketing|recoup).{0,50}\b(additional|outside|separate|in addition)\b.{0,40}\b(cap|expenses)\b/i.test(
      notes,
    );

    if (!explicitInsideCap && !explicitOutsideCap) {
      issues.push({
        severity: "critical",
        title: "Marketing recoup placement is ambiguous",
        body:
          "The deal has both an expense cap and a marketing recoup, but the notes do not say whether the recoup is inside or outside the cap.",
        evidence: notes || "No trusted deal prose entered.",
        action:
          "Send the agent a one-line clarification before settlement: inside cap, outside cap, or withdrawn.",
        owner: "Agent",
        moneyAtRisk: sumAmounts(
          recoups.filter((recoup) => recoup.category === "marketing"),
        ),
      });
    }
  }

  for (const recoup of recoups) {
    if (
      recoup.category !== "marketing" &&
      /\b(marketing|spotify|instagram|ad spend|pre-show ad)\b/i.test(recoup.label)
    ) {
      issues.push({
        severity: "warning",
        title: "Recoup category does not match the label",
        body:
          "A marketing-like recoup is filed under another category. Agents read these line items closely, and a misfiled recoup looks like a hidden deduction.",
        evidence: `${recoup.label} is categorized as ${recoup.category.replaceAll("_", " ")}`,
        action: "Reclassify the recoup or add a note explaining why it belongs there.",
        owner: "Mariana",
        moneyAtRisk: recoup.amount,
      });
    }
  }

  if (recoups.length > 0 && recoupTotal > 0 && agreedRecoups.length === recoups.length) {
    issues.push({
      severity: "info",
      title: "Recoups have line-item status",
      body:
        "Every recoup is separately marked agreed. That gives Mariana a cleaner paper trail than a single settlement-level badge.",
      evidence: `${recoups.length} recoup${recoups.length === 1 ? "" : "s"} totaling ${formatInlineMoney(recoupTotal)}`,
      action: "Keep the recoup table in the agent recap.",
      owner: "Mariana",
    });
  }

  if (
    ["vs", "percentage_of_net", "door"].includes(deal.dealType) &&
    !/\b(after expenses|net|expense|cap|gross|door)\b/i.test(notes)
  ) {
    issues.push({
      severity: "warning",
      title: "Trusted deal prose is too thin",
      body:
        "The structured deal type says this settlement depends on deduction rules, but the free-text source of truth does not explain them.",
      evidence: notes || "No trusted deal prose entered.",
      action: "Add the settlement basis in prose before relying on the worksheet.",
      owner: "Mariana",
    });
  }

  const criticalCount = issues.filter((issue) => issue.severity === "critical").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const score = Math.max(0, 100 - criticalCount * 34 - warningCount * 14);
  const status =
    criticalCount > 0 ? "blocked" : warningCount > 0 ? "needs_review" : "ready";

  return {
    status,
    score,
    summary: buildSummary(status, criticalCount, warningCount),
    issues,
    agentMessage: buildAgentMessage({ deal, issues, recoups }),
  };
}

function buildSummary(
  status: SettlementReadiness["status"],
  criticalCount: number,
  warningCount: number,
) {
  if (status === "blocked") {
    return `${criticalCount} blocker${criticalCount === 1 ? "" : "s"} to resolve before the 2am walkthrough.`;
  }

  if (status === "needs_review") {
    return `${warningCount} review item${warningCount === 1 ? "" : "s"} to clarify before sending the statement.`;
  }

  return "No recoup or cap conflicts detected from the current deal notes and settlement data.";
}

function buildAgentMessage({
  deal,
  issues,
  recoups,
}: {
  deal: Deal;
  issues: ReadinessIssue[];
  recoups: Recoup[];
}) {
  const critical = issues.filter((issue) => issue.severity === "critical");
  if (critical.length > 0) {
    const first = critical[0];
    return `Before we settle this, can you confirm ${first.title.toLowerCase()}? Current read: ${first.evidence}`;
  }

  if (recoups.length > 0) {
    return `Settlement preview: ${recoups.length} recoup line${recoups.length === 1 ? "" : "s"} shown separately, with status on each line so nothing is buried in expenses.`;
  }

  return `Settlement preview: ${deal.dealNotesFreetext ?? "deal terms attached"}`;
}

function sumAmounts(items: Array<{ amount: number }>) {
  return items.reduce((sum, item) => sum + item.amount, 0);
}

function formatInlineMoney(value: number) {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}
