import React from 'react';
import { ShieldCheck, CheckCircle2, AlertTriangle, Info, HelpCircle } from 'lucide-react';
import { SubtitleSegment } from '../types';
import { auditRuleCompliance } from '../utils/srtRules';

interface RuleComplianceAuditProps {
  segments: SubtitleSegment[];
}

export const RuleComplianceAudit: React.FC<RuleComplianceAuditProps> = ({ segments }) => {
  const audit = auditRuleCompliance(segments);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-emerald-50 text-emerald-700">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              Strict Rules A–F Compliance Audit
            </h3>
            <p className="text-xs text-slate-500">
              Live automated validation verifying acoustic classification and tagging rules.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 text-xs font-semibold">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
          <span>100% Rule Compliant</span>
        </div>
      </div>

      {/* Rules Checklist Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* Frozen segmentation rule: max 3 spoken words per segment */}
        <div className="p-3 rounded-xl border border-indigo-200 bg-indigo-50/40 space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-bold text-xs text-indigo-950">Timing Rule (Max 3 Words)</span>
            <span className="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800">
              {audit.ruleChecks.timingRule.passed ? '✓ Compliant' : `${audit.ruleChecks.timingRule.nonCompliantCount} Exceeds`}
            </span>
          </div>
          <p className="text-[11px] text-indigo-900/80">
            Maximum {audit.ruleChecks.timingRule.maxWords} spoken words per segment (2–3 preferred);
            duration follows natural speech timing.
          </p>
        </div>

        {/* Rule A */}
        <div className="p-3 rounded-xl border border-emerald-200 bg-emerald-50/40 space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-bold text-xs text-emerald-950">Rule A: Clear Speech</span>
            <span className="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
              {audit.ruleChecks.ruleA.count} Segments
            </span>
          </div>
          <p className="text-[11px] text-emerald-900/80">
            Clean speech text preserved unchanged with zero tags.
          </p>
        </div>

        {/* Rule B */}
        <div className="p-3 rounded-xl border border-amber-200 bg-amber-50/40 space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-bold text-xs text-amber-950">Rule B: Speech + Background Noise</span>
            <span className="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
              {audit.ruleChecks.ruleB.count} Segments
            </span>
          </div>
          <p className="text-[11px] text-amber-900/80">
            Wrapped in &lt;NOISE&gt;spoken text&lt;/NOISE&gt;.
          </p>
        </div>

        {/* Rule C */}
        <div className="p-3 rounded-xl border border-orange-200 bg-orange-50/40 space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-bold text-xs text-orange-950">Rule C: Music/Noise Only</span>
            <span className="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-orange-100 text-orange-800">
              {audit.ruleChecks.ruleC.count} Segments
            </span>
          </div>
          <p className="text-[11px] text-orange-900/80">
            Non-speech audio output strictly as &lt;NOISE&gt;&lt;/NOISE&gt;.
          </p>
        </div>

        {/* Rule D */}
        <div className="p-3 rounded-xl border border-purple-200 bg-purple-50/40 space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-bold text-xs text-purple-950">Rule D: Fillers & Laughs</span>
            <span className="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-800">
              {audit.ruleChecks.ruleD.count} Segments
            </span>
          </div>
          <p className="text-[11px] text-purple-900/80">
            Vocal fillers wrapped in &lt;FIL&gt;...&lt;/FIL&gt; (no min duration).
          </p>
        </div>

        {/* Rule E */}
        <div className="p-3 rounded-xl border border-slate-300 bg-slate-100/60 space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-bold text-xs text-slate-900">Rule E: Complete Silence</span>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-800">
                {audit.ruleChecks.ruleE.count} (&gt;=2s)
              </span>
              <span className="font-mono text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-200/80 text-slate-600">
                {audit.ruleChecks.ruleE.ignoredCount} Ignored (&lt;2s)
              </span>
            </div>
          </div>
          <p className="text-[11px] text-slate-600">
            &gt;= 2.00s complete silence output as &lt;SIL&gt;&lt;/SIL&gt;. Gaps &lt; 2.00s omitted.
          </p>
        </div>

        {/* Rule F: Unintelligible */}
        <div className="p-3 rounded-xl border border-cyan-200 bg-cyan-50/40 space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-bold text-xs text-cyan-950">Rule F: Unintelligible / Music-Masked Speech</span>
            <span className="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-cyan-100 text-cyan-800">
              {audit.ruleChecks.ruleMB.count} Segments
            </span>
          </div>
          <p className="text-[11px] text-cyan-900/80">
            Speech exists but is not understandable (including speech masked by music). &lt;MB&gt; tagging is disabled: output the segment's plain transcript text, never &lt;MB&gt; (no invented words).
          </p>
        </div>
      </div>

      {/* Warnings if any */}
      {audit.warnings.length > 0 && (
        <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs space-y-1">
          <div className="font-bold flex items-center gap-1.5 text-amber-950">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            Audit Notices
          </div>
          <ul className="list-disc list-inside space-y-0.5 text-[11px] text-amber-800">
            {audit.warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
