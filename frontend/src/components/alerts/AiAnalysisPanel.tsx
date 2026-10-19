import { useState } from "react";
import type { CSSProperties } from "react";
import { RefreshCcw, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";

import { analyzeAlert, rateAnalysis } from "../../api/alerts";
import type { AlertAnalysis } from "../../types/alert";
import { timeAgo } from "../../utils/time";
import { Button } from "../ui";
import { CommandBlock } from "./AlertControls";

const CONFIDENCE: Record<"high" | "medium" | "low", { label: string; bars: number }> = {
  high: { label: "High", bars: 3 },
  medium: { label: "Medium", bars: 2 },
  low: { label: "Low", bars: 1 },
};

/** "Analyze with AI": causes, steps and commands from Claude, on request. */
export default function AiAnalysisPanel({
  alertId,
  deviceId,
  deviceName,
  enabled,
  canOperate,
  canRun,
  initial,
}: {
  alertId: number;
  deviceId: number | null;
  deviceName: string | null;
  enabled: boolean;
  canOperate: boolean;
  canRun: boolean;
  initial: AlertAnalysis | null;
}) {
  const [analysis, setAnalysis] = useState<AlertAnalysis | null>(initial);
  const [language, setLanguage] = useState<"sq" | "en">(initial?.language ?? "sq");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (force: boolean, lang = language) => {
    setBusy(true);
    setError(null);
    try {
      setAnalysis(await analyzeAlert(alertId, { language: lang, force }));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "The analysis failed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const rate = async (rating: 1 | -1) => {
    if (!analysis) return;
    try {
      setAnalysis(await rateAnalysis(analysis.id, rating));
    } catch {
      /* a lost rating is not worth an error */
    }
  };

  const result = analysis?.result;
  return (
    <section className="th-ac-ai" aria-label="AI analysis">
      <div className="th-ac-ai-head">
        <h3>
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          {language === "sq" ? "Analiza me AI" : "AI analysis"}
        </h3>
        <div className="th-ac-seg" role="group" aria-label="Language">
          {(["sq", "en"] as const).map((lang) => (
            <button
              key={lang}
              type="button"
              aria-pressed={language === lang}
              onClick={() => {
                setLanguage(lang);
                if (analysis && analysis.language !== lang && enabled && canOperate) void run(false, lang);
              }}
            >
              {lang === "sq" ? "Shqip" : "English"}
            </button>
          ))}
        </div>
      </div>

      {!enabled ? (
        <p className="th-ac-muted">
          AI analysis is off: the server has no Anthropic API key. The runbook above still applies.
        </p>
      ) : !result && !busy ? (
        <div className="grid gap-2">
          <p className="th-ac-muted">
            {language === "sq"
              ? "Claude lexon provat e këtij alerti dhe jep shkaqet e mundshme, hapat dhe komandat. Nuk ekzekuton asgjë; emrat e klientit, përdoruesit dhe IP-të nuk dërgohen."
              : "Claude reads this alert's evidence and gives the likely causes, the steps and the commands. It runs nothing; client, user names and IPs are not sent."}
          </p>
          {canOperate && (
            <Button size="sm" onClick={() => void run(false)} className="justify-self-start">
              <Sparkles className="h-3.5 w-3.5" />
              Analyze with AI
            </Button>
          )}
        </div>
      ) : null}

      {busy && (
        <div className="th-ac-ai-busy" role="status">
          <span className="th-ac-spinner" aria-hidden="true" />
          {language === "sq" ? "Claude po analizon provat… (10–60 s)" : "Claude is reading the evidence… (10–60 s)"}
        </div>
      )}
      {error && (
        <p className="th-ac-error" role="alert">
          {error}
        </p>
      )}

      {result && !busy && (
        <div className="grid gap-4">
          {analysis?.stale && (
            <p className="th-ac-muted">
              The alert changed since this analysis.{" "}
              {canOperate && (
                <button type="button" className="th-ac-link" onClick={() => void run(true)}>
                  Analyze again
                </button>
              )}
            </p>
          )}
          <div className="th-ac-block">
            <h4>{language === "sq" ? "Përmbledhje" : "Summary"}</h4>
            <p>{result.summary}</p>
          </div>
          {result.likely_causes.length > 0 && (
            <div className="th-ac-block">
              <h4>{language === "sq" ? "Shkaqet e mundshme" : "Likely causes"}</h4>
              <ul className="th-ac-causes">
                {result.likely_causes.map((c, i) => (
                  <li key={i}>
                    <div className="th-ac-cause-row">
                      <b>{c.cause}</b>
                      <span className="th-ac-meter" title={`Confidence: ${CONFIDENCE[c.confidence]?.label}`}>
                        {CONFIDENCE[c.confidence]?.label}
                        {[1, 2, 3].map((n) => (
                          <i key={n} data-on={n <= (CONFIDENCE[c.confidence]?.bars ?? 0)} />
                        ))}
                      </span>
                    </div>
                    <small>{c.evidence}</small>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {[
            { title: language === "sq" ? "Diagnoza" : "Diagnose", steps: result.diagnostic_steps },
            { title: language === "sq" ? "Zgjidhja" : "Fix", steps: result.fix_steps },
          ].map(
            (section) =>
              section.steps.length > 0 && (
                <div className="th-ac-block" key={section.title}>
                  <h4>{section.title}</h4>
                  <ol className="th-ac-steps">
                    {section.steps.map((step, i) => (
                      <li key={i}>
                        <p>{step.step}</p>
                        {step.command.trim() && (
                          <CommandBlock
                            script={step.command}
                            risk={step.risk}
                            deviceId={deviceId}
                            deviceName={deviceName}
                            canRun={canRun}
                          />
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              ),
          )}
          {(result.verify || result.escalate_when) && (
            <div className="th-ac-block">
              <h4>{language === "sq" ? "Verifikimi dhe përshkallëzimi" : "Verify and escalate"}</h4>
              {result.verify && <p>{result.verify}</p>}
              {result.escalate_when && <p className="mt-1">{result.escalate_when}</p>}
            </div>
          )}
          {result.missing_information.length > 0 && (
            <div className="th-ac-block">
              <h4>{language === "sq" ? "Mungon" : "Missing"}</h4>
              <ul className="list-disc pl-5">
                {result.missing_information.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </div>
          )}
          <footer className="th-ac-ai-foot">
            <span>
              {analysis?.model}
              {analysis?.input_tokens != null && ` · ${(analysis.input_tokens / 1000).toFixed(1)}k in`}
              {analysis?.output_tokens != null && ` · ${(analysis.output_tokens / 1000).toFixed(1)}k out`}
              {analysis?.cost_usd != null && ` · ≈ $${analysis.cost_usd.toFixed(3)}`}
              {analysis?.created_at &&
                ` · ${timeAgo(analysis.created_at)}${analysis.created_by ? ` by ${analysis.created_by}` : ""}`}
              {analysis?.cached && " · reused"}
            </span>
            {canOperate && (
              <span className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="th-ac-rate"
                  aria-pressed={analysis?.rating === 1}
                  onClick={() => void rate(1)}
                  style={{ "--rate-tone": "var(--th-status-online)" } as CSSProperties}
                >
                  <ThumbsUp className="h-3.5 w-3.5" /> Useful
                </button>
                <button
                  type="button"
                  className="th-ac-rate"
                  aria-pressed={analysis?.rating === -1}
                  onClick={() => void rate(-1)}
                  style={{ "--rate-tone": "var(--th-status-critical)" } as CSSProperties}
                >
                  <ThumbsDown className="h-3.5 w-3.5" /> Not useful
                </button>
                <button type="button" className="th-ac-rate" onClick={() => void run(true)}>
                  <RefreshCcw className="h-3.5 w-3.5" /> Again
                </button>
              </span>
            )}
          </footer>
        </div>
      )}
    </section>
  );
}
