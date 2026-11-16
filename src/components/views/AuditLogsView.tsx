import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Download,
  Eye,
  FileJson,
  FileSpreadsheet,
  History,
  RotateCcw,
  Search,
  ShieldAlert,
  X,
  XCircle,
} from 'lucide-react';
import { useHub } from '../../context/HubContext';
import { formatFirestoreDate, getUpdatedAtMs } from '../../lib/firestore-service';
import type { AuditLog } from '../../types/hub';

const ACTION_LABELS: Record<string, string> = {
  create: 'إضافة',
  update: 'تعديل',
  delete: 'حذف',
  import: 'استيراد',
  restore: 'استعادة',
};

const RESULT_LABELS: Record<string, string> = {
  success: 'ناجحة',
  blocked: 'محظورة',
  failed: 'فشلت',
};

const ROLE_LABELS: Record<string, string> = {
  sensitive_admin: 'مدير نظام (Tier 1)',
  operational_admin: 'مدير تشغيلي (Tier 2)',
  employee: 'موظف',
};

function escapeCsvCell(value: unknown): string {
  const s = String(value ?? '').replace(/"/g, '""');
  return `"${s}"`;
}

function triggerDownload(content: string, mimeType: string, filename: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function AuditLogsView() {
  const { auditLogs, isSensitiveAdmin, notify } = useHub();
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('all');
  const [sectionFilter, setSectionFilter] = useState('all');
  const [actorFilter, setActorFilter] = useState('all');
  const [resultFilter, setResultFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  const uniqueSections = useMemo(() => {
    return Array.from(new Set(auditLogs.map((l) => l.section).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b, 'ar')
    );
  }, [auditLogs]);

  const uniqueActors = useMemo(() => {
    return Array.from(new Set(auditLogs.map((l) => l.actorEmail).filter(Boolean))).sort();
  }, [auditLogs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromMs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toMs = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null;

    return auditLogs.filter((log) => {
      if (actionFilter !== 'all' && log.actionType !== actionFilter) return false;
      if (sectionFilter !== 'all' && log.section !== sectionFilter) return false;
      if (actorFilter !== 'all' && log.actorEmail !== actorFilter) return false;
      const effectiveResult = log.result || 'success';
      if (resultFilter !== 'all' && effectiveResult !== resultFilter) return false;

      if (fromMs !== null || toMs !== null) {
        const createdMs = getUpdatedAtMs(log.createdAt);
        if (!createdMs) return false;
        if (fromMs !== null && createdMs < fromMs) return false;
        if (toMs !== null && createdMs > toMs) return false;
      }

      if (!q) return true;
      return (
        log.actorName.toLowerCase().includes(q) ||
        log.actorEmail.toLowerCase().includes(q) ||
        log.section.toLowerCase().includes(q) ||
        log.itemName.toLowerCase().includes(q) ||
        log.summary.toLowerCase().includes(q)
      );
    });
  }, [auditLogs, search, actionFilter, sectionFilter, actorFilter, resultFilter, dateFrom, dateTo]);

  if (!isSensitiveAdmin) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-900/50 bg-[var(--hub-surface)] p-8 text-center text-sm text-red-800 dark:text-red-300 space-y-2">
        <ShieldAlert className="w-7 h-7 mx-auto text-red-600 dark:text-red-400" />
        <div className="font-bold">هذا القسم مخصص للمديرين الحساسين (Tier 1) فقط.</div>
      </div>
    );
  }

  const resetFilters = () => {
    setSearch('');
    setActionFilter('all');
    setSectionFilter('all');
    setActorFilter('all');
    setResultFilter('all');
    setDateFrom('');
    setDateTo('');
  };

  const handleExportCsv = () => {
    if (filtered.length === 0) {
      notify('error', 'لا توجد سجلات مطابقة لتصديرها.');
      return;
    }
    const headers = [
      'المعرف',
      'التاريخ والوقت',
      'المنفذ',
      'البريد الإلكتروني',
      'الدور',
      'العملية',
      'النتيجة',
      'القسم',
      'العنصر',
      'الملخص',
    ];
    const rows = filtered.map((log) =>
      [
        escapeCsvCell(log.id),
        escapeCsvCell(formatFirestoreDate(log.createdAt)),
        escapeCsvCell(log.actorName),
        escapeCsvCell(log.actorEmail),
        escapeCsvCell(ROLE_LABELS[log.actorRole || ''] || log.actorRole || 'مدير'),
        escapeCsvCell(ACTION_LABELS[log.actionType] || log.actionType),
        escapeCsvCell(RESULT_LABELS[log.result || 'success'] || log.result || 'ناجحة'),
        escapeCsvCell(log.section),
        escapeCsvCell(log.itemName),
        escapeCsvCell(log.summary),
      ].join(',')
    );
    const csv = '\uFEFF' + [headers.map(escapeCsvCell).join(','), ...rows].join('\n');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    triggerDownload(csv, 'text/csv;charset=utf-8', `mashaer-audit-logs-${stamp}.csv`);
    notify('success', `تم تصدير ${filtered.length} سجل بصيغة CSV.`);
  };

  const handleExportJson = () => {
    if (filtered.length === 0) {
      notify('error', 'لا توجد سجلات مطابقة لتصديرها.');
      return;
    }
    const exported = filtered.map((log) => ({
      ...log,
      createdAtFormatted: formatFirestoreDate(log.createdAt),
    }));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    triggerDownload(
      JSON.stringify(exported, null, 2),
      'application/json;charset=utf-8',
      `mashaer-audit-logs-${stamp}.json`
    );
    notify('success', `تم تصدير ${filtered.length} سجل بصيغة JSON.`);
  };

  const hasActiveFilter =
    Boolean(search.trim()) ||
    actionFilter !== 'all' ||
    sectionFilter !== 'all' ||
    actorFilter !== 'all' ||
    resultFilter !== 'all' ||
    Boolean(dateFrom) ||
    Boolean(dateTo);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-[var(--hub-heading)]">سجل التعديلات – للمديرين الحساسين (Tier 1) فقط</h1>
          <p className="text-xs text-[var(--hub-muted)] mt-1">
            سجل غير قابل للتعديل أو الحذف في قواعد Firestore؛ يوثق تلقائياً جميع عمليات الإضافة والتعديل والحذف والاستيراد والاستعادة.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] px-3 py-2 text-xs font-semibold text-[var(--hub-heading)] hover:bg-[var(--hub-surface-alt)] cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-[var(--hub-accent)]" />
            <span>تصدير CSV</span>
          </button>
          <button
            type="button"
            onClick={handleExportJson}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] px-3 py-2 text-xs font-semibold text-[var(--hub-heading)] hover:bg-[var(--hub-surface-alt)] cursor-pointer"
          >
            <FileJson className="w-3.5 h-3.5 text-[var(--hub-accent)]" />
            <span>تصدير JSON</span>
          </button>
        </div>
      </div>

      {/* Filters Panel */}
      <div className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-surface)] p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-[var(--hub-accent)] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث باسم المدير أو الإيميل أو القسم أو العنصر أو الملخص..."
              className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-text)] placeholder:text-[var(--hub-muted)] pr-9 pl-4 py-2 text-sm focus:outline-none focus:border-[var(--hub-accent)]"
            />
          </div>

          {hasActiveFilter && (
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-xs font-semibold text-[var(--hub-heading)] hover:bg-[var(--hub-surface-alt)] cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>مسح الفلاتر</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5 text-xs">
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-text)] px-3 py-2"
          >
            <option value="all">جميع العمليات</option>
            <option value="create">إضافة</option>
            <option value="update">تعديل</option>
            <option value="delete">حذف</option>
            <option value="import">استيراد</option>
            <option value="restore">استعادة</option>
          </select>

          <select
            value={sectionFilter}
            onChange={(e) => setSectionFilter(e.target.value)}
            className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-text)] px-3 py-2"
          >
            <option value="all">جميع الأقسام</option>
            {uniqueSections.map((sec) => (
              <option key={sec} value={sec}>{sec}</option>
            ))}
          </select>

          <select
            value={actorFilter}
            onChange={(e) => setActorFilter(e.target.value)}
            dir="ltr"
            className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-text)] px-3 py-2"
          >
            <option value="all">All Actors (جميع المنفذين)</option>
            {uniqueActors.map((actor) => (
              <option key={actor} value={actor}>{actor}</option>
            ))}
          </select>

          <select
            value={resultFilter}
            onChange={(e) => setResultFilter(e.target.value)}
            className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-text)] px-3 py-2"
          >
            <option value="all">جميع النتائج</option>
            <option value="success">ناجحة</option>
            <option value="blocked">محظورة</option>
            <option value="failed">فشلت</option>
          </select>

          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            aria-label="من تاريخ"
            className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-text)] px-3 py-2"
          />

          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            aria-label="إلى تاريخ"
            className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-text)] px-3 py-2"
          />
        </div>

        <div className="flex items-center justify-between text-[11px] text-[var(--hub-muted)] tabular-nums">
          <span>المعروض: {filtered.length} من أصل {auditLogs.length} سجل</span>
          <span>السجلات محمية ضد الحذف والتعديل (Append-Only)</span>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-surface)] p-10 text-center text-sm text-[var(--hub-muted)]">
          <History className="w-8 h-8 text-[var(--hub-accent)] mx-auto mb-2" />
          لا توجد سجلات مطابقة لمعايير التصفية الحالية.
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((log) => {
            const effectiveResult = log.result || 'success';
            return (
              <article key={log.id} className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-surface)] p-4 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--hub-muted)]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-[var(--hub-heading)]">
                      {ACTION_LABELS[log.actionType] || log.actionType}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-semibold text-[var(--hub-accent)]">{log.section}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono-tabular text-[var(--hub-text)]" dir="ltr">
                      {log.actorEmail}
                    </span>
                    <span>({log.actorName})</span>
                    {log.actorRole && (
                      <span className="rounded-md bg-[var(--hub-bg)] border border-[var(--hub-border)] px-2 py-0.5 text-[11px] text-[var(--hub-heading)]">
                        {ROLE_LABELS[log.actorRole] || log.actorRole}
                      </span>
                    )}
                    <span
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                        effectiveResult === 'success'
                          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : effectiveResult === 'blocked'
                            ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300'
                            : 'bg-red-500/10 text-red-700 dark:text-red-300'
                      }`}
                    >
                      {effectiveResult === 'success' ? (
                        <CheckCircle2 className="w-3 h-3" />
                      ) : (
                        <XCircle className="w-3 h-3" />
                      )}
                      <span>{RESULT_LABELS[effectiveResult] || effectiveResult}</span>
                    </span>
                  </div>
                  <span className="tabular-nums">{formatFirestoreDate(log.createdAt)}</span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-[var(--hub-text)]">{log.itemName}</div>
                    <div className="text-xs text-[var(--hub-muted)] mt-0.5">{log.summary}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedLog(log)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-1.5 text-xs font-medium text-[var(--hub-heading)] hover:bg-[var(--hub-surface-alt)] cursor-pointer"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>تفاصيل الفروقات</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Details / Diff Modal */}
      {selectedLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl border border-[var(--hub-accent-soft)] bg-[var(--hub-surface)] shadow-xl overflow-hidden">
            <div className="flex items-center justify-between p-5 border-b border-[var(--hub-border)]">
              <div>
                <h3 className="text-base font-bold text-[var(--hub-heading)]">تفاصيل سجل التدقيق</h3>
                <p className="text-xs text-[var(--hub-muted)] mt-0.5 tabular-nums">
                  {selectedLog.section} · {formatFirestoreDate(selectedLog.createdAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedLog(null)}
                className="p-1 text-[var(--hub-muted)] hover:text-[var(--hub-heading)] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-xl bg-[var(--hub-bg)] border border-[var(--hub-border)] p-3.5">
                <div>
                  <span className="text-[var(--hub-muted)]">المنفذ: </span>
                  <strong className="text-[var(--hub-heading)]">{selectedLog.actorName}</strong>{' '}
                  <span className="font-mono-tabular" dir="ltr">({selectedLog.actorEmail})</span>
                </div>
                <div>
                  <span className="text-[var(--hub-muted)]">الدور: </span>
                  <strong className="text-[var(--hub-heading)]">
                    {ROLE_LABELS[selectedLog.actorRole || ''] || selectedLog.actorRole || 'مدير'}
                  </strong>
                </div>
                <div>
                  <span className="text-[var(--hub-muted)]">نوع العملية: </span>
                  <strong className="text-[var(--hub-heading)]">
                    {ACTION_LABELS[selectedLog.actionType] || selectedLog.actionType}
                  </strong>
                </div>
                <div>
                  <span className="text-[var(--hub-muted)]">النتيجة: </span>
                  <strong className="text-[var(--hub-heading)]">
                    {RESULT_LABELS[selectedLog.result || 'success'] || selectedLog.result || 'ناجحة'}
                  </strong>
                </div>
                <div className="sm:col-span-2">
                  <span className="text-[var(--hub-muted)]">العنصر: </span>
                  <strong className="text-[var(--hub-heading)]">{selectedLog.itemName}</strong>
                  {selectedLog.itemId && (
                    <span className="font-mono-tabular text-[var(--hub-muted)] mr-2" dir="ltr">
                      #{selectedLog.itemId}
                    </span>
                  )}
                </div>
                <div className="sm:col-span-2">
                  <span className="text-[var(--hub-muted)]">الملخص: </span>
                  <span className="text-[var(--hub-text)]">{selectedLog.summary}</span>
                </div>
              </div>

              {(selectedLog.previousValue || selectedLog.newValue) ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <div className="font-semibold text-[var(--hub-heading)]">القيمة السابقة</div>
                    <pre
                      className="rounded-lg bg-[var(--hub-bg)] border border-[var(--hub-border)] text-[var(--hub-text)] p-3 overflow-x-auto max-h-72 text-[11px] font-mono-tabular"
                      dir="ltr"
                    >
                      {selectedLog.previousValue || '— (سجل جديد)'}
                    </pre>
                  </div>
                  <div className="space-y-1.5">
                    <div className="font-semibold text-[var(--hub-heading)]">القيمة الجديدة</div>
                    <pre
                      className="rounded-lg bg-[var(--hub-bg)] border border-[var(--hub-border)] text-[var(--hub-text)] p-3 overflow-x-auto max-h-72 text-[11px] font-mono-tabular"
                      dir="ltr"
                    >
                      {selectedLog.newValue || '— (تم الحذف أو بدون حقول)'}
                    </pre>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] p-4 text-center text-[var(--hub-muted)]">
                  لا تتوفر لقطات JSON مقارنة لهذه العملية.
                </div>
              )}
            </div>

            <div className="flex items-center justify-between p-4 border-t border-[var(--hub-border)] bg-[var(--hub-bg)]">
              <button
                type="button"
                onClick={() => {
                  triggerDownload(
                    JSON.stringify(selectedLog, null, 2),
                    'application/json;charset=utf-8',
                    `audit-${selectedLog.id}.json`
                  );
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] text-xs font-semibold text-[var(--hub-heading)] cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>تنزيل هذا السجل JSON</span>
              </button>
              <button
                type="button"
                onClick={() => setSelectedLog(null)}
                className="px-4 py-1.5 rounded-lg bg-[var(--hub-button)] text-xs font-semibold text-[var(--hub-button-text)] cursor-pointer"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
