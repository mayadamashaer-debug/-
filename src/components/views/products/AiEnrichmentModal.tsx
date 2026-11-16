import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ExternalLink,
  Globe,
  Lock,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Store,
  X,
} from 'lucide-react';
import { parseFriendlyFirestoreError } from '../../../lib/firebase';
import { saveProduct } from '../../../lib/firestore-service';
import {
  AI_FIELD_LABELS,
  applyAcceptedAiDraftToProductInput,
  clearBatchCheckpoint,
  getProductAiFieldCurrentValue,
  isAiFieldManuallyLocked,
  loadBatchCheckpoint,
  pushUndoSnapshot,
  requestProductAiEnrichment,
  saveBatchCheckpoint,
  type AiFieldKey,
  type BatchEnrichmentCheckpoint,
  type ProductEnrichmentDraft,
} from '../../../lib/product-ai-storage';
import {
  calculateProductCompleteness,
  CONFIDENCE_LABELS,
  isFilledFragranceValue,
  SOURCE_TYPE_META,
} from '../../../lib/product-utils';
import type { Product } from '../../../types/hub';

interface AiEnrichmentModalProps {
  open: boolean;
  products: Product[];
  initialScope: 'single' | 'selected' | 'all_incomplete';
  initialProduct?: Product | null;
  selectedProductIds?: string[];
  onClose: () => void;
  onNotify: (type: 'success' | 'error' | 'info', msg: string) => void;
  onRunTrackedMutation: <T>(fn: () => Promise<T>) => Promise<T>;
  onSavedProduct: (updatedId: string) => void;
}

const ORDERED_AI_KEYS: AiFieldKey[] = [
  'officialDescription',
  'fragranceFamily',
  'fragranceCharacter',
  'perfumeType',
  'concentration',
  'topNotes',
  'heartNotes',
  'baseNotes',
  'notesAndIngredients',
  'longevity',
  'sillage',
  'sillageReach',
  'sillageDuration',
  'usageType',
  'occasionUsage',
  'seasons',
  'timeOfDay',
  'targetAudience',
  'usageInstructions',
  'layeringSuggestions',
  'extraInfo',
];

export function AiEnrichmentModal({
  open,
  products,
  initialScope,
  initialProduct,
  selectedProductIds = [],
  onClose,
  onNotify,
  onRunTrackedMutation,
  onSavedProduct,
}: AiEnrichmentModalProps) {
  const [scope, setScope] = useState<'single' | 'selected' | 'all_incomplete'>(initialScope);
  const [singleTargetId, setSingleTargetId] = useState<string>(initialProduct?.id || '');
  const [useOfficialFetch, setUseOfficialFetch] = useState(true);
  const [useWebSearch, setUseWebSearch] = useState(true);
  const [skipComplete, setSkipComplete] = useState(true);
  const [bypassCache, setBypassCache] = useState(false);

  const [savedCheckpoint, setSavedCheckpoint] = useState<BatchEnrichmentCheckpoint | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const abortFlagRef = useRef(false);

  const [queueIds, setQueueIds] = useState<string[]>([]);
  const [completedIds, setCompletedIds] = useState<string[]>([]);
  const [failedMap, setFailedMap] = useState<Record<string, string>>({});
  const [draftsByProductId, setDraftsByProductId] = useState<Record<string, ProductEnrichmentDraft>>({});
  const [activeReviewId, setActiveReviewId] = useState<string>('');

  // Per-field interactive review states for activeReviewProduct
  const [acceptedByProduct, setAcceptedByProduct] = useState<Record<string, Record<string, boolean>>>({});
  const [editedByProduct, setEditedByProduct] = useState<Record<string, Partial<Record<AiFieldKey, string>>>>({});
  const [acceptAltsByProduct, setAcceptAltsByProduct] = useState<Record<string, boolean>>({});
  const [regeneratingKey, setRegeneratingKey] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    setScope(initialScope);
    if (initialProduct) {
      setSingleTargetId(initialProduct.id);
    } else if (!singleTargetId && products[0]) {
      setSingleTargetId(products[0].id);
    }
    const existingCp = loadBatchCheckpoint();
    setSavedCheckpoint(existingCp);
    abortFlagRef.current = false;
  }, [open, initialScope, initialProduct?.id]);

  const targetQueuePreview = useMemo(() => {
    if (scope === 'single') {
      const p = products.find((item) => item.id === singleTargetId);
      return p ? [p] : [];
    }
    if (scope === 'selected') {
      const set = new Set(selectedProductIds);
      return products.filter((p) => set.has(p.id));
    }
    if (skipComplete) {
      return products.filter((p) => !calculateProductCompleteness(p).isComplete);
    }
    return products;
  }, [scope, singleTargetId, selectedProductIds, skipComplete, products]);

  const activeDraft = activeReviewId ? draftsByProductId[activeReviewId] : undefined;
  const activeProduct = useMemo(
    () => products.find((p) => p.id === activeReviewId) || null,
    [products, activeReviewId]
  );

  const initReviewSelectionForDraft = (product: Product, draft: ProductEnrichmentDraft) => {
    const initialAccepted: Record<string, boolean> = {};
    const initialEdited: Partial<Record<AiFieldKey, string>> = {};

    for (const key of ORDERED_AI_KEYS) {
      const suggestion = draft.fields[key];
      if (!suggestion?.value) continue;
      const currentVal = getProductAiFieldCurrentValue(product, key).trim();
      // Strictly avoid proposing overwrites for already filled fields
      if (isFilledFragranceValue(currentVal)) continue;
      initialEdited[key] = suggestion.value;
      const isLocked = isAiFieldManuallyLocked(product, key);
      // Auto-select un-locked missing fields with meaningful values; keep manually locked & "غير محدد" unchecked by default
      initialAccepted[key] = !isLocked && isFilledFragranceValue(suggestion.value);
    }

    setAcceptedByProduct((prev) => ({ ...prev, [product.id]: initialAccepted }));
    setEditedByProduct((prev) => ({ ...prev, [product.id]: initialEdited }));
    setAcceptAltsByProduct((prev) => ({ ...prev, [product.id]: true }));
  };

  const executeQueue = async (
    idsToRun: string[],
    initialCompleted: string[] = [],
    initialFailed: Record<string, string> = {},
    initialDrafts: Record<string, ProductEnrichmentDraft> = {},
    mode: BatchEnrichmentCheckpoint['mode'] = scope
  ) => {
    if (idsToRun.length === 0) {
      onNotify('info', 'لا توجد منتجات ناقصة تحتاج إلى استكمال ضمن النطاق المحدد.');
      return;
    }

    setIsRunning(true);
    abortFlagRef.current = false;

    const doneList = [...initialCompleted];
    const failMap = { ...initialFailed };
    const draftsMap = { ...initialDrafts };

    setQueueIds(idsToRun);
    setCompletedIds(doneList);
    setFailedMap(failMap);
    setDraftsByProductId(draftsMap);

    const remaining = idsToRun.filter((id) => !doneList.includes(id));

    for (const pid of remaining) {
      if (abortFlagRef.current) break;

      const prod = products.find((p) => p.id === pid);
      if (!prod) continue;

      try {
        const draft = await requestProductAiEnrichment({
          product: prod,
          allProducts: products,
          useOfficialFetch,
          useWebSearch,
          bypassCache,
        });
        draftsMap[pid] = draft;
        delete failMap[pid];
        doneList.push(pid);
        initReviewSelectionForDraft(prod, draft);

        setDraftsByProductId({ ...draftsMap });
        setCompletedIds([...doneList]);
        setFailedMap({ ...failMap });
        setActiveReviewId((prev) => prev || pid);

        saveBatchCheckpoint({
          mode,
          queueIds: idsToRun,
          completedIds: doneList,
          skippedIds: [],
          failedMap: failMap,
          draftsByProductId: draftsMap,
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'حدث خطأ أثناء معالجة المنتج';
        failMap[pid] = msg;
        setFailedMap({ ...failMap });

        saveBatchCheckpoint({
          mode,
          queueIds: idsToRun,
          completedIds: doneList,
          skippedIds: [],
          failedMap: failMap,
          draftsByProductId: draftsMap,
          updatedAt: new Date().toISOString(),
        });

        // Stop batch immediately on API key error or rate limit so user can resume cleanly
        if (msg.includes('Gemini API') || msg.includes('حد الطلبات') || msg.includes('429') || msg.includes('403')) {
          onNotify('error', msg);
          break;
        }
      }
    }

    setIsRunning(false);
    setSavedCheckpoint(loadBatchCheckpoint());
    if (!abortFlagRef.current && doneList.length === idsToRun.length) {
      onNotify('success', `تم تحليل وتجهيز مقترحات ${doneList.length} منتجاً. راجع النتائج قبل الحفظ.`);
    }
  };

  const handleStartFresh = () => {
    const ids = targetQueuePreview.map((p) => p.id);
    setSavedIds({});
    setActiveReviewId('');
    executeQueue(ids, [], {}, {}, scope);
  };

  const handleResumeCheckpoint = () => {
    if (!savedCheckpoint) return;
    // Restore drafts into review UI state
    for (const [pid, draft] of Object.entries(savedCheckpoint.draftsByProductId || {})) {
      const prod = products.find((p) => p.id === pid);
      if (prod && !acceptedByProduct[pid]) {
        initReviewSelectionForDraft(prod, draft);
      }
    }
    const firstReady = savedCheckpoint.completedIds[0] || '';
    if (firstReady) setActiveReviewId(firstReady);
    executeQueue(
      savedCheckpoint.queueIds,
      savedCheckpoint.completedIds,
      savedCheckpoint.failedMap,
      savedCheckpoint.draftsByProductId,
      savedCheckpoint.mode
    );
  };

  const handleLoadSavedDraftsOnly = () => {
    if (!savedCheckpoint) return;
    setQueueIds(savedCheckpoint.queueIds);
    setCompletedIds(savedCheckpoint.completedIds);
    setFailedMap(savedCheckpoint.failedMap);
    setDraftsByProductId(savedCheckpoint.draftsByProductId);
    for (const [pid, draft] of Object.entries(savedCheckpoint.draftsByProductId || {})) {
      const prod = products.find((p) => p.id === pid);
      if (prod) initReviewSelectionForDraft(prod, draft);
    }
    const firstId = Object.keys(savedCheckpoint.draftsByProductId || {})[0];
    if (firstId) setActiveReviewId(firstId);
  };

  const handleRegenerateSingleField = async (product: Product, fieldKey: AiFieldKey) => {
    setRegeneratingKey(`${product.id}:${fieldKey}`);
    try {
      const partialDraft = await requestProductAiEnrichment({
        product,
        allProducts: products,
        regenerateField: fieldKey,
        useOfficialFetch,
        useWebSearch,
        bypassCache: true,
      });
      const newEntry = partialDraft.fields[fieldKey];
      if (!newEntry?.value) {
        onNotify('info', `لم يجد الذكاء الاصطناعي قيمة إضافية لحقل «${AI_FIELD_LABELS[fieldKey]}».`);
        return;
      }
      setDraftsByProductId((prev) => {
        const current = prev[product.id];
        if (!current) return prev;
        return {
          ...prev,
          [product.id]: {
            ...current,
            fields: { ...current.fields, [fieldKey]: newEntry },
          },
        };
      });
      setEditedByProduct((prev) => ({
        ...prev,
        [product.id]: { ...(prev[product.id] || {}), [fieldKey]: newEntry.value },
      }));
      setAcceptedByProduct((prev) => ({
        ...prev,
        [product.id]: { ...(prev[product.id] || {}), [fieldKey]: true },
      }));
      onNotify('success', `تم إعادة توليد «${AI_FIELD_LABELS[fieldKey]}».`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر إعادة توليد الحقل');
    } finally {
      setRegeneratingKey(null);
    }
  };

  const handleApproveAndSaveProduct = async (product: Product, draft: ProductEnrichmentDraft) => {
    const acceptedMap = acceptedByProduct[product.id] || {};
    const acceptedKeys = ORDERED_AI_KEYS.filter((k) => acceptedMap[k]);
    const acceptAlts = acceptAltsByProduct[product.id] ?? true;

    if (acceptedKeys.length === 0 && (!acceptAlts || draft.suggestedAlternativeIds.length === 0)) {
      onNotify('info', 'اختر حقلاً واحداً على الأقل لقبوله وحفظه.');
      return;
    }

    setSavingId(product.id);
    try {
      const { productPayload, aiAppliedFields } = applyAcceptedAiDraftToProductInput({
        product,
        allProducts: products,
        draft,
        acceptedKeys,
        editedValues: editedByProduct[product.id] || {},
        acceptAlternatives: acceptAlts,
      });

      // Store Undo snapshot before overwriting cloud document
      pushUndoSnapshot(
        product,
        `استكمال ذكي (${acceptedKeys.length} حقل)`
      );

      await onRunTrackedMutation(() =>
        saveProduct(productPayload, product, {
          forceOverwrite: true,
          aiAppliedFields,
        })
      );

      setSavedIds((prev) => ({ ...prev, [product.id]: true }));
      onSavedProduct(product.id);
      onNotify('success', `تم اعتماد وحفظ بيانات «${product.nameAr}» في Firestore.`);
    } catch (err) {
      onNotify('error', parseFriendlyFirestoreError(err));
    } finally {
      setSavingId(null);
    }
  };

  if (!open) return null;

  const reviewedProductsList = queueIds
    .map((id) => products.find((p) => p.id === id))
    .filter((p): p is Product => Boolean(p));

  const readyDraftsCount = Object.keys(draftsByProductId).length;
  const remainingCount = Math.max(0, queueIds.length - completedIds.length);
  const progressPercent = queueIds.length > 0 ? Math.round((completedIds.length / queueIds.length) * 100) : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3 sm:p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-enrich-modal-title"
    >
      <div className="w-full max-w-6xl max-h-[92vh] overflow-y-auto rounded-2xl border border-[var(--hub-border)] bg-[var(--hub-surface)] shadow-2xl flex flex-col">
        {/* Sticky Header */}
        <div className="sticky top-0 z-10 bg-gradient-to-l from-[var(--hub-sidebar-alt)] via-[var(--hub-sidebar)] to-[var(--hub-sidebar-alt)] text-[var(--hub-sidebar-text)] px-5 sm:px-6 py-4 border-b-2 border-[var(--hub-sidebar-accent)]/50 flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="text-xs font-semibold text-[var(--hub-sidebar-accent)] flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 shrink-0" />
              <span>محرك الذكاء الاصطناعي والمصادر الرسمية — مراجعة واعتماد إداري</span>
            </div>
            <h2 id="ai-enrich-modal-title" className="font-display text-lg sm:text-xl font-bold">
              استكمال بيانات المنتجات بالذكاء الاصطناعي
            </h2>
          </div>

          <button
            type="button"
            onClick={() => {
              abortFlagRef.current = true;
              onClose();
            }}
            className="p-2 rounded-xl text-[var(--hub-sidebar-text)]/80 hover:bg-white/10 hover:text-[var(--hub-sidebar-text)] cursor-pointer"
            aria-label="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 sm:p-6 space-y-5">
          {/* Resume Saved Batch Checkpoint Banner */}
          {savedCheckpoint && !isRunning && queueIds.length === 0 && (
            <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50/90 dark:bg-amber-950/40 p-4 flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm">
              <div className="space-y-1 text-amber-950 dark:text-amber-100">
                <div className="font-bold flex items-center gap-1.5">
                  <RefreshCw className="w-4 h-4 text-amber-700 dark:text-amber-400" />
                  <span>يوجد تقدم محفوظ من عملية سابقة ({savedCheckpoint.completedIds.length}/{savedCheckpoint.queueIds.length})</span>
                </div>
                <div className="text-xs opacity-85 tabular-nums">
                  آخر تحديث: {new Date(savedCheckpoint.updatedAt).toLocaleString('ar-KW')}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {savedCheckpoint.completedIds.length > 0 && (
                  <button
                    type="button"
                    onClick={handleLoadSavedDraftsOnly}
                    className="px-3 py-1.5 rounded-lg border border-amber-400/60 bg-[var(--hub-surface)] text-xs font-semibold text-[var(--hub-heading)] cursor-pointer"
                  >
                    عرض المسودات الجاهزة ({Object.keys(savedCheckpoint.draftsByProductId || {}).length})
                  </button>
                )}
                {savedCheckpoint.completedIds.length < savedCheckpoint.queueIds.length && (
                  <button
                    type="button"
                    onClick={handleResumeCheckpoint}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[var(--hub-button)] text-[var(--hub-button-text)] text-xs font-semibold cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>استكمال من آخر نقطة توقف</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    clearBatchCheckpoint();
                    setSavedCheckpoint(null);
                  }}
                  className="px-2.5 py-1.5 rounded-lg text-xs text-red-700 dark:text-red-400 hover:underline cursor-pointer"
                >
                  تجاهل
                </button>
              </div>
            </div>
          )}

          {/* Setup / Scope Panel */}
          <div className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)] p-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <button
                type="button"
                disabled={isRunning}
                onClick={() => setScope('single')}
                className={`rounded-xl border p-3 text-right transition-colors cursor-pointer ${
                  scope === 'single'
                    ? 'border-[var(--hub-accent)] bg-[var(--hub-surface)] ring-1 ring-[var(--hub-accent-soft)]/50'
                    : 'border-[var(--hub-border)] bg-[var(--hub-surface)]/50 hover:border-[var(--hub-accent-soft)]'
                }`}
              >
                <div className="text-xs font-bold text-[var(--hub-heading)]">1. استكمال منتج واحد</div>
                <div className="text-[11px] text-[var(--hub-muted)] mt-0.5">تحليل وبحث وتوليد مسودة لمنتج محدد</div>
              </button>

              <button
                type="button"
                disabled={isRunning || selectedProductIds.length === 0}
                onClick={() => setScope('selected')}
                className={`rounded-xl border p-3 text-right transition-colors cursor-pointer disabled:opacity-50 ${
                  scope === 'selected'
                    ? 'border-[var(--hub-accent)] bg-[var(--hub-surface)] ring-1 ring-[var(--hub-accent-soft)]/50'
                    : 'border-[var(--hub-border)] bg-[var(--hub-surface)]/50 hover:border-[var(--hub-accent-soft)]'
                }`}
              >
                <div className="text-xs font-bold text-[var(--hub-heading)]">
                  2. المجموعة المحددة ({selectedProductIds.length})
                </div>
                <div className="text-[11px] text-[var(--hub-muted)] mt-0.5">
                  {selectedProductIds.length > 0
                    ? `معالجة ${selectedProductIds.length} منتج مختار`
                    : 'فعّل «تحديد مجموعة» في الصفحة لاختيار منتجات'}
                </div>
              </button>

              <button
                type="button"
                disabled={isRunning}
                onClick={() => setScope('all_incomplete')}
                className={`rounded-xl border p-3 text-right transition-colors cursor-pointer ${
                  scope === 'all_incomplete'
                    ? 'border-[var(--hub-accent)] bg-[var(--hub-surface)] ring-1 ring-[var(--hub-accent-soft)]/50'
                    : 'border-[var(--hub-border)] bg-[var(--hub-surface)]/50 hover:border-[var(--hub-accent-soft)]'
                }`}
              >
                <div className="text-xs font-bold text-[var(--hub-heading)]">3. كافة المنتجات الناقصة</div>
                <div className="text-[11px] text-[var(--hub-muted)] mt-0.5">
                  تنفيذ تدريجي يحفظ التقدم بعد كل منتج
                </div>
              </button>
            </div>

            {scope === 'single' && (
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-xs font-semibold text-[var(--hub-heading)]">اختر المنتج المستهدف:</label>
                <select
                  disabled={isRunning}
                  value={singleTargetId}
                  onChange={(e) => setSingleTargetId(e.target.value)}
                  className="flex-1 min-w-[240px] rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] px-3 py-2 text-xs sm:text-sm text-[var(--hub-text)]"
                >
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nameAr} — اكتمال {calculateProductCompleteness(p).percent}%
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[var(--hub-border)] text-xs">
              <div className="flex flex-wrap items-center gap-4">
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-[var(--hub-heading)]">
                  <input
                    type="checkbox"
                    disabled={isRunning}
                    checked={useOfficialFetch}
                    onChange={(e) => setUseOfficialFetch(e.target.checked)}
                    className="accent-[var(--hub-accent)] w-4 h-4"
                  />
                  <Store className="w-3.5 h-3.5 text-[var(--hub-accent)]" />
                  <span>فحص صفحة المتجر الرسمية</span>
                </label>

                <label className="inline-flex items-center gap-1.5 cursor-pointer text-[var(--hub-heading)]">
                  <input
                    type="checkbox"
                    disabled={isRunning}
                    checked={useWebSearch}
                    onChange={(e) => setUseWebSearch(e.target.checked)}
                    className="accent-[var(--hub-accent)] w-4 h-4"
                  />
                  <Globe className="w-3.5 h-3.5 text-[var(--hub-accent)]" />
                  <span>بحث المصادر العطرية الموثوقة</span>
                </label>

                {scope === 'all_incomplete' && (
                  <label className="inline-flex items-center gap-1.5 cursor-pointer text-[var(--hub-heading)]">
                    <input
                      type="checkbox"
                      disabled={isRunning}
                      checked={skipComplete}
                      onChange={(e) => setSkipComplete(e.target.checked)}
                      className="accent-[var(--hub-accent)] w-4 h-4"
                    />
                    <span>تخطي المنتجات المكتملة 100%</span>
                  </label>
                )}

                <label className="inline-flex items-center gap-1.5 cursor-pointer text-[var(--hub-muted)]">
                  <input
                    type="checkbox"
                    disabled={isRunning}
                    checked={bypassCache}
                    onChange={(e) => setBypassCache(e.target.checked)}
                    className="accent-[var(--hub-accent)] w-4 h-4"
                  />
                  <span>تجاهل الكاش وإعادة الجلب</span>
                </label>
              </div>

              <div className="flex items-center gap-2">
                {isRunning ? (
                  <button
                    type="button"
                    onClick={() => {
                      abortFlagRef.current = true;
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-600 text-white font-semibold cursor-pointer"
                  >
                    <Pause className="w-4 h-4" />
                    <span>إيقاف مؤقت مع حفظ التقدم</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleStartFresh}
                    disabled={targetQueuePreview.length === 0}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[var(--hub-button)] text-[var(--hub-button-text)] font-semibold hover:bg-[var(--hub-button-hover)] cursor-pointer disabled:opacity-50"
                  >
                    <Sparkles className="w-4 h-4" />
                    <span>بدء التحليل ({targetQueuePreview.length} منتج)</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Live Batch Progress */}
          {queueIds.length > 0 && (
            <div className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-surface-alt)]/45 p-4 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-[var(--hub-heading)] tabular-nums">
                <span>
                  {isRunning ? 'جاري التحليل التسلسلي الآمن...' : 'حالة الدفعة:'} تم معالجة{' '}
                  <strong className="text-[var(--hub-accent)]">{completedIds.length}</strong> من{' '}
                  {queueIds.length} ({progressPercent}%)
                  {Object.keys(failedMap).length > 0 && (
                    <span className="text-red-600 dark:text-red-400 mr-2">
                      · تعذر {Object.keys(failedMap).length}
                    </span>
                  )}
                </span>
                {remainingCount > 0 && !isRunning && (
                  <button
                    type="button"
                    onClick={() => executeQueue(queueIds, completedIds, failedMap, draftsByProductId, scope)}
                    className="inline-flex items-center gap-1 text-[var(--hub-accent)] hover:underline cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>استئناف المتبقي ({remainingCount})</span>
                  </button>
                )}
              </div>

              <div className="h-2 rounded-full bg-[var(--hub-border)] overflow-hidden">
                <div
                  className="h-full bg-[var(--hub-accent)] transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>

              {reviewedProductsList.length > 1 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {reviewedProductsList.map((p) => {
                    const hasDraft = Boolean(draftsByProductId[p.id]);
                    const isFailed = Boolean(failedMap[p.id]);
                    const isDoneSaved = Boolean(savedIds[p.id]);
                    const isActive = activeReviewId === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => hasDraft && setActiveReviewId(p.id)}
                        disabled={!hasDraft}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs cursor-pointer transition-colors disabled:opacity-50 ${
                          isActive
                            ? 'border-[var(--hub-accent)] bg-[var(--hub-button)] text-[var(--hub-button-text)] font-bold'
                            : isDoneSaved
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                              : isFailed
                                ? 'border-red-300 bg-red-50 text-red-700'
                                : 'border-[var(--hub-border)] bg-[var(--hub-surface)] text-[var(--hub-heading)]'
                        }`}
                      >
                        {isDoneSaved && <Check className="w-3 h-3" />}
                        <span>{p.nameAr}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Review Error Note if active product failed */}
          {Object.entries(failedMap).length > 0 && (
            <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30 p-3 text-xs text-red-900 dark:text-red-200 space-y-1">
              {Object.entries(failedMap).map(([pid, msg]) => {
                const pName = products.find((x) => x.id === pid)?.nameAr || pid;
                return (
                  <div key={pid} className="flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      <strong>{pName}:</strong> {msg}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Interactive Field-by-Field Review Area */}
          {activeProduct && activeDraft ? (
            <div className="rounded-2xl border border-[var(--hub-border)] bg-[var(--hub-bg)] p-4 sm:p-5 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-[var(--hub-border)]">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-bold text-[var(--hub-heading)]">
                      مراجعة مقترحات: {activeProduct.nameAr}
                    </h3>
                    {savedIds[activeProduct.id] && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 dark:bg-emerald-950 px-2 py-0.5 text-[11px] font-bold text-emerald-800 dark:text-emerald-300">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>تم الحفظ</span>
                      </span>
                    )}
                  </div>
                  {activeDraft.summaryNote && (
                    <p className="text-xs text-[var(--hub-muted)]">{activeDraft.summaryNote}</p>
                  )}
                  {activeDraft.sourcesUsed.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 text-[11px] pt-1">
                      <span className="text-[var(--hub-muted)] font-semibold">المصادر المفحوصة:</span>
                      {activeDraft.sourcesUsed.map((s, idx) => (
                        <a
                          key={idx}
                          href={s.uri}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[var(--hub-accent)] hover:underline"
                        >
                          <span>{s.title}</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const nextMap: Record<string, boolean> = {};
                      for (const key of ORDERED_AI_KEYS) {
                        const currentVal = getProductAiFieldCurrentValue(activeProduct, key);
                        if (
                          !isFilledFragranceValue(currentVal) &&
                          activeDraft.fields[key]?.value &&
                          !isAiFieldManuallyLocked(activeProduct, key)
                        ) {
                          nextMap[key] = true;
                        }
                      }
                      setAcceptedByProduct((prev) => ({ ...prev, [activeProduct.id]: nextMap }));
                    }}
                    className="px-3 py-1.5 rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] text-xs font-semibold text-[var(--hub-heading)] cursor-pointer"
                  >
                    تحديد كل الناقص غير المحمي
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setAcceptedByProduct((prev) => ({ ...prev, [activeProduct.id]: {} }))
                    }
                    className="px-3 py-1.5 rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] text-xs text-[var(--hub-muted)] cursor-pointer"
                  >
                    إلغاء التحديد
                  </button>
                  <button
                    type="button"
                    disabled={savingId === activeProduct.id}
                    onClick={() => handleApproveAndSaveProduct(activeProduct, activeDraft)}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[var(--hub-button)] text-[var(--hub-button-text)] text-xs font-bold cursor-pointer disabled:opacity-55"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>
                      {savingId === activeProduct.id ? 'جاري الحفظ...' : 'اعتماد وحفظ في Firestore'}
                    </span>
                  </button>
                </div>
              </div>

              <div className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] px-3 py-2 text-[11px] text-[var(--hub-muted)]">
                يقترح النظام الحقول الناقصة فقط للمراجعة قبل الحفظ، ولا يستبدل الحقول الممتلئة أو المحمية بالتعديل اليدوي.
              </div>

              {/* Fields Comparison Table / Cards */}
              <div className="space-y-3">
                {ORDERED_AI_KEYS.map((key) => {
                  const suggestion = activeDraft.fields[key];
                  if (!suggestion?.value) return null;

                  const currentVal = getProductAiFieldCurrentValue(activeProduct, key);
                  const hasEditedOverride = editedByProduct[activeProduct.id]?.[key] !== undefined;
                  if (isFilledFragranceValue(currentVal) && !hasEditedOverride) return null;

                  const isLocked = isAiFieldManuallyLocked(activeProduct, key);
                  const isAccepted = Boolean(acceptedByProduct[activeProduct.id]?.[key]);
                  const editedVal =
                    editedByProduct[activeProduct.id]?.[key] ?? suggestion.value;
                  const meta = SOURCE_TYPE_META[suggestion.sourceType];
                  const isRegenLoading = regeneratingKey === `${activeProduct.id}:${key}`;

                  return (
                    <div
                      key={key}
                      className={`rounded-xl border p-3.5 space-y-2.5 transition-colors ${
                        isAccepted
                          ? 'border-[var(--hub-accent-soft)] bg-[var(--hub-surface)]'
                          : 'border-[var(--hub-border)] bg-[var(--hub-surface)]/65 opacity-85'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="inline-flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isAccepted}
                            disabled={isLocked && editedVal.trim() === suggestion.value.trim()}
                            onChange={(e) =>
                              setAcceptedByProduct((prev) => ({
                                ...prev,
                                [activeProduct.id]: {
                                  ...(prev[activeProduct.id] || {}),
                                  [key]: e.target.checked,
                                },
                              }))
                            }
                            className="accent-[var(--hub-accent)] w-4 h-4"
                          />
                          <span className="text-xs sm:text-sm font-bold text-[var(--hub-heading)]">
                            {AI_FIELD_LABELS[key]}
                          </span>
                        </label>

                        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                          {isLocked && (
                            <span
                              className="inline-flex items-center gap-1 rounded-md border border-purple-300 bg-purple-50 dark:bg-purple-950/40 dark:border-purple-700 px-2 py-0.5 font-semibold text-purple-800 dark:text-purple-200"
                              title="تم تعديله يدوياً مسبقاً ومحمي من الكتابة التلقائية فوقه"
                            >
                              <Lock className="w-3 h-3" />
                              <span>محمي يدوياً</span>
                            </span>
                          )}
                          <span className={`inline-flex items-center rounded-md border px-2 py-0.5 font-semibold ${meta.badgeClass}`}>
                            {meta.shortLabel} · {CONFIDENCE_LABELS[suggestion.confidence]}
                          </span>
                          {suggestion.sourceUrl && (
                            <a
                              href={suggestion.sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[var(--hub-accent)] hover:underline px-1.5"
                            >
                              <span>الرابط</span>
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                          <button
                            type="button"
                            disabled={isRegenLoading || isRunning}
                            onClick={() => handleRegenerateSingleField(activeProduct, key)}
                            className="inline-flex items-center gap-1 rounded-md border border-[var(--hub-border)] bg-[var(--hub-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--hub-heading)] hover:border-[var(--hub-accent)] cursor-pointer disabled:opacity-50"
                          >
                            <RotateCcw className={`w-3 h-3 ${isRegenLoading ? 'animate-spin' : ''}`} />
                            <span>إعادة توليد</span>
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                        <div className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] p-2.5 space-y-1">
                          <div className="text-[11px] font-semibold text-[var(--hub-muted)]">القيمة الحالية في الدليل:</div>
                          <div className="text-[var(--hub-text)] whitespace-pre-wrap leading-relaxed">
                            {currentVal || <span className="text-[var(--hub-muted)] italic">فارغ / غير مسجل</span>}
                          </div>
                        </div>

                        <div className="space-y-1">
                          <div className="text-[11px] font-semibold text-[var(--hub-accent)]">
                            القيمة المقترحة (قابلة للتعديل المباشر قبل الحفظ):
                          </div>
                          {key === 'officialDescription' || key === 'notesAndIngredients' || key === 'extraInfo' || key === 'usageInstructions' ? (
                            <textarea
                              rows={2}
                              value={editedVal}
                              onChange={(e) =>
                                setEditedByProduct((prev) => ({
                                  ...prev,
                                  [activeProduct.id]: {
                                    ...(prev[activeProduct.id] || {}),
                                    [key]: e.target.value,
                                  },
                                }))
                              }
                              className="w-full rounded-lg border border-[var(--hub-accent-soft)]/70 bg-[var(--hub-bg)] px-2.5 py-2 text-xs text-[var(--hub-text)] leading-relaxed focus:outline-none focus:border-[var(--hub-accent)]"
                            />
                          ) : (
                            <input
                              value={editedVal}
                              onChange={(e) =>
                                setEditedByProduct((prev) => ({
                                  ...prev,
                                  [activeProduct.id]: {
                                    ...(prev[activeProduct.id] || {}),
                                    [key]: e.target.value,
                                  },
                                }))
                              }
                              className="w-full rounded-lg border border-[var(--hub-accent-soft)]/70 bg-[var(--hub-bg)] px-2.5 py-2 text-xs text-[var(--hub-text)] focus:outline-none focus:border-[var(--hub-accent)]"
                            />
                          )}
                          {suggestion.reason && (
                            <div className="text-[11px] text-[var(--hub-muted)] leading-snug">
                              ملاحظة المصدر: {suggestion.reason}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Suggested Alternatives Preview (Perfume-only enforced) */}
              {activeDraft.suggestedAlternativeIds.length > 0 && (
                <div className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-surface)] p-3.5 space-y-2">
                  <label className="inline-flex items-center gap-2 text-xs font-bold text-[var(--hub-heading)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={acceptAltsByProduct[activeProduct.id] ?? true}
                      onChange={(e) =>
                        setAcceptAltsByProduct((prev) => ({
                          ...prev,
                          [activeProduct.id]: e.target.checked,
                        }))
                      }
                      className="accent-[var(--hub-accent)] w-4 h-4"
                    />
                    <span>
                      اعتماد ربط البدائل المقترحة من نفس الفئة (تم استبعاد السبراي والمعطرات تماماً للعطور):
                    </span>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {activeDraft.suggestedAlternativeIds.map((id) => {
                      const alt = products.find((p) => p.id === id);
                      if (!alt) return null;
                      return (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-2.5 py-1 text-xs font-semibold text-[var(--hub-heading)]"
                        >
                          <Sparkles className="w-3 h-3 text-[var(--hub-accent)]" />
                          <span>{alt.nameAr}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : readyDraftsCount === 0 && !isRunning ? (
            <div className="rounded-xl border border-dashed border-[var(--hub-border)] p-8 text-center text-xs sm:text-sm text-[var(--hub-muted)] space-y-1">
              <div className="font-semibold text-[var(--hub-heading)]">
                اختر النطاق واضغط «بدء التحليل» لاستخراج المقترحات من صفحة المتجر والمصادر والذكاء الاصطناعي.
              </div>
              <div>لن يتم تعديل أو استبدال أي حقل محفوظ إلا بعد مراجعتك وموافقتك الصريحة.</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
