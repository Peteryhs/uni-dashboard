import { useState, useEffect, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import {
  Sparkles,
  Calendar,
  User,
  AlertCircle,
  RefreshCw,
  Check,
  Trash2,
  Edit2,
  X,
  RotateCcw,
  BookOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  getOfficeHours,
  putOfficeHours,
  parseOfficeHours,
  fetchAiModels,
  type AiModelInfo,
} from '@/lib/api';
import type {
  OfficeHourRule,
  OfficeHoursConfig,
  OfficeHoursDraft,
  OfficeHoursDraftRule,
  PreviewOccurrence,
  WeekdayCode,
  OfficeHourKind,
} from '@/lib/contract';
import { cn } from '@/lib/utils';

const WEEKDAYS: { code: WeekdayCode; label: string }[] = [
  { code: 'MO', label: 'Mon' },
  { code: 'TU', label: 'Tue' },
  { code: 'WE', label: 'Wed' },
  { code: 'TH', label: 'Thu' },
  { code: 'FR', label: 'Fri' },
  { code: 'SA', label: 'Sat' },
  { code: 'SU', label: 'Sun' },
];

const KIND_OPTIONS: { id: OfficeHourKind; label: string }[] = [
  { id: 'office_hours', label: 'Office Hours' },
  { id: 'tutorial', label: 'Tutorial' },
  { id: 'help_session', label: 'Help Session' },
  { id: 'other', label: 'Other' },
];

function formatTime24to12(timeStr: string): string {
  if (!timeStr || !timeStr.includes(':')) return timeStr;
  const [hStr, mStr] = timeStr.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (isNaN(h) || isNaN(m)) return timeStr;
  const ampm = h >= 12 ? 'pm' : 'am';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${m.toString().padStart(2, '0')}${ampm}`;
}

function formatOccurrenceTime(startsAt: number, endsAt: number): string {
  const d = new Date(startsAt);
  const dateStr = d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const startTime = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const endTime = new Date(endsAt).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${dateStr}, ${startTime}–${endTime}`;
}

function formatRuleSummary(rule: {
  byday: WeekdayCode[];
  start_local: string;
  end_local: string;
  location?: string;
  starts_on?: string | null;
  until?: string | null;
}): string {
  const days = rule.byday
    .map((code) => WEEKDAYS.find((w) => w.code === code)?.label || code)
    .join(', ');
  const times = `${formatTime24to12(rule.start_local)}–${formatTime24to12(rule.end_local)}`;
  const parts = [days, times];
  if (rule.location) parts.push(rule.location);
  if (rule.starts_on) parts.push(`from ${rule.starts_on}`);
  if (rule.until) parts.push(`until ${rule.until}`);
  return parts.join(' · ');
}

interface EditableRuleCardProps {
  rule: OfficeHoursDraftRule | OfficeHourRule;
  onChange: (updated: any) => void;
  idPrefix: string;
  confidence?: number;
}

function EditableRuleCard({ rule, onChange, idPrefix, confidence }: EditableRuleCardProps) {
  const handleToggleDay = (day: WeekdayCode) => {
    const current = rule.byday || [];
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day];
    if (next.length > 0) {
      onChange({ ...rule, byday: next });
    }
  };

  return (
    <div className="rounded-xl border border-border/70 bg-card/60 p-4 space-y-3.5 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-1">
          <Badge variant="outline" className="text-[10px] uppercase font-semibold text-live border-live/30">
            {rule.kind.replace('_', ' ')}
          </Badge>
          {confidence !== undefined && (
            <span className="text-[10px] text-zinc-400 font-mono">
              {Math.round(confidence * 100)}% confidence
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label htmlFor={`${idPrefix}-course`} className="text-xs text-zinc-400">
            Course
          </Label>
          <Input
            id={`${idPrefix}-course`}
            value={rule.course}
            onChange={(e) => onChange({ ...rule, course: e.target.value })}
            placeholder="e.g. ECE 198"
            className="mt-1 h-8 text-xs bg-background/50"
          />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-label`} className="text-xs text-zinc-400">
            Label
          </Label>
          <Input
            id={`${idPrefix}-label`}
            value={rule.label}
            onChange={(e) => onChange({ ...rule, label: e.target.value })}
            placeholder="e.g. Prof Office Hours"
            className="mt-1 h-8 text-xs bg-background/50"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <Label htmlFor={`${idPrefix}-kind`} className="text-xs text-zinc-400">
            Type
          </Label>
          <select
            id={`${idPrefix}-kind`}
            value={rule.kind}
            onChange={(e) => onChange({ ...rule, kind: e.target.value as OfficeHourKind })}
            className="mt-1 h-8 w-full rounded-md border border-input bg-background/50 px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-live"
          >
            {KIND_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-host`} className="text-xs text-zinc-400">
            Host / Instructor
          </Label>
          <Input
            id={`${idPrefix}-host`}
            value={rule.host}
            onChange={(e) => onChange({ ...rule, host: e.target.value })}
            placeholder="e.g. Prof. Smith"
            className="mt-1 h-8 text-xs bg-background/50"
          />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-location`} className="text-xs text-zinc-400">
            Location
          </Label>
          <Input
            id={`${idPrefix}-location`}
            value={rule.location}
            onChange={(e) => onChange({ ...rule, location: e.target.value })}
            placeholder="e.g. E7 3416 or Online"
            className="mt-1 h-8 text-xs bg-background/50"
          />
        </div>
      </div>

      <div>
        <Label className="text-xs text-zinc-400 block mb-1.5">Days of the Week</Label>
        <div
          role="group"
          aria-label="Recurrence days of the week"
          className="flex flex-wrap gap-1.5"
        >
          {WEEKDAYS.map((w) => {
            const isSelected = (rule.byday || []).includes(w.code);
            return (
              <button
                key={w.code}
                type="button"
                aria-pressed={isSelected}
                onClick={() => handleToggleDay(w.code)}
                className={cn(
                  'px-2.5 py-1 text-xs font-medium rounded-lg border transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live',
                  isSelected
                    ? 'bg-live/20 text-live border-live/50 font-semibold'
                    : 'bg-background/40 text-zinc-400 border-border/50 hover:bg-secondary/50'
                )}
              >
                {w.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <Label htmlFor={`${idPrefix}-start`} className="text-xs text-zinc-400">
            Start Time
          </Label>
          <Input
            id={`${idPrefix}-start`}
            type="time"
            value={rule.start_local}
            onChange={(e) => onChange({ ...rule, start_local: e.target.value })}
            className="mt-1 h-8 text-xs bg-background/50"
          />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-end`} className="text-xs text-zinc-400">
            End Time
          </Label>
          <Input
            id={`${idPrefix}-end`}
            type="time"
            value={rule.end_local}
            onChange={(e) => onChange({ ...rule, end_local: e.target.value })}
            className="mt-1 h-8 text-xs bg-background/50"
          />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-starts-on`} className="text-xs text-zinc-400">
            Starts On
          </Label>
          <Input
            id={`${idPrefix}-starts-on`}
            type="date"
            value={rule.starts_on || ''}
            onChange={(e) => onChange({ ...rule, starts_on: e.target.value || null })}
            className="mt-1 h-8 text-xs bg-background/50"
          />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-until`} className="text-xs text-zinc-400">
            Until Date
          </Label>
          <Input
            id={`${idPrefix}-until`}
            type="date"
            value={rule.until || ''}
            onChange={(e) => onChange({ ...rule, until: e.target.value || null })}
            className="mt-1 h-8 text-xs bg-background/50"
          />
        </div>
      </div>

      <div>
        <Label htmlFor={`${idPrefix}-notes`} className="text-xs text-zinc-400">
          Notes & Exceptions
        </Label>
        <Input
          id={`${idPrefix}-notes`}
          value={rule.notes}
          onChange={(e) => onChange({ ...rule, notes: e.target.value })}
          placeholder="e.g. No session during reading week"
          className="mt-1 h-8 text-xs bg-background/50"
        />
      </div>
    </div>
  );
}

export function ScheduleTab() {
  const pasteTextId = useId();
  const courseInputId = useId();
  const modelSelectId = useId();

  // Saved rules state
  const [config, setConfig] = useState<OfficeHoursConfig>({ rules: [], version: 1 });
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  // Parsing inputs
  const [pastedText, setPastedText] = useState('');
  const [courseCode, setCourseCode] = useState('');
  const [selectedModel, setSelectedModel] = useState('@cf/google/gemma-4-26b-a4b-it');
  const [availableModels, setAvailableModels] = useState<AiModelInfo[]>([]);

  // Parser execution state
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');

  // Draft review state
  const [draft, setDraft] = useState<OfficeHoursDraft | null>(null);
  const [previewOccurrences, setPreviewOccurrences] = useState<PreviewOccurrence[]>([]);
  const [saving, setSaving] = useState(false);

  // In-session Editing & Deletion state
  const [editingSavedRuleId, setEditingSavedRuleId] = useState<string | null>(null);
  const [editedSavedRule, setEditedSavedRule] = useState<OfficeHourRule | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [undoToast, setUndoToast] = useState<{
    id: string;
    label: string;
    rule: OfficeHourRule;
    index: number;
  } | null>(null);

  // Auto-dismiss undo toast after 5s
  useEffect(() => {
    if (!undoToast) return;
    const timer = setTimeout(() => {
      setUndoToast(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [undoToast]);

  const loadSavedConfig = useCallback(async () => {
    setLoadingConfig(true);
    setConfigError(null);
    try {
      const data = await getOfficeHours();
      setConfig(data);
    } catch (err: any) {
      setConfigError(err.message || 'Failed to load office hours');
    } finally {
      setLoadingConfig(false);
    }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const res = await fetchAiModels();
      if (res?.models?.length) {
        setAvailableModels(res.models);
        if (res.default_model) {
          setSelectedModel(res.default_model);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    loadSavedConfig();
    loadModels();
  }, [loadSavedConfig, loadModels]);

  const handleParse = async (force = false) => {
    if (!pastedText.trim()) return;
    setParsing(true);
    setParseError(null);
    setRawError(null);
    setStatusMessage('Parsing office hours text with AI...');

    try {
      const result = await parseOfficeHours(pastedText, {
        course: courseCode.trim() || undefined,
        model: selectedModel,
        force,
      });

      setDraft(result.draft);
      setPreviewOccurrences(result.preview || []);
      const count = result.draft.rules.length;
      setStatusMessage(
        count === 0
          ? 'Parsing complete: No recurring office hours found in text.'
          : `Parsing complete: Generated ${count} recurrence ${count === 1 ? 'rule' : 'rules'}.`
      );
    } catch (err: any) {
      setParseError(err.message || 'Failed to parse office hours text');
      if (err.raw) {
        setRawError(typeof err.raw === 'string' ? err.raw : JSON.stringify(err.raw, null, 2));
      }
      setStatusMessage(`Parse error: ${err.message}`);
    } finally {
      setParsing(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!draft) return;
    setSaving(true);
    setStatusMessage('Saving rules to schedule...');
    try {
      const newRules: OfficeHourRule[] = draft.rules.map((r) => ({
        ...r,
        id: crypto.randomUUID().slice(0, 10),
        created_at: Date.now(),
        updated_at: Date.now(),
      }));

      const updatedConfig: OfficeHoursConfig = {
        version: 1,
        rules: [...config.rules, ...newRules],
      };

      await putOfficeHours(updatedConfig);
      setConfig(updatedConfig);
      setDraft(null);
      setPreviewOccurrences([]);
      setPastedText('');
      setCourseCode('');
      setStatusMessage('Office hours saved successfully and schedule updated.');
    } catch (err: any) {
      setParseError(`Save failed: ${err.message}`);
      setStatusMessage(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscardDraft = () => {
    setDraft(null);
    setPreviewOccurrences([]);
    setParseError(null);
    setRawError(null);
    setStatusMessage('Draft discarded.');
  };

  const handleStartEditSavedRule = (rule: OfficeHourRule) => {
    setEditingSavedRuleId(rule.id);
    setEditedSavedRule({ ...rule });
  };

  const handleSaveEditedRule = async () => {
    if (!editedSavedRule) return;
    const updatedRules = config.rules.map((r) =>
      r.id === editedSavedRule.id ? { ...editedSavedRule, updated_at: Date.now() } : r
    );
    const updatedConfig: OfficeHoursConfig = {
      version: 1,
      rules: updatedRules,
    };
    try {
      await putOfficeHours(updatedConfig);
      setConfig(updatedConfig);
      setEditingSavedRuleId(null);
      setEditedSavedRule(null);
      setStatusMessage('Rule updated successfully.');
    } catch (err: any) {
      setConfigError(`Failed to update rule: ${err.message}`);
    }
  };

  const handleDeleteSavedRule = async (ruleId: string) => {
    const ruleIndex = config.rules.findIndex((r) => r.id === ruleId);
    if (ruleIndex === -1) return;
    const deletedRule = config.rules[ruleIndex];

    const updatedRules = config.rules.filter((r) => r.id !== ruleId);
    const updatedConfig: OfficeHoursConfig = {
      version: 1,
      rules: updatedRules,
    };

    try {
      await putOfficeHours(updatedConfig);
      setConfig(updatedConfig);
      setConfirmDeleteId(null);
      setUndoToast({
        id: deletedRule.id,
        label: deletedRule.label,
        rule: deletedRule,
        index: ruleIndex,
      });
      setStatusMessage(`Deleted rule: ${deletedRule.label}.`);
    } catch (err: any) {
      setConfigError(`Failed to delete rule: ${err.message}`);
    }
  };

  const handleUndoDelete = async () => {
    if (!undoToast) return;
    const restored = [...config.rules];
    restored.splice(undoToast.index, 0, undoToast.rule);
    const updatedConfig: OfficeHoursConfig = {
      version: 1,
      rules: restored,
    };
    try {
      await putOfficeHours(updatedConfig);
      setConfig(updatedConfig);
      setUndoToast(null);
      setStatusMessage(`Restored rule: ${undoToast.label}.`);
    } catch (err: any) {
      setConfigError(`Failed to restore rule: ${err.message}`);
    }
  };

  return (
    <div className="space-y-6 text-foreground pb-6">
      {/* Accessible live announcement region */}
      <div role="status" aria-live="polite" className="sr-only">
        {statusMessage}
      </div>

      {/* SECTION 1: ADD NEW */}
      <div className="space-y-3.5 rounded-xl border border-border/60 bg-secondary/20 p-4">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-live" />
          <h3 className="text-sm font-semibold text-foreground">Add Office Hours with AI</h3>
        </div>
        <p className="text-xs text-zinc-400">
          Paste text from a course announcement, syllabus, or Piazza post. The AI extracts recurring slots into a reviewable draft.
        </p>

        <div className="space-y-3">
          <div>
            <Label htmlFor={pasteTextId} className="text-xs text-zinc-300 font-medium">
              Announcement or Syllabus Text
            </Label>
            <Textarea
              id={pasteTextId}
              rows={3}
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
              placeholder="e.g. Office hours: Mon & Wed 2:00-3:00pm in E7 3416, starting next week through Dec 5. TA session Thursdays 10:30-11:20 in DC 2568."
              className="mt-1 text-xs bg-background/50 border-border/70 focus-visible:ring-live"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor={courseInputId} className="text-xs text-zinc-300 font-medium">
                Course Code (Optional)
              </Label>
              <Input
                id={courseInputId}
                value={courseCode}
                onChange={(e) => setCourseCode(e.target.value)}
                placeholder="e.g. ECE 198"
                className="mt-1 h-8 text-xs bg-background/50 border-border/70 focus-visible:ring-live"
              />
            </div>
            <div>
              <Label htmlFor={modelSelectId} className="text-xs text-zinc-300 font-medium">
                Model
              </Label>
              <select
                id={modelSelectId}
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="mt-1 h-8 w-full rounded-md border border-input bg-background/50 px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-live"
              >
                {availableModels.length > 0 ? (
                  availableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} {m.tag ? `(${m.tag})` : ''}
                    </option>
                  ))
                ) : (
                  <option value={selectedModel}>Google Gemma 4 (26B-A4B)</option>
                )}
              </select>
            </div>
          </div>

          {parseError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 space-y-1.5 text-xs text-red-200">
              <div className="flex items-center gap-1.5 font-medium text-red-300">
                <AlertCircle className="size-4 shrink-0" />
                <span>Parse Error (502)</span>
              </div>
              <p>{parseError}</p>
              {rawError && (
                <pre className="mt-1.5 p-2 bg-black/40 rounded text-[11px] font-mono text-zinc-300 overflow-x-auto max-h-32">
                  {rawError}
                </pre>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              onClick={() => handleParse(false)}
              disabled={parsing || !pastedText.trim()}
              aria-busy={parsing}
              className="h-8 text-xs bg-live text-black hover:bg-live/90 font-medium cursor-pointer"
            >
              {parsing ? (
                <>
                  <RefreshCw className="size-3.5 mr-1.5 animate-spin" />
                  Parsing with AI...
                </>
              ) : (
                <>
                  <Sparkles className="size-3.5 mr-1.5" />
                  Parse with AI
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* SECTION 2: DRAFT PREVIEW STATE */}
      {draft && (
        <div className="space-y-4 rounded-xl border border-live/40 bg-live/5 p-4 animate-in fade-in duration-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BookOpen className="size-4 text-live" />
              <h3 className="text-sm font-semibold text-foreground">Review Draft Rules</h3>
            </div>
            <Badge variant="outline" className="text-xs border-live/30 text-live">
              {draft.rules.length} {draft.rules.length === 1 ? 'Rule' : 'Rules'} Drafted
            </Badge>
          </div>

          {draft.warnings && draft.warnings.length > 0 && (
            <div className="rounded-lg border border-amber/40 bg-amber/10 p-3 text-xs text-amber-200 space-y-1">
              <div className="flex items-center gap-1.5 font-medium text-amber-300">
                <AlertCircle className="size-3.5 shrink-0" />
                <span>Model Notes & Warnings</span>
              </div>
              <ul className="list-disc list-inside space-y-0.5 text-zinc-300 pl-1">
                {draft.warnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {draft.rules.length === 0 ? (
            <div className="p-4 text-center rounded-lg border border-dashed border-border/80 bg-background/40 text-xs text-zinc-400">
              No recurring office hours detected in this text. If appointment-only, no schedule was created.
            </div>
          ) : (
            <div className="space-y-3">
              {draft.rules.map((rule, idx) => (
                <EditableRuleCard
                  key={idx}
                  idPrefix={`draft-rule-${idx}`}
                  rule={rule}
                  confidence={rule.confidence}
                  onChange={(updated) => {
                    const nextRules = [...draft.rules];
                    nextRules[idx] = updated;
                    setDraft({ ...draft, rules: nextRules });
                  }}
                />
              ))}

              {/* Concrete Occurrences Preview */}
              {previewOccurrences.length > 0 && (
                <div className="mt-3 rounded-lg border border-border/50 bg-background/40 p-3 space-y-2">
                  <h4 className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                    <Calendar className="size-3.5 text-live" />
                    First Concrete Occurrences Preview
                  </h4>
                  <div className="divide-y divide-border/40 text-xs">
                    {previewOccurrences.map((occ, idx) => (
                      <div key={idx} className="py-1.5 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 truncate">
                          <span className="font-medium text-foreground">
                            {formatOccurrenceTime(occ.starts_at, occ.ends_at)}
                          </span>
                          <span className="text-zinc-500">·</span>
                          <span className="text-zinc-400 truncate">{occ.label}</span>
                        </div>
                        {occ.location && (
                          <span className="text-zinc-400 shrink-0 font-mono text-[11px]">
                            {occ.location}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-border/40">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => handleParse(true)}
              disabled={parsing}
              className="h-8 text-xs cursor-pointer"
            >
              <RefreshCw className={cn('size-3 mr-1.5', parsing && 'animate-spin')} />
              Re-parse
            </Button>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleDiscardDraft}
                className="h-8 text-xs text-zinc-400 hover:text-foreground cursor-pointer"
              >
                Discard
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSaveDraft}
                disabled={saving || draft.rules.length === 0}
                className="h-8 text-xs bg-live text-black hover:bg-live/90 font-medium cursor-pointer"
              >
                {saving ? (
                  <>
                    <RefreshCw className="size-3 mr-1.5 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Check className="size-3 mr-1.5" />
                    Save to Schedule
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* SECTION 3: SAVED ENTRIES */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calendar className="size-4 text-zinc-300" />
            <h3 className="text-sm font-semibold text-foreground">Saved Office Hours</h3>
          </div>
          <Badge variant="secondary" className="text-xs">
            {config.rules.length} {config.rules.length === 1 ? 'Rule' : 'Rules'} Active
          </Badge>
        </div>

        {configError && (
          <div className="p-3 text-xs rounded-lg border border-red-500/30 bg-red-500/10 text-red-200">
            {configError}
          </div>
        )}

        {loadingConfig ? (
          <div className="p-6 text-center text-xs text-zinc-400">Loading saved entries...</div>
        ) : config.rules.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/80 bg-background/30 p-6 text-center space-y-1">
            <p className="text-xs text-zinc-400">No recurring office hours saved yet.</p>
            <p className="text-[11px] text-zinc-500">
              Paste your course announcement above to create structured recurring entries.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {config.rules.map((rule) => {
              const isEditing = editingSavedRuleId === rule.id;
              const isConfirmingDelete = confirmDeleteId === rule.id;

              if (isEditing && editedSavedRule) {
                return (
                  <div key={rule.id} className="space-y-3">
                    <EditableRuleCard
                      idPrefix={`edit-rule-${rule.id}`}
                      rule={editedSavedRule}
                      onChange={(updated) => setEditedSavedRule(updated)}
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingSavedRuleId(null);
                          setEditedSavedRule(null);
                        }}
                        className="h-7 text-xs cursor-pointer"
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={handleSaveEditedRule}
                        className="h-7 text-xs bg-live text-black hover:bg-live/90 cursor-pointer font-medium"
                      >
                        Save Changes
                      </Button>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={rule.id}
                  className="rounded-xl border border-border/60 bg-card/40 p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors hover:border-border"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {rule.course && (
                        <Badge variant="outline" className="text-[11px] font-semibold text-live border-live/30 shrink-0">
                          {rule.course}
                        </Badge>
                      )}
                      <span className="text-xs font-semibold text-foreground truncate">{rule.label}</span>
                      <span className="text-zinc-600 text-xs select-none">·</span>
                      <Badge variant="secondary" className="text-[10px] text-zinc-400 uppercase tracking-wider font-mono px-1.5 py-0">
                        {rule.kind.replace('_', ' ')}
                      </Badge>
                    </div>
                    <div className="text-xs text-zinc-300 font-medium">
                      {formatRuleSummary(rule)}
                    </div>
                    {(rule.host || rule.notes) && (
                      <div className="text-[11px] text-zinc-400 flex items-center gap-3">
                        {rule.host && (
                          <span className="flex items-center gap-1">
                            <User className="size-3 text-zinc-500" />
                            {rule.host}
                          </span>
                        )}
                        {rule.notes && <span className="italic text-zinc-500 truncate max-w-sm">"{rule.notes}"</span>}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
                    {isConfirmingDelete ? (
                      <div className="flex items-center gap-1.5 bg-red-500/10 border border-red-500/30 rounded-lg p-1">
                        <span className="text-[11px] text-red-300 font-medium px-1">Delete?</span>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => handleDeleteSavedRule(rule.id)}
                          className="h-6 px-2 text-[11px] cursor-pointer"
                        >
                          Yes
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmDeleteId(null)}
                          className="h-6 px-2 text-[11px] cursor-pointer"
                        >
                          No
                        </Button>
                      </div>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleStartEditSavedRule(rule)}
                          className="h-7 px-2 text-xs text-zinc-400 hover:text-foreground cursor-pointer"
                          aria-label={`Edit ${rule.label}`}
                        >
                          <Edit2 className="size-3 mr-1" />
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirmDeleteId(rule.id)}
                          className="h-7 px-2 text-xs text-zinc-400 hover:text-red-400 cursor-pointer"
                          aria-label={`Delete ${rule.label}`}
                        >
                          <Trash2 className="size-3 mr-1" />
                          Delete
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Floating In-Session Undo Toast */}
      {undoToast &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            role="status"
            aria-live="polite"
            className="fixed bottom-5 right-5 z-50 flex items-center gap-3 rounded-xl border border-white/10 bg-zinc-900/95 px-4 py-2.5 shadow-2xl backdrop-blur-md ring-1 ring-white/10 animate-in fade-in slide-in-from-bottom-4 duration-200"
          >
            <div className="flex items-center gap-2 max-w-xs sm:max-w-sm truncate text-xs text-zinc-200">
              <span className="font-medium text-zinc-400">Deleted</span>
              <span className="text-zinc-600" aria-hidden="true">
                ·
              </span>
              <span className="truncate font-semibold text-foreground">{undoToast.label}</span>
            </div>
            <button
              type="button"
              onClick={handleUndoDelete}
              className="flex items-center gap-1.5 rounded-lg bg-live/15 hover:bg-live/25 px-2.5 py-1 text-xs font-semibold text-live transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-live shrink-0 cursor-pointer"
            >
              <RotateCcw className="size-3" />
              <span>Undo</span>
            </button>
            <button
              type="button"
              onClick={() => setUndoToast(null)}
              aria-label="Dismiss notification"
              className="rounded p-1 text-zinc-400 hover:text-zinc-200 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-live cursor-pointer shrink-0"
            >
              <X className="size-3.5" />
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}

export default ScheduleTab;
