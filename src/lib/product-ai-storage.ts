import { auth } from './firebase';
import {
  composeExtendedGuidance,
  extractExtendedGuidance,
  extractLinkedAlternativesFromNotes,
  extractProductProvenance,
  isFilledFragranceValue,
  isSprayOrNonPerfumeProduct,
  mergeInternalNotesWithMetadata,
  stripSystemMarkers,
  type ConfidenceLevel,
  type FieldProvenanceEntry,
} from './product-utils';
import type { Product } from '../types/hub';

export type AiFieldKey =
  | 'officialDescription'
  | 'fragranceFamily'
  | 'fragranceCharacter'
  | 'perfumeType'
  | 'concentration'
  | 'topNotes'
  | 'heartNotes'
  | 'baseNotes'
  | 'notesAndIngredients'
  | 'longevity'
  | 'sillage'
  | 'sillageReach'
  | 'sillageDuration'
  | 'usageType'
  | 'occasionUsage'
  | 'seasons'
  | 'timeOfDay'
  | 'targetAudience'
  | 'usageInstructions'
  | 'layeringSuggestions'
  | 'extraInfo';

export const AI_FIELD_LABELS: Record<AiFieldKey, string> = {
  officialDescription: 'الوصف الرسمي',
  fragranceFamily: 'العائلة العطرية',
  fragranceCharacter: 'الطابع العطري',
  perfumeType: 'النوع والفئة',
  concentration: 'التركيز',
  topNotes: 'مقدمة العطر (Top Notes)',
  heartNotes: 'قلب العطر (Heart Notes)',
  baseNotes: 'قاعدة العطر (Base Notes)',
  notesAndIngredients: 'الملخص الكامل للنوتات والمكونات',
  longevity: 'الثبات (الساعات المتوقعة تقديرياً)',
  sillage: 'مستوى الفوحان (خفيف / متوسط / قوي / قوي جداً)',
  sillageReach: 'مدى انتشار الرائحة',
  sillageDuration: 'مدة بقاء الفوحان',
  usageType: 'الاستخدام (يومي / رسمي / عملي / مناسبات / سهرات)',
  occasionUsage: 'المناسبات (العمل / الزيارات / الأعراس / السهرات...)',
  seasons: 'الفصول (الصيف / الشتاء / الربيع / الخريف / كل الفصول)',
  timeOfDay: 'الأوقات (صباحي / نهاري / مسائي / ليلي / طوال اليوم)',
  targetAudience: 'الفئة المناسبة وطبيعة العطر',
  usageInstructions: 'طريقة الاستخدام',
  layeringSuggestions: 'اقتراحات تنسيق العطر (Layering)',
  extraInfo: 'معلومات إضافية',
};

export interface AiSuggestedFieldValue {
  value: string;
  sourceType: 'official' | 'external' | 'ai_estimated';
  sourceLabel: string;
  sourceUrl: string;
  confidence: ConfidenceLevel;
  reason?: string;
}

export interface ProductEnrichmentDraft {
  productId: string;
  enrichedAt: string;
  fields: Partial<Record<AiFieldKey, AiSuggestedFieldValue>>;
  suggestedAlternativeIds: string[];
  sourcesUsed: Array<{ title: string; uri: string }>;
  summaryNote: string;
}

export interface BatchEnrichmentCheckpoint {
  mode: 'single' | 'selected' | 'all_incomplete';
  queueIds: string[];
  completedIds: string[];
  skippedIds: string[];
  failedMap: Record<string, string>;
  draftsByProductId: Record<string, ProductEnrichmentDraft>;
  updatedAt: string;
}

export interface ProductUndoSnapshot {
  snapshotId: string;
  productId: string;
  productNameAr: string;
  savedAt: string;
  summary: string;
  previousProduct: Product;
}

const AI_CACHE_KEY = 'mashaer_product_ai_cache_v2';
const BATCH_CHECKPOINT_KEY = 'mashaer_product_ai_batch_v2';
const UNDO_HISTORY_KEY = 'mashaer_product_undo_v1';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore storage access errors in SSR / restricted contexts
  }
  return null;
}

function buildCacheSignature(product: Product): string {
  const locked = (product.manuallyEditedFields || []).slice().sort().join(',');
  return [
    product.id,
    product.nameAr,
    product.officialDescription?.slice(0, 80) || '',
    product.fragranceFamily || '',
    product.fragranceCharacter || '',
    product.longevity || '',
    product.sillage || '',
    product.occasionUsage || '',
    product.seasons || '',
    product.usageInstructions || '',
    product.extraInfo || '',
    locked,
  ].join('::');
}

export function getCachedProductEnrichment(product: Product): ProductEnrichmentDraft | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(AI_CACHE_KEY);
    if (!raw) return null;
    const store = JSON.parse(raw) as Record<
      string,
      { signature: string; cachedAt: number; draft: ProductEnrichmentDraft }
    >;
    const entry = store[product.id];
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return null;
    if (entry.signature !== buildCacheSignature(product)) return null;
    return entry.draft;
  } catch {
    return null;
  }
}

export function setCachedProductEnrichment(product: Product, draft: ProductEnrichmentDraft): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(AI_CACHE_KEY);
    const store: Record<string, { signature: string; cachedAt: number; draft: ProductEnrichmentDraft }> = raw
      ? JSON.parse(raw)
      : {};
    store[product.id] = {
      signature: buildCacheSignature(product),
      cachedAt: Date.now(),
      draft,
    };
    const keys = Object.keys(store);
    if (keys.length > 40) {
      keys
        .sort((a, b) => store[a].cachedAt - store[b].cachedAt)
        .slice(0, keys.length - 40)
        .forEach((k) => delete store[k]);
    }
    storage.setItem(AI_CACHE_KEY, JSON.stringify(store));
  } catch {
    // Non-fatal
  }
}

export function loadBatchCheckpoint(): BatchEnrichmentCheckpoint | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(BATCH_CHECKPOINT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BatchEnrichmentCheckpoint;
    if (!Array.isArray(parsed.queueIds) || parsed.queueIds.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveBatchCheckpoint(checkpoint: BatchEnrichmentCheckpoint): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(BATCH_CHECKPOINT_KEY, JSON.stringify(checkpoint));
  } catch {
    // Non-fatal
  }
}

export function clearBatchCheckpoint(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(BATCH_CHECKPOINT_KEY);
  } catch {
    // Non-fatal
  }
}

export function loadUndoSnapshots(productId?: string): ProductUndoSnapshot[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(UNDO_HISTORY_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as ProductUndoSnapshot[];
    if (!Array.isArray(list)) return [];
    return productId ? list.filter((item) => item.productId === productId) : list;
  } catch {
    return [];
  }
}

export function pushUndoSnapshot(product: Product, summary: string): ProductUndoSnapshot {
  const snapshot: ProductUndoSnapshot = {
    snapshotId: `undo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    productId: product.id,
    productNameAr: product.nameAr,
    savedAt: new Date().toISOString(),
    summary,
    previousProduct: JSON.parse(JSON.stringify(product)) as Product,
  };

  const storage = getStorage();
  if (storage) {
    try {
      const existing = loadUndoSnapshots();
      const updated = [snapshot, ...existing].slice(0, 25);
      storage.setItem(UNDO_HISTORY_KEY, JSON.stringify(updated));
    } catch {
      // Non-fatal
    }
  }
  return snapshot;
}

export function removeUndoSnapshot(snapshotId: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const existing = loadUndoSnapshots();
    storage.setItem(
      UNDO_HISTORY_KEY,
      JSON.stringify(existing.filter((item) => item.snapshotId !== snapshotId))
    );
  } catch {
    // Non-fatal
  }
}

export function getProductAiFieldCurrentValue(product: Product, key: AiFieldKey): string {
  const ext = extractExtendedGuidance(product);
  switch (key) {
    case 'concentration':
      return ext.concentration;
    case 'timeOfDay':
      return ext.timeOfDay;
    case 'usageType':
      return ext.usageType;
    case 'sillageReach':
      return ext.sillageReach;
    case 'sillageDuration':
      return ext.sillageDuration;
    case 'targetAudience':
      return ext.targetAudience;
    case 'layeringSuggestions':
      return ext.layeringSuggestions;
    case 'perfumeType':
      return ext.cleanPerfumeType || product.perfumeType || '';
    case 'usageInstructions':
      return ext.cleanUsageInstructions || '';
    case 'extraInfo':
      return ext.cleanExtraInfo || '';
    default:
      return String((product as unknown as Record<string, unknown>)[key] || '');
  }
}

export function isAiFieldManuallyLocked(product: Product, key: AiFieldKey): boolean {
  const locked = new Set(product.manuallyEditedFields || []);
  if (locked.has(key)) return true;
  if (key === 'concentration' && locked.has('perfumeType')) return true;
  if ((key === 'timeOfDay' || key === 'layeringSuggestions') && locked.has('usageInstructions')) return true;
  if (
    (key === 'usageType' || key === 'sillageReach' || key === 'sillageDuration' || key === 'targetAudience') &&
    locked.has('extraInfo')
  ) {
    return true;
  }
  return false;
}

export async function requestProductAiEnrichment(params: {
  product: Product;
  allProducts: Product[];
  targetFields?: string[];
  regenerateField?: AiFieldKey;
  useOfficialFetch?: boolean;
  useWebSearch?: boolean;
  bypassCache?: boolean;
}): Promise<ProductEnrichmentDraft> {
  const { product, allProducts, targetFields, regenerateField, useOfficialFetch = true, useWebSearch = true, bypassCache = false } = params;

  if (!bypassCache && !regenerateField && (!targetFields || targetFields.includes('all'))) {
    const cached = getCachedProductEnrichment(product);
    if (cached) return cached;
  }

  const user = auth?.currentUser;
  if (!user) {
    throw new Error('يجب تسجيل الدخول كمسؤول لتشغيل استكمال البيانات بالذكاء الاصطناعي.');
  }
  const idToken = await user.getIdToken();

  const ext = extractExtendedGuidance(product);
  const catalogSummary = allProducts
    .filter((p) => p.id !== product.id)
    .map((p) => ({
      id: p.id,
      sku: p.sku || '',
      nameAr: p.nameAr,
      nameEn: p.nameEn || '',
      category: p.category,
      fragranceFamily: p.fragranceFamily || '',
      notesAndIngredients: p.notesAndIngredients || '',
    }));

  const res = await fetch('/api/products/enrich', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      product: {
        id: product.id,
        sku: product.sku,
        nameAr: product.nameAr,
        nameEn: product.nameEn,
        category: product.category,
        officialDescription: product.officialDescription,
        fragranceFamily: product.fragranceFamily,
        fragranceCharacter: product.fragranceCharacter,
        perfumeType: product.perfumeType,
        concentration: ext.concentration,
        sillage: product.sillage,
        sillageReach: ext.sillageReach,
        sillageDuration: ext.sillageDuration,
        longevity: product.longevity,
        usageType: ext.usageType,
        occasionUsage: product.occasionUsage,
        seasons: product.seasons,
        timeOfDay: ext.timeOfDay,
        notesAndIngredients: product.notesAndIngredients,
        topNotes: product.topNotes,
        heartNotes: product.heartNotes,
        baseNotes: product.baseNotes,
        size: product.size,
        availability: product.availability,
        usageInstructions: product.usageInstructions,
        extraInfo: product.extraInfo,
        sourceUrl: product.sourceUrl,
        manuallyEditedFields: product.manuallyEditedFields || [],
      },
      catalogSummary,
      targetFields,
      regenerateField,
      useOfficialFetch,
      useWebSearch,
    }),
  });

  const data = await res.json().catch(() => ({ ok: false, error: 'استجابة غير صالحة من الخادم.' }));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `تعذر إتمام الطلب (${res.status}).`);
  }

  const draft: ProductEnrichmentDraft = {
    productId: product.id,
    enrichedAt: data.enrichedAt || new Date().toISOString(),
    fields: data.fields || {},
    suggestedAlternativeIds: Array.isArray(data.suggestedAlternativeIds) ? data.suggestedAlternativeIds : [],
    sourcesUsed: Array.isArray(data.sourcesUsed) ? data.sourcesUsed : [],
    summaryNote: data.summaryNote || '',
  };

  if (!regenerateField) {
    setCachedProductEnrichment(product, draft);
  }
  return draft;
}

const DIRECT_PRODUCT_KEYS = new Set<AiFieldKey>([
  'officialDescription',
  'fragranceFamily',
  'fragranceCharacter',
  'perfumeType',
  'topNotes',
  'heartNotes',
  'baseNotes',
  'notesAndIngredients',
  'longevity',
  'sillage',
  'occasionUsage',
  'seasons',
  'usageInstructions',
  'extraInfo',
]);

/**
 * Pure deterministic builder converting an accepted AI enrichment draft + inline edits
 * into a complete Firestore save payload while strictly protecting manuallyEditedFields
 * and forbidding spray alternatives on perfumes.
 */
export function applyAcceptedAiDraftToProductInput(params: {
  product: Product;
  allProducts: Product[];
  draft: ProductEnrichmentDraft;
  acceptedKeys: AiFieldKey[];
  editedValues?: Partial<Record<AiFieldKey, string>>;
  acceptAlternatives?: boolean;
}): {
  productPayload: Omit<Product, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy'>;
  aiAppliedFields: string[];
  adminEditedKeys: string[];
} {
  const { product, allProducts, draft, acceptedKeys, editedValues = {}, acceptAlternatives = true } = params;
  const provenanceMap: Record<string, FieldProvenanceEntry> = { ...extractProductProvenance(product) };

  const currentExtended = extractExtendedGuidance(product);
  const extendedPatch: Partial<{
    concentration: string;
    timeOfDay: string;
    usageType: string;
    sillageReach: string;
    sillageDuration: string;
    targetAudience: string;
    layeringSuggestions: string;
  }> = {
    concentration: currentExtended.concentration,
    timeOfDay: currentExtended.timeOfDay,
    usageType: currentExtended.usageType,
    sillageReach: currentExtended.sillageReach,
    sillageDuration: currentExtended.sillageDuration,
    targetAudience: currentExtended.targetAudience,
    layeringSuggestions: currentExtended.layeringSuggestions,
  };

  const nextData: Omit<Product, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy'> = {
    sku: product.sku || '',
    nameAr: product.nameAr,
    nameEn: product.nameEn || '',
    category: product.category,
    officialDescription: product.officialDescription,
    fragranceFamily: product.fragranceFamily || '',
    fragranceCharacter: product.fragranceCharacter || '',
    perfumeType: currentExtended.cleanPerfumeType || product.perfumeType || '',
    sillage: product.sillage || '',
    longevity: product.longevity || '',
    occasionUsage: product.occasionUsage || '',
    seasons: product.seasons || '',
    notesAndIngredients: product.notesAndIngredients || '',
    topNotes: product.topNotes || '',
    heartNotes: product.heartNotes || '',
    baseNotes: product.baseNotes || '',
    size: product.size || '',
    availability: product.availability || '',
    usageInstructions: currentExtended.cleanUsageInstructions || '',
    extraInfo: currentExtended.cleanExtraInfo || '',
    internalNotes: product.internalNotes || '',
    companionGift: product.companionGift ?? null,
    countryPrices: product.countryPrices,
    priceHistory: product.priceHistory,
    manuallyEditedFields: [...(product.manuallyEditedFields || [])],
    syncConflictNote: product.syncConflictNote || '',
    lastSyncedAt: product.lastSyncedAt,
    syncStatus: product.syncStatus || 'ai_enriched',
    reviewStatus: product.reviewStatus,
    sourceUrl: product.sourceUrl || '',
    sortOrder: product.sortOrder,
  };

  const aiAppliedFields: string[] = [];
  const adminEditedKeys: string[] = [];

  for (const key of acceptedKeys) {
    const suggested = draft.fields[key];
    const overrideVal = editedValues[key];
    const finalVal = (overrideVal !== undefined ? overrideVal : suggested?.value || '').trim();
    if (!finalVal) continue;

    // Protect manual locks unless admin explicitly tweaked the inline draft value
    const adminModifiedThisSuggestion =
      overrideVal !== undefined && suggested?.value?.trim() !== overrideVal.trim();
    if (isAiFieldManuallyLocked(product, key) && !adminModifiedThisSuggestion) {
      continue;
    }

    // Do not overwrite already filled non-empty field unless explicitly edited or missing before
    const existingVal = getProductAiFieldCurrentValue(product, key);
    if (isFilledFragranceValue(existingVal) && !adminModifiedThisSuggestion && !suggested) {
      continue;
    }

    if (DIRECT_PRODUCT_KEYS.has(key)) {
      const clampedVal =
        key === 'longevity' || key === 'sillage'
          ? finalVal.slice(0, 120)
          : key === 'occasionUsage'
            ? finalVal.slice(0, 300)
            : key === 'seasons' || key === 'fragranceFamily' || key === 'fragranceCharacter' || key === 'perfumeType'
              ? finalVal.slice(0, 200)
              : finalVal;
      (nextData as Record<string, unknown>)[key] = clampedVal;
    } else if (key === 'concentration') {
      extendedPatch.concentration = finalVal;
    } else if (key === 'timeOfDay') {
      extendedPatch.timeOfDay = finalVal;
    } else if (key === 'usageType') {
      extendedPatch.usageType = finalVal;
    } else if (key === 'sillageReach') {
      extendedPatch.sillageReach = finalVal;
    } else if (key === 'sillageDuration') {
      extendedPatch.sillageDuration = finalVal;
    } else if (key === 'targetAudience') {
      extendedPatch.targetAudience = finalVal;
    } else if (key === 'layeringSuggestions') {
      extendedPatch.layeringSuggestions = finalVal;
    }

    const parentKey =
      key === 'concentration'
        ? 'perfumeType'
        : key === 'timeOfDay' || key === 'layeringSuggestions'
          ? 'usageInstructions'
          : key === 'usageType' || key === 'sillageReach' || key === 'sillageDuration' || key === 'targetAudience'
            ? 'extraInfo'
            : key;

    if (adminModifiedThisSuggestion) {
      adminEditedKeys.push(key);
      if (parentKey !== key) adminEditedKeys.push(parentKey);
      provenanceMap[key] = {
        sourceType: 'manual',
        confidence: 'high',
        sourceLabel: 'مراجعة وتعديل إداري',
        updatedAt: draft.enrichedAt,
      };
    } else if (suggested) {
      aiAppliedFields.push(parentKey);
      provenanceMap[key] = {
        sourceType: suggested.sourceType,
        confidence: suggested.confidence,
        sourceLabel: suggested.sourceLabel,
        sourceUrl: suggested.sourceUrl,
        updatedAt: draft.enrichedAt,
      };
    }
  }

  const composed = composeExtendedGuidance(
    {
      perfumeType: nextData.perfumeType,
      usageInstructions: nextData.usageInstructions,
      extraInfo: nextData.extraInfo,
    },
    extendedPatch
  );
  nextData.perfumeType = composed.perfumeType;
  nextData.usageInstructions = composed.usageInstructions;
  nextData.extraInfo = composed.extraInfo;

  // Merge strictly compatible alternatives
  const existingAltIds = extractLinkedAlternativesFromNotes(product.internalNotes);
  const candidateAlts = acceptAlternatives
    ? [...existingAltIds, ...(draft.suggestedAlternativeIds || [])]
    : existingAltIds;
  const safeAltIds = candidateAlts.filter((id) => {
    const candidate = allProducts.find((p) => p.id === id);
    if (!candidate || candidate.id === product.id) return false;
    if (product.category === 'perfumes') {
      return candidate.category === 'perfumes' && !isSprayOrNonPerfumeProduct(candidate);
    }
    return candidate.category === product.category;
  });

  nextData.internalNotes = mergeInternalNotesWithMetadata(
    stripSystemMarkers(product.internalNotes),
    Array.from(new Set(safeAltIds)).slice(0, 3),
    provenanceMap
  );

  nextData.manuallyEditedFields = Array.from(
    new Set([...(product.manuallyEditedFields || []), ...adminEditedKeys])
  ).slice(0, 35);

  return {
    productPayload: nextData,
    aiAppliedFields: Array.from(new Set(aiAppliedFields)),
    adminEditedKeys: Array.from(new Set(adminEditedKeys)),
  };
}
