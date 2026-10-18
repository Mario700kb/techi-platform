"""The monthly executive summary: one headline per report, the worst issues
across all of them and plain, rule-based recommendations."""
from app.schemas.client_report import ReportKpi, ReportSection
from app.services.client_reports import access, availability, capacity, lifecycle, patch, security
from app.services.client_reports.catalog import SECURITY_AGENT_VERSION, TITLES
from app.services.client_reports.common import TONE_OF, Built, ReportContext, col, human_duration, plural
from app.services.client_reports.render import display

KEY = "executive"
MAX_ISSUES = 10
MAX_RECOMMENDATIONS = 10
SEVERITY_LABEL = {3: "Critical", 2: "Warning", 1: "Info"}


def build(ctx: ReportContext) -> Built:
    parts = {module.KEY: module.build(ctx) for module in (patch, availability, lifecycle, capacity, access, security)}
    a, life, cap, acc, sec = (parts[k].facts for k in ("availability", "lifecycle", "capacity", "access_audit",
                                                         "security_posture"))

    def by_kpi(key: str, index: int) -> ReportKpi:
        return parts[key].document.summary[index]

    compliance = by_kpi("patch_compliance", 0)
    server = by_kpi("availability", 0)
    summary = [
        ReportKpi(label="Patch compliance", value=compliance.value, kind="percent", tone=compliance.tone, hint=compliance.hint),
        ReportKpi(label="Server availability", value=server.value, kind="percent", tone=server.tone,
                  hint=plural(a["outages"], "outage") if a["servers"] else "No servers"),
        ReportKpi(label="Unsupported OS", value=life["unsupported"], tone="crit" if life["unsupported"] else "ok",
                  hint=f"{life['ending']} more within 12 months"),
        ReportKpi(label="Disks at risk", value=cap["at_risk"], tone="crit" if cap["at_risk"] else "warn" if cap["soon"] else "ok",
                  hint=f"90%+ full; {cap['soon']} more within 30 days"),
        ReportKpi(label="Remote sessions", value=acc["sessions"], tone="neutral",
                  hint=f"{human_duration(acc['seconds'])} in total by {acc['operators']} operators"),
    ]
    if sec["with_data"]:
        protected = by_kpi("security_posture", 0)
        summary.append(ReportKpi(label="Security: protected", value=protected.value, kind="percent", tone=protected.tone,
                                 hint=protected.hint))
    else:
        summary.append(ReportKpi(label="Security: protected", value=f"needs agent {SECURITY_AGENT_VERSION}", kind="text",
                                 tone="info", hint="No device reports its security settings yet"))

    issues = sorted((issue for built in parts.values() for issue in built.issues),
                    key=lambda i: (-i.severity, -i.count))[:MAX_ISSUES]
    issue_rows = [{"severity": SEVERITY_LABEL[i.severity], "issue": i.text, "area": TITLES.get(i.report, i.report),
                   "_tone": TONE_OF[i.severity]} for i in issues]
    recs = sorted((r for built in parts.values() for r in built.recommendations), key=lambda r: -r.priority)
    seen, rec_rows = set(), []
    for rec in recs:
        if rec.text in seen:
            continue
        seen.add(rec.text)
        rec_rows.append({"n": len(rec_rows) + 1, "recommendation": rec.text})
        if len(rec_rows) >= MAX_RECOMMENDATIONS:
            break

    areas = []
    for built in parts.values():
        doc = built.document
        head = doc.summary[0] if doc.summary else None
        crit = sum(1 for i in built.issues if i.severity == 3)
        warn = sum(1 for i in built.issues if i.severity == 2)
        # An area with nothing measured (no device reports it yet) is not "OK".
        measured = head is not None and head.value is not None and head.kind != "text"
        status, tone = (
            ("Action needed", "crit") if crit else ("Review", "warn") if warn
            else ("OK", "ok") if measured else ("No data", "neutral")
        )
        areas.append({"area": doc.title, "headline": head.label if head else "—",
                      "value": display(head.value, head.kind) if head and head.value is not None else "—",
                      "status": status, "_tone": tone})
    sections = [
        ReportSection(key="top_issues", title="Top issues", description="The most serious findings of every report.",
                      columns=[col("severity", "Severity", "badge"), col("issue", "Issue"), col("area", "Report")],
                      rows=issue_rows, empty="No issues found."),
        ReportSection(key="recommendations", title="Recommendations", description="What to do next, most important first.",
                      columns=[col("n", "#", "number"), col("recommendation", "Recommendation")],
                      rows=rec_rows, empty="Nothing to recommend: keep the current routine."),
        ReportSection(key="areas", title="Areas", description="The headline of each detailed report.",
                      columns=[col("area", "Report"), col("headline", "Measure"), col("value", "Value", align="right"),
                               col("status", "Status", "badge")],
                      rows=areas, empty="—"),
    ]
    document = ctx.document(
        key=KEY, title="Executive summary", subtitle="The headline of every report, the top issues and what to do next",
        summary=summary, sections=sections,
        notes=["Each area has its own detailed report with the device lists behind these figures."],
    )
    return Built(document)

