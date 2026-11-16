import {
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import { logAuditEvent } from './audit';
import { trackDelete, trackRead, trackWrite } from './quota-monitor';
import { clampString, FIELD_LIMITS, makeSafeDocId } from './validation';
import { emailToKey, GCC_COUNTRIES, isSensitiveAdminEmail, normalizeEmail } from './auth-constants';
import { MASHAER_STORE_CATALOG } from './attached-pdfs-data';
import { DEFAULT_UI_CONFIG, LOGO_SLOT_DIMENSION_BOUNDS, LOGO_SLOT_IDS } from './ui-defaults';
import { clampNumber, sanitizeTypographyConfig } from './fonts';
import type {
  AuthorizedUser,
  CannedResponse,
  CountryCode,
  CountryPriceEntry,
  CustomCategory,
  CustomerInquiry,
  EmployeeAlert,
  LogoPlacementsMap,
  LogoSlotId,
  Policy,
  PriceHistoryEntry,
  Product,
  QuickPhrase,
  ReturnWorkflowStage,
  SiteBrandingSettings,
  SiteUiConfig,
  Situation,
  StaffSectionId,
  SyncHistoryEntry,
  SystemLink,
  UserPreferences,
} from '../types/hub';

function currentActorEmail(): string {
  return clampString(auth.currentUser?.email?.toLowerCase() || 'unknown@mashaer.store', FIELD_LIMITS.emailMax);
}

export function isPermissionDeniedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = 'message' in err ? String((err as { message: unknown }).message) : '';
  const code = 'code' in err ? String((err as { code: unknown }).code) : '';
  return code === 'permission-denied' || msg.includes('Missing or insufficient permissions') || msg.includes('PERMISSION_DENIED');
}

export interface ConcurrencyOptions {
  expectedUpdatedAtMs?: number | null;
  forceOverwrite?: boolean;
}

export class ConcurrentEditConflictError extends Error {
  public readonly latestUpdatedBy?: string;
  public readonly latestUpdatedAtMs?: number | null;
  public readonly latestData?: Record<string, unknown>;

  constructor(message: string, details?: { latestUpdatedBy?: string; latestUpdatedAtMs?: number | null; latestData?: Record<string, unknown> }) {
    super(message);
    this.name = 'ConcurrentEditConflictError';
    this.latestUpdatedBy = details?.latestUpdatedBy;
    this.latestUpdatedAtMs = details?.latestUpdatedAtMs;
    this.latestData = details?.latestData;
  }
}

export function getUpdatedAtMs(ts: unknown): number | null {
  if (!ts) return null;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof ts === 'object') {
    if ('toMillis' in ts && typeof (ts as { toMillis: () => number }).toMillis === 'function') {
      return (ts as { toMillis: () => number }).toMillis();
    }
    if ('toDate' in ts && typeof (ts as { toDate: () => Date }).toDate === 'function') {
      return (ts as { toDate: () => Date }).toDate().getTime();
    }
    if ('seconds' in ts && typeof (ts as { seconds: unknown }).seconds === 'number') {
      return (ts as { seconds: number }).seconds * 1000;
    }
  }
  return null;
}

export function formatFirestoreDate(ts: unknown): string {
  const ms = getUpdatedAtMs(ts);
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ar-KW', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item)) as unknown as T;
  }
  if (value && typeof value === 'object' && !(value instanceof Date) && !('toDate' in value) && !('_methodName' in value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefinedDeep(v);
      }
    }
    return out as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Generic Save / Update / Delete with Audit Trail & Optimistic Concurrency
// ---------------------------------------------------------------------------
async function createDocWithAudit(
  collectionName: string,
  prefix: string,
  sectionLabel: string,
  itemName: string,
  data: Record<string, unknown>,
  customId?: string
): Promise<{ id: string; schemaUpgradePending: boolean }> {
  const id = customId || makeSafeDocId(prefix);
  const actorEmail = currentActorEmail();
  const cleanData = stripUndefinedDeep(data);
  const payload: Record<string, unknown> = {
    ...cleanData,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: actorEmail,
  };

  try {
    await setDoc(doc(db, collectionName, id), payload);
    trackWrite(1);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `${collectionName}/${id}`);
  }

  await logAuditEvent({
    section: sectionLabel,
    itemName,
    itemId: id,
    actionType: 'create',
    summary: `إضافة عنصر جديد في ${sectionLabel}: ${itemName}`,
    newValue: cleanData,
  });
  return { id, schemaUpgradePending: false };
}

async function checkOptimisticConflict(
  collectionName: string,
  id: string,
  concurrency?: ConcurrencyOptions
): Promise<void> {
  if (!concurrency?.expectedUpdatedAtMs || concurrency.forceOverwrite) return;
  const docRef = doc(db, collectionName, id);
  let snap;
  try {
    snap = await getDocFromServer(docRef);
    trackRead(1);
  } catch {
    try {
      snap = await getDoc(docRef);
      trackRead(1);
    } catch {
      return;
    }
  }
  if (!snap?.exists()) return;
  const serverData = snap.data() as Record<string, unknown>;
  const serverMs = getUpdatedAtMs(serverData.updatedAt);
  if (serverMs && serverMs > concurrency.expectedUpdatedAtMs + 1500) {
    const serverActor = typeof serverData.updatedBy === 'string' ? serverData.updatedBy : 'مدير آخر';
    throw new ConcurrentEditConflictError(
      `تم تعديل هذا السجل في السحابة بواسطة (${serverActor}) بعد فتحك لنموذج التعديل. يُرجى مراجعة التحديث أو اختيار الاعتماد بالقوة.`,
      {
        latestUpdatedBy: serverActor,
        latestUpdatedAtMs: serverMs,
        latestData: serverData,
      }
    );
  }
}

async function updateDocWithAudit(
  collectionName: string,
  id: string,
  sectionLabel: string,
  itemName: string,
  data: Record<string, unknown>,
  previousValue?: unknown,
  concurrency?: ConcurrencyOptions
): Promise<{ schemaUpgradePending: boolean }> {
  await checkOptimisticConflict(collectionName, id, concurrency);

  const actorEmail = currentActorEmail();
  const cleanData = stripUndefinedDeep(data);
  const payload: Record<string, unknown> = {
    ...cleanData,
    updatedAt: serverTimestamp(),
    updatedBy: actorEmail,
  };

  try {
    await updateDoc(doc(db, collectionName, id), payload);
    trackWrite(1);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `${collectionName}/${id}`);
  }

  await logAuditEvent({
    section: sectionLabel,
    itemName,
    itemId: id,
    actionType: 'update',
    summary: `تعديل عنصر في ${sectionLabel}: ${itemName}`,
    previousValue,
    newValue: cleanData,
  });

  return { schemaUpgradePending: false };
}

async function deleteDocWithAudit(
  collectionName: string,
  id: string,
  sectionLabel: string,
  itemName: string,
  previousValue?: unknown
): Promise<void> {
  try {
    await deleteDoc(doc(db, collectionName, id));
    trackDelete(1);
    await logAuditEvent({
      section: sectionLabel,
      itemName,
      itemId: id,
      actionType: 'delete',
      summary: `حذف عنصر من ${sectionLabel}: ${itemName}`,
      previousValue,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `${collectionName}/${id}`);
  }
}

// ---------------------------------------------------------------------------
// Canned Responses
// ---------------------------------------------------------------------------
export async function saveCannedResponse(
  input: Omit<CannedResponse, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy'>,
  existing?: CannedResponse,
  concurrency?: ConcurrencyOptions
): Promise<string> {
  const clean: Record<string, unknown> = {
    title: clampString(input.title, FIELD_LIMITS.titleMax),
    category: clampString(input.category, FIELD_LIMITS.categoryMax),
    content: clampString(input.content, FIELD_LIMITS.contentMax),
  };
  if (input.internalNotes?.trim() || existing) {
    clean.internalNotes = clampString(input.internalNotes || '', FIELD_LIMITS.notesMax);
  }
  if (existing) {
    await updateDocWithAudit(
      'canned_responses',
      existing.id,
      'مكتبة الردود الجاهزة',
      input.title,
      clean,
      existing,
      concurrency || { expectedUpdatedAtMs: getUpdatedAtMs(existing.updatedAt) }
    );
    return existing.id;
  }
  const res = await createDocWithAudit('canned_responses', 'resp', 'مكتبة الردود الجاهزة', input.title, clean);
  return res.id;
}

export async function deleteCannedResponse(item: CannedResponse): Promise<void> {
  await deleteDocWithAudit('canned_responses', item.id, 'مكتبة الردود الجاهزة', item.title, item);
}

// ---------------------------------------------------------------------------
// Customer Inquiries
// ---------------------------------------------------------------------------
export async function saveCustomerInquiry(
  input: Omit<CustomerInquiry, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy'>,
  existing?: CustomerInquiry,
  concurrency?: ConcurrencyOptions
): Promise<string> {
  const clean: Record<string, unknown> = {
    question: clampString(input.question, FIELD_LIMITS.inquiryQuestionMax),
    answer: clampString(input.answer, FIELD_LIMITS.inquiryAnswerMax),
    category: clampString(input.category, FIELD_LIMITS.categoryMax),
    needsAdminReview: Boolean(input.needsAdminReview),
    source: input.source,
  };
  if (input.notes?.trim() || existing) clean.notes = clampString(input.notes || '', FIELD_LIMITS.notesMax);
  if (typeof input.sourceOrder === 'number') clean.sourceOrder = input.sourceOrder;

  if (existing) {
    await updateDocWithAudit(
      'customer_inquiries',
      existing.id,
      'استفسارات العملاء',
      input.question,
      clean,
      existing,
      concurrency || { expectedUpdatedAtMs: getUpdatedAtMs(existing.updatedAt) }
    );
    return existing.id;
  }
  const res = await createDocWithAudit('customer_inquiries', 'inq', 'استفسارات العملاء', input.question, clean);
  return res.id;
}

export async function deleteCustomerInquiry(item: CustomerInquiry): Promise<void> {
  await deleteDocWithAudit('customer_inquiries', item.id, 'استفسارات العملاء', item.question, item);
}

// ---------------------------------------------------------------------------
// Policies (Structured 19-category support + escalationDept)
// ---------------------------------------------------------------------------
export async function savePolicy(
  input: Omit<Policy, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy'>,
  existing?: Policy,
  concurrency?: ConcurrencyOptions
): Promise<string> {
  const clean: Record<string, unknown> = {
    title: clampString(input.title, FIELD_LIMITS.titleMax),
    category: clampString(input.category, FIELD_LIMITS.categoryMax),
    content: clampString(input.content, FIELD_LIMITS.policyContentMax),
    needsAdminReview: Boolean(input.needsAdminReview),
  };
  if (input.summary?.trim() || existing) clean.summary = clampString(input.summary || '', 1000);
  if (input.applicableCases?.trim() || existing) clean.applicableCases = clampString(input.applicableCases || '', 3000);
  if (input.conditions?.trim() || existing) clean.conditions = clampString(input.conditions || '', 3000);
  if (input.exceptions?.trim() || existing) clean.exceptions = clampString(input.exceptions || '', 3000);
  if (input.requiredAction?.trim() || existing) clean.requiredAction = clampString(input.requiredAction || '', 3000);
  if (input.suggestedReply?.trim() || existing) clean.suggestedReply = clampString(input.suggestedReply || '', 4000);
  if (input.escalationDept?.trim() || existing) clean.escalationDept = clampString(input.escalationDept || '', 150);
  if (input.source?.trim() || existing) clean.source = clampString(input.source || '', 300);
  if (input.conflictNote?.trim() || existing) clean.conflictNote = clampString(input.conflictNote || '', FIELD_LIMITS.notesMax);
  if (input.sourceUrl?.trim() || existing) clean.sourceUrl = clampString(input.sourceUrl || '', FIELD_LIMITS.urlMax);
  if (typeof input.sortOrder === 'number') clean.sortOrder = input.sortOrder;

  if (existing) {
    await updateDocWithAudit(
      'policies',
      existing.id,
      'السياسات والإجراءات',
      input.title,
      clean,
      existing,
      concurrency || { expectedUpdatedAtMs: getUpdatedAtMs(existing.updatedAt) }
    );
    return existing.id;
  }
  const res = await createDocWithAudit(
    'policies',
    'pol',
    'السياسات والإجراءات',
    input.title,
    clean
  );
  return res.id;
}

export async function deletePolicy(item: Policy): Promise<void> {
  await deleteDocWithAudit('policies', item.id, 'السياسات والإجراءات', item.title, item);
}

// ---------------------------------------------------------------------------
// Situations (Sheet 1 + subCategory, internalNotes, isImportant, linkedPolicyId)
// ---------------------------------------------------------------------------
export async function saveSituation(
  input: Omit<Situation, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy'>,
  existing?: Situation,
  concurrency?: ConcurrencyOptions
): Promise<string> {
  const clean: Record<string, unknown> = {
    situationNumber: clampString(input.situationNumber, 60),
    category: clampString(input.category, 150),
    customerInquiry: clampString(input.customerInquiry, 3000),
    internalProcedure: clampString(input.internalProcedure, FIELD_LIMITS.situationFieldMax),
    cannedReply: clampString(input.cannedReply, FIELD_LIMITS.situationFieldMax),
    responsibleDept: clampString(input.responsibleDept, 150),
    isImportant: Boolean(input.isImportant),
    needsAdminReview: Boolean(input.needsAdminReview),
    duplicateFlag: Boolean(input.duplicateFlag),
  };
  if (input.subCategory?.trim() || existing) clean.subCategory = clampString(input.subCategory || '', 150);
  if (input.requiredData?.trim() || existing) clean.requiredData = clampString(input.requiredData || '', 2000);
  if (input.internalNotes?.trim() || existing) clean.internalNotes = clampString(input.internalNotes || '', 2000);
  if (input.linkedPolicyId?.trim() || existing) clean.linkedPolicyId = clampString(input.linkedPolicyId || '', 128);
  if (input.importHash?.trim()) clean.importHash = clampString(input.importHash, 128);
  if (typeof input.sortOrder === 'number') clean.sortOrder = input.sortOrder;

  if (existing) {
    await updateDocWithAudit(
      'situations',
      existing.id,
      'دليل المواقف',
      `موقف ${input.situationNumber}`,
      clean,
      existing,
      concurrency || { expectedUpdatedAtMs: getUpdatedAtMs(existing.updatedAt) }
    );
    return existing.id;
  }
  const res = await createDocWithAudit('situations', 'sit', 'دليل المواقف', `موقف ${input.situationNumber}`, clean);
  return res.id;
}

export async function deleteSituation(item: Situation): Promise<void> {
  await deleteDocWithAudit('situations', item.id, 'دليل المواقف', `موقف ${item.situationNumber}`, item);
}

// ---------------------------------------------------------------------------
// Return Workflow Stages (Sheet 2)
// ---------------------------------------------------------------------------
export async function saveReturnStage(
  input: Omit<ReturnWorkflowStage, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy'>,
  existing?: ReturnWorkflowStage,
  concurrency?: ConcurrencyOptions
): Promise<string> {
  const clean: Record<string, unknown> = {
    stageOrder: Number(input.stageOrder) || 1,
    stage: clampString(input.stage, 200),
    condition: clampString(input.condition, 2000),
    procedure: clampString(input.procedure, FIELD_LIMITS.situationFieldMax),
    cannedReply: clampString(input.cannedReply, FIELD_LIMITS.situationFieldMax),
    needsAdminReview: Boolean(input.needsAdminReview),
    duplicateFlag: Boolean(input.duplicateFlag),
  };
  if (input.employeeNote?.trim() || existing) clean.employeeNote = clampString(input.employeeNote || '', 2000);
  if (input.importHash?.trim()) clean.importHash = clampString(input.importHash, 128);

  if (existing) {
    await updateDocWithAudit(
      'return_workflow',
      existing.id,
      'مسار المرتجع والاسترداد',
      input.stage,
      clean,
      existing,
      concurrency || { expectedUpdatedAtMs: getUpdatedAtMs(existing.updatedAt) }
    );
    return existing.id;
  }
  const res = await createDocWithAudit('return_workflow', 'ret', 'مسار المرتجع والاسترداد', input.stage, clean);
  return res.id;
}

export async function deleteReturnStage(item: ReturnWorkflowStage): Promise<void> {
  await deleteDocWithAudit('return_workflow', item.id, 'مسار المرتجع والاسترداد', item.stage, item);
}

// ---------------------------------------------------------------------------
// Quick Phrases (Sheet 3) & Employee Alerts (Sheet 4)
// ---------------------------------------------------------------------------
export async function saveQuickPhrase(
  input: Omit<QuickPhrase, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy'>,
  existing?: QuickPhrase,
  concurrency?: ConcurrencyOptions
): Promise<string> {
  const clean: Record<string, unknown> = {
    purpose: clampString(input.purpose, 300),
    phrase: clampString(input.phrase, 3000),
    duplicateFlag: Boolean(input.duplicateFlag),
  };
  if (input.category?.trim() || existing) clean.category = clampString(input.category || '', 120);
  if (input.importHash?.trim()) clean.importHash = clampString(input.importHash, 128);
  if (typeof input.sortOrder === 'number') clean.sortOrder = input.sortOrder;

  if (existing) {
    await updateDocWithAudit(
      'quick_phrases',
      existing.id,
      'العبارات السريعة',
      input.purpose,
      clean,
      existing,
      concurrency || { expectedUpdatedAtMs: getUpdatedAtMs(existing.updatedAt) }
    );
    return existing.id;
  }
  const res = await createDocWithAudit('quick_phrases', 'phr', 'العبارات السريعة', input.purpose, clean);
  return res.id;
}

export async function deleteQuickPhrase(item: QuickPhrase): Promise<void> {
  await deleteDocWithAudit('quick_phrases', item.id, 'العبارات السريعة', item.purpose, item);
}

export async function saveEmployeeAlert(
  input: Omit<EmployeeAlert, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy'>,
  existing?: EmployeeAlert,
  concurrency?: ConcurrencyOptions
): Promise<string> {
  const clean: Record<string, unknown> = {
    title: clampString(input.title, 300),
    ruleText: clampString(input.ruleText, 4000),
    severity: input.severity,
    duplicateFlag: Boolean(input.duplicateFlag),
  };
  if (input.clarification?.trim() || existing) clean.clarification = clampString(input.clarification || '', 3000);
  if (input.importHash?.trim()) clean.importHash = clampString(input.importHash, 128);
  if (typeof input.sortOrder === 'number') clean.sortOrder = input.sortOrder;

  if (existing) {
    await updateDocWithAudit(
      'employee_alerts',
      existing.id,
      'تنبيهات للموظف',
      input.title,
      clean,
      existing,
      concurrency || { expectedUpdatedAtMs: getUpdatedAtMs(existing.updatedAt) }
    );
    return existing.id;
  }
  const res = await createDocWithAudit('employee_alerts', 'alt', 'تنبيهات للموظف', input.title, clean);
  return res.id;
}

export async function deleteEmployeeAlert(item: EmployeeAlert): Promise<void> {
  await deleteDocWithAudit('employee_alerts', item.id, 'تنبيهات للموظف', item.title, item);
}

// ---------------------------------------------------------------------------
// Products Guide & Perfume Intelligence (Zero bottle images + manual edit protection)
// ---------------------------------------------------------------------------
const SYNC_PROTECTABLE_FIELDS = ['nameAr', 'nameEn', 'officialDescription', 'size', 'availability', 'sourceUrl'] as const;

const ALL_MANUAL_PROTECTABLE_FIELDS = [
  'nameAr',
  'nameEn',
  'officialDescription',
  'fragranceFamily',
  'fragranceCharacter',
  'perfumeType',
  'sillage',
  'longevity',
  'occasionUsage',
  'seasons',
  'notesAndIngredients',
  'topNotes',
  'heartNotes',
  'baseNotes',
  'size',
  'availability',
  'usageInstructions',
  'extraInfo',
  'sourceUrl',
] as const;

export interface SaveProductOptions extends ConcurrencyOptions {
  /** Fields updated purely by AI/external enrichment (do not mark as manual locks) */
  aiAppliedFields?: string[];
  /** When true, honors input.manuallyEditedFields verbatim (used for Undo / lock toggle) */
  preserveExplicitManualFields?: boolean;
}

function buildProductCleanPayload(
  input: Omit<Product, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy'>,
  isUpdate = false
): Record<string, unknown> {
  const clean: Record<string, unknown> = {
    nameAr: clampString(input.nameAr, FIELD_LIMITS.titleMax),
    category: input.category,
    officialDescription: clampString(input.officialDescription, FIELD_LIMITS.productDescMax),
    reviewStatus: input.reviewStatus,
  };
  if (input.sku?.trim() || isUpdate) clean.sku = clampString(input.sku || '', 80);
  if (input.nameEn?.trim() || isUpdate) clean.nameEn = clampString(input.nameEn || '', FIELD_LIMITS.titleMax);
  if (input.fragranceFamily?.trim() || isUpdate) clean.fragranceFamily = clampString(input.fragranceFamily || '', 200);
  if (input.fragranceCharacter?.trim() || isUpdate) clean.fragranceCharacter = clampString(input.fragranceCharacter || '', 200);
  if (input.perfumeType?.trim() || isUpdate) clean.perfumeType = clampString(input.perfumeType || '', 200);
  if (input.sillage?.trim() || isUpdate) clean.sillage = clampString(input.sillage || '', 120);
  if (input.longevity?.trim() || isUpdate) clean.longevity = clampString(input.longevity || '', 120);
  if (input.occasionUsage?.trim() || isUpdate) clean.occasionUsage = clampString(input.occasionUsage || '', 300);
  if (input.seasons?.trim() || isUpdate) clean.seasons = clampString(input.seasons || '', 200);
  if (input.notesAndIngredients?.trim() || isUpdate) clean.notesAndIngredients = clampString(input.notesAndIngredients || '', FIELD_LIMITS.notesMax);
  if (input.topNotes?.trim() || isUpdate) clean.topNotes = clampString(input.topNotes || '', 1000);
  if (input.heartNotes?.trim() || isUpdate) clean.heartNotes = clampString(input.heartNotes || '', 1000);
  if (input.baseNotes?.trim() || isUpdate) clean.baseNotes = clampString(input.baseNotes || '', 1000);
  if (input.size?.trim() || isUpdate) clean.size = clampString(input.size || '', 120);
  if (input.availability?.trim() || isUpdate) clean.availability = clampString(input.availability || '', 120);
  if (input.usageInstructions?.trim() || isUpdate) clean.usageInstructions = clampString(input.usageInstructions || '', 2000);
  if (input.extraInfo?.trim() || isUpdate) clean.extraInfo = clampString(input.extraInfo || '', 2000);
  if (input.internalNotes?.trim() || isUpdate) clean.internalNotes = clampString(input.internalNotes || '', FIELD_LIMITS.notesMax);
  if (input.companionGift && input.companionGift.title?.trim()) {
    clean.companionGift = {
      title: clampString(input.companionGift.title, 160),
      size: clampString(input.companionGift.size || '', 80),
      kind: input.companionGift.kind || 'spray',
      compositionNote: clampString(input.companionGift.compositionNote || '', 800),
    };
  } else if (isUpdate && input.companionGift === null) {
    clean.companionGift = null;
  }
  if (input.countryPrices && Object.keys(input.countryPrices).length > 0) {
    clean.countryPrices = stripUndefinedDeep(input.countryPrices);
  }
  if (Array.isArray(input.priceHistory) && input.priceHistory.length > 0) {
    clean.priceHistory = stripUndefinedDeep(input.priceHistory.slice(-40));
  }
  if (Array.isArray(input.manuallyEditedFields)) {
    clean.manuallyEditedFields = input.manuallyEditedFields.slice(0, 35);
  }
  if (input.syncConflictNote !== undefined && (input.syncConflictNote.trim() || isUpdate)) {
    clean.syncConflictNote = clampString(input.syncConflictNote || '', 1000);
  }
  if (input.lastSyncedAt?.trim()) clean.lastSyncedAt = clampString(input.lastSyncedAt, 100);
  if (input.syncStatus?.trim()) clean.syncStatus = clampString(input.syncStatus, 120);
  if (input.sourceUrl?.trim() || isUpdate) clean.sourceUrl = clampString(input.sourceUrl || '', FIELD_LIMITS.urlMax);
  if (typeof input.sortOrder === 'number') clean.sortOrder = input.sortOrder;
  return clean;
}

export async function saveProduct(
  input: Omit<Product, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy'>,
  existing?: Product,
  concurrency?: SaveProductOptions
): Promise<string> {
  const aiSet = new Set<string>(concurrency?.aiAppliedFields || []);
  const editedSet = new Set<string>(
    concurrency?.preserveExplicitManualFields
      ? input.manuallyEditedFields || []
      : existing?.manuallyEditedFields || []
  );
  if (existing && !concurrency?.preserveExplicitManualFields) {
    for (const key of ALL_MANUAL_PROTECTABLE_FIELDS) {
      if (aiSet.has(key)) continue;
      const nextVal = (input[key] || '').trim();
      const prevVal = (existing[key] || '').trim();
      if (nextVal !== prevVal) {
        editedSet.add(key);
      }
    }
  }
  const enrichedInput = {
    ...input,
    manuallyEditedFields: concurrency?.preserveExplicitManualFields
      ? Array.from(editedSet)
      : existing
        ? Array.from(editedSet)
        : input.manuallyEditedFields,
  };
  const clean = buildProductCleanPayload(enrichedInput, Boolean(existing));
  if (existing) {
    await updateDocWithAudit(
      'products',
      existing.id,
      'دليل المنتجات',
      input.nameAr,
      clean,
      existing,
      concurrency || { expectedUpdatedAtMs: getUpdatedAtMs(existing.updatedAt) }
    );
    return existing.id;
  }
  const res = await createDocWithAudit(
    'products',
    'prd',
    'دليل المنتجات',
    input.nameAr,
    clean
  );
  return res.id;
}

export async function resolveProductSyncConflict(product: Product): Promise<void> {
  await updateDocWithAudit(
    'products',
    product.id,
    'دليل المنتجات',
    product.nameAr,
    { syncConflictNote: '', syncStatus: 'synced_live' },
    { syncConflictNote: product.syncConflictNote }
  );
}

export async function deleteProduct(item: Product): Promise<void> {
  await deleteDocWithAudit('products', item.id, 'دليل المنتجات', item.nameAr, item);
}

export async function refreshProductFromServer(productId: string): Promise<Product | null> {
  const ref = doc(db, 'products', productId);
  try {
    const snap = await getDocFromServer(ref);
    trackRead(1);
    if (!snap.exists()) return null;
    return {
      ...(snap.data() as Omit<Product, 'id'>),
      id: snap.id,
      imageUrl: undefined,
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `products/${productId}`);
  }
}

// ---------------------------------------------------------------------------
// Live Mashaer.store Sync & Price History Engine (Protects manual edits)
// ---------------------------------------------------------------------------
interface LiveSyncApiProduct {
  slug: string;
  sku: string;
  nameAr: string;
  nameEn: string;
  category: 'perfumes' | 'mamoul' | 'spray';
  officialDescription: string;
  imageUrl: string;
  availability: string;
  size: string;
  sourceUrl: string;
  countryPrices: Partial<Record<CountryCode, CountryPriceEntry>>;
}

export interface LiveSyncResult {
  syncedAt: string;
  updatedCount: number;
  createdCount: number;
  conflictCount: number;
  priceChanges: number;
  products: Product[];
  schemaUpgradePending: boolean;
}

function normalizeMatchKey(val: string | undefined): string {
  return (val || '').trim().toLowerCase().replace(/[\s\-_&]+/g, '');
}

function findMatchingExistingProduct(
  live: LiveSyncApiProduct,
  existingProducts: Product[]
): Product | undefined {
  const liveSku = normalizeMatchKey(live.sku);
  const liveEn = normalizeMatchKey(live.nameEn);
  const liveAr = normalizeMatchKey(live.nameAr);
  const liveSlug = normalizeMatchKey(live.slug);

  return existingProducts.find((p) => {
    if (liveSku && normalizeMatchKey(p.sku) === liveSku) return true;
    if (liveEn && normalizeMatchKey(p.nameEn) === liveEn) return true;
    if (liveAr && normalizeMatchKey(p.nameAr) === liveAr) return true;
    if (liveSlug && p.sourceUrl && p.sourceUrl.toLowerCase().includes(`/products/${live.slug.toLowerCase()}`)) return true;
    return false;
  });
}

export async function syncLiveMashaerCatalogToFirestore(
  existingProducts: Product[],
  previousSyncHistory?: SyncHistoryEntry[]
): Promise<LiveSyncResult> {
  const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : '';
  if (!idToken) {
    throw new Error('يجب تسجيل الدخول بحساب مدير مصرح له قبل المزامنة المباشرة.');
  }

  const response = await fetch('/api/mashaer/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
  });

  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    syncedAt?: string;
    products?: LiveSyncApiProduct[];
  } | null;

  if (!response.ok || !body?.ok || !Array.isArray(body.products) || body.products.length < 5) {
    throw new Error(
      body?.error || 'البيانات المستلمة من متجر mashaer.store غير مكتملة. تم إلغاء المزامنة لحماية البيانات الحالية.'
    );
  }

  const syncedAt = body.syncedAt || new Date().toISOString();
  const actorEmail = currentActorEmail();
  let updatedCount = 0;
  let createdCount = 0;
  let conflictCount = 0;
  let priceChanges = 0;
  const schemaUpgradePending = false;
  const mergedResults: Product[] = [];

  const batchOps: Array<{
    id: string;
    isUpdate: boolean;
    payload: Record<string, unknown>;
  }> = [];

  for (let idx = 0; idx < body.products.length; idx += 1) {
    const live = body.products[idx];
    const existing = findMatchingExistingProduct(live, existingProducts);
    const catalogFallback = MASHAER_STORE_CATALOG.find(
      (c) =>
        (live.sku && normalizeMatchKey(c.sku) === normalizeMatchKey(live.sku)) ||
        (live.nameEn && normalizeMatchKey(c.nameEn) === normalizeMatchKey(live.nameEn)) ||
        normalizeMatchKey(c.nameAr) === normalizeMatchKey(live.nameAr)
    );

    const history: PriceHistoryEntry[] = Array.isArray(existing?.priceHistory)
      ? [...existing.priceHistory]
      : [];

    if (existing?.countryPrices) {
      for (const c of GCC_COUNTRIES) {
        const prevEntry = existing.countryPrices[c.code];
        const nextEntry = live.countryPrices[c.code];
        if (!prevEntry || !nextEntry) continue;
        const priceDiffers = prevEntry.price !== nextEntry.price;
        const availDiffers = prevEntry.availability !== nextEntry.availability;
        if (priceDiffers || availDiffers) {
          priceChanges += 1;
          history.push({
            recordedAt: syncedAt,
            countryCode: c.code,
            currency: nextEntry.currency || c.currency,
            previousPrice: prevEntry.price,
            newPrice: nextEntry.price,
            previousAvailability: prevEntry.availability,
            newAvailability: nextEntry.availability,
          });
        }
      }
    }

    const protectedFields = new Set(existing?.manuallyEditedFields || []);
    const conflictDetails: string[] = [];

    const resolveField = (
      field: typeof SYNC_PROTECTABLE_FIELDS[number],
      liveVal: string | undefined,
      existingVal: string | undefined,
      fallbackVal?: string
    ): string | undefined => {
      if (existing && protectedFields.has(field) && existingVal?.trim()) {
        if (liveVal && liveVal.trim() && liveVal.trim() !== existingVal.trim()) {
          conflictDetails.push(`${field}: المتجر يقترح "${liveVal.slice(0, 80)}" بينما النسخة اليدوية محفوظة`);
        }
        return existingVal;
      }
      return liveVal || existingVal || fallbackVal;
    };

    const resolvedNameAr = resolveField('nameAr', live.nameAr, existing?.nameAr, live.nameAr) || live.nameAr;
    const resolvedNameEn = resolveField('nameEn', live.nameEn, existing?.nameEn, catalogFallback?.nameEn);
    const resolvedDesc =
      resolveField('officialDescription', live.officialDescription, existing?.officialDescription, catalogFallback?.officialDescription) ||
      live.nameAr;
    const resolvedSize = resolveField('size', live.size, existing?.size, catalogFallback?.size);
    const resolvedAvail =
      resolveField('availability', live.availability, existing?.availability, 'يُتحقق عبر mashaer.store') ||
      'يُتحقق عبر mashaer.store';
    const resolvedSourceUrl = resolveField('sourceUrl', live.sourceUrl, existing?.sourceUrl, catalogFallback?.sourceUrl);

    if (conflictDetails.length > 0) {
      conflictCount += 1;
    }

    const mergedProduct: Product = {
      id: existing?.id || catalogFallback?.id || `prd_${live.slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`,
      sku: live.sku || existing?.sku || catalogFallback?.sku,
      nameAr: resolvedNameAr,
      nameEn: resolvedNameEn,
      category: live.category || existing?.category || 'perfumes',
      officialDescription: resolvedDesc,
      fragranceFamily: existing?.fragranceFamily || catalogFallback?.fragranceFamily,
      fragranceCharacter: existing?.fragranceCharacter || catalogFallback?.fragranceCharacter,
      perfumeType: existing?.perfumeType || catalogFallback?.perfumeType,
      sillage: existing?.sillage || catalogFallback?.sillage,
      longevity: existing?.longevity || catalogFallback?.longevity,
      occasionUsage: existing?.occasionUsage || catalogFallback?.occasionUsage,
      seasons: existing?.seasons || catalogFallback?.seasons,
      notesAndIngredients: existing?.notesAndIngredients || catalogFallback?.notesAndIngredients,
      topNotes: existing?.topNotes || catalogFallback?.topNotes,
      heartNotes: existing?.heartNotes || catalogFallback?.heartNotes,
      baseNotes: existing?.baseNotes || catalogFallback?.baseNotes,
      size: resolvedSize,
      availability: resolvedAvail,
      usageInstructions: existing?.usageInstructions || catalogFallback?.usageInstructions,
      extraInfo: existing?.extraInfo || catalogFallback?.extraInfo,
      internalNotes: existing?.internalNotes || catalogFallback?.internalNotes || 'متزامن مباشرة مع mashaer.store',
      companionGift: existing?.companionGift !== undefined ? existing.companionGift : catalogFallback?.companionGift,
      countryPrices: live.countryPrices,
      priceHistory: history.slice(-40),
      manuallyEditedFields: existing?.manuallyEditedFields,
      syncConflictNote: conflictDetails.length > 0 ? conflictDetails.join(' | ').slice(0, 950) : existing?.syncConflictNote,
      lastSyncedAt: syncedAt,
      syncStatus: conflictDetails.length > 0 ? 'sync_conflict' : 'synced_live',
      reviewStatus: existing?.reviewStatus || 'verified',
      sourceUrl: resolvedSourceUrl,
      sortOrder: existing?.sortOrder ?? catalogFallback?.sortOrder ?? idx + 1,
      updatedBy: actorEmail,
    };

    mergedResults.push(mergedProduct);

    const payload = buildProductCleanPayload(mergedProduct, Boolean(existing));
    payload.updatedAt = serverTimestamp();
    payload.updatedBy = actorEmail;
    if (!existing) {
      payload.createdAt = serverTimestamp();
      createdCount += 1;
    } else {
      updatedCount += 1;
    }

    batchOps.push({
      id: mergedProduct.id,
      isUpdate: Boolean(existing),
      payload: stripUndefinedDeep(payload),
    });
  }

  const chunkSize = 350;
  for (let i = 0; i < batchOps.length; i += chunkSize) {
    const chunk = batchOps.slice(i, i + chunkSize);
    const batch = writeBatch(db);
    for (const op of chunk) {
      const ref = doc(db, 'products', op.id);
      if (op.isUpdate) {
        batch.update(ref, op.payload);
      } else {
        batch.set(ref, op.payload);
      }
    }
    try {
      await batch.commit();
      trackWrite(chunk.length);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'products/live_sync');
    }
  }

  const syncStatusSummary = `تمت المزامنة (${mergedResults.length} منتج · تحديث ${updatedCount} · إضافة ${createdCount} · تعارضات محمية ${conflictCount} · تغيرات أسعار ${priceChanges})`;
  const nextSyncEntry: SyncHistoryEntry = {
    syncedAt,
    status: syncStatusSummary,
    productCount: mergedResults.length,
    updatedCount,
    createdCount,
    conflictCount,
    priceChanges,
    actorEmail,
  };
  const updatedSyncHistory = [...(previousSyncHistory || []), nextSyncEntry].slice(-30);

  if (isSensitiveAdminEmail(actorEmail)) {
    try {
      await setDoc(
        doc(db, 'site_settings', 'branding'),
        {
          lastStoreSyncAt: syncedAt,
          lastStoreSyncStatus: syncStatusSummary,
          syncHistory: updatedSyncHistory,
          updatedAt: serverTimestamp(),
          updatedBy: actorEmail,
        },
        { merge: true }
      );
      trackWrite(1);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'site_settings/branding');
    }
  }

  await logAuditEvent({
    section: 'دليل المنتجات',
    itemName: 'مزامنة مباشرة من mashaer.store',
    actionType: 'import',
    summary: syncStatusSummary,
  });

  return {
    syncedAt,
    updatedCount,
    createdCount,
    conflictCount,
    priceChanges,
    products: mergedResults,
    schemaUpgradePending,
  };
}

// ---------------------------------------------------------------------------
// Operational Systems + Isolated Credentials (Atomic writeBatch)
// ---------------------------------------------------------------------------
export async function saveSystemWithCredentials(
  linkInput: Omit<SystemLink, 'id' | 'createdAt' | 'updatedAt' | 'updatedBy'>,
  credInput: { usernameOrEmail: string; password: string },
  existingLink?: SystemLink,
  concurrency?: ConcurrencyOptions
): Promise<string> {
  const linkId = existingLink?.id || makeSafeDocId('sys');
  if (existingLink) {
    await checkOptimisticConflict(
      'system_links',
      linkId,
      concurrency || { expectedUpdatedAtMs: getUpdatedAtMs(existingLink.updatedAt) }
    );
  }

  const actorEmail = currentActorEmail();

  const linkData: Record<string, unknown> = {
    systemName: clampString(linkInput.systemName, FIELD_LIMITS.titleMax),
    url: clampString(linkInput.url, FIELD_LIMITS.urlMax),
    visibility: linkInput.visibility,
    updatedAt: serverTimestamp(),
    updatedBy: actorEmail,
  };
  if (linkInput.mainCategory?.trim() || existingLink) linkData.mainCategory = clampString(linkInput.mainCategory || '', 120);
  if (linkInput.subCategory?.trim() || existingLink) linkData.subCategory = clampString(linkInput.subCategory || '', 120);
  if (linkInput.loginMethod) linkData.loginMethod = linkInput.loginMethod;
  if (linkInput.systemStatus) linkData.systemStatus = linkInput.systemStatus;
  if (linkInput.otpNote?.trim() || existingLink) linkData.otpNote = clampString(linkInput.otpNote || '', 500);
  if (linkInput.publicUsername?.trim() || existingLink) linkData.publicUsername = clampString(linkInput.publicUsername || '', 300);
  if (linkInput.description?.trim() || existingLink) linkData.description = clampString(linkInput.description || '', 2000);
  if (linkInput.usageInstructions?.trim() || existingLink) linkData.usageInstructions = clampString(linkInput.usageInstructions || '', 3000);
  if (linkInput.notes?.trim() || existingLink) linkData.notes = clampString(linkInput.notes || '', 2000);
  if (typeof linkInput.sortOrder === 'number') linkData.sortOrder = linkInput.sortOrder;

  const credData: Record<string, unknown> = {
    linkId,
    usernameOrEmail: (credInput.usernameOrEmail ?? '').slice(0, FIELD_LIMITS.shortTextMax),
    password: (credInput.password ?? '').slice(0, FIELD_LIMITS.shortTextMax),
    visibility: linkInput.visibility,
    updatedAt: serverTimestamp(),
    updatedBy: actorEmail,
  };

  try {
    const batch = writeBatch(db);
    if (existingLink) {
      batch.update(doc(db, 'system_links', linkId), linkData);
      batch.set(doc(db, 'system_credentials', linkId), credData, { merge: false });
    } else {
      batch.set(doc(db, 'system_links', linkId), {
        ...linkData,
        createdAt: serverTimestamp(),
      });
      batch.set(doc(db, 'system_credentials', linkId), credData);
    }
    await batch.commit();
    trackWrite(2);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `system_links/${linkId}`);
  }

  await logAuditEvent({
    section: 'روابط الأنظمة والتشغيل',
    itemName: linkInput.systemName,
    itemId: linkId,
    actionType: existingLink ? 'update' : 'create',
    summary: `${existingLink ? 'تحديث' : 'إضافة'} نظام تشغيل وبيانات الدخول المحمية: ${linkInput.systemName}`,
    previousValue: existingLink
      ? { systemName: existingLink.systemName, url: existingLink.url, visibility: existingLink.visibility }
      : undefined,
    newValue: {
      systemName: linkData.systemName,
      url: linkData.url,
      visibility: linkData.visibility,
      credentialsUpdated: true,
    },
  });
  return linkId;
}

export async function deleteSystemWithCredentials(link: SystemLink): Promise<void> {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'system_credentials', link.id));
  batch.delete(doc(db, 'system_links', link.id));
  try {
    await batch.commit();
    trackDelete(2);
    await logAuditEvent({
      section: 'روابط الأنظمة والتشغيل',
      itemName: link.systemName,
      itemId: link.id,
      actionType: 'delete',
      summary: `حذف نظام التشغيل وبيانات الدخول الخاصة به: ${link.systemName}`,
      previousValue: { systemName: link.systemName, url: link.url },
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `system_links/${link.id}`);
  }
}

// ---------------------------------------------------------------------------
// Authorized Users (Sensitive Admins manage; 7 core admins protected)
// ---------------------------------------------------------------------------
export async function saveAuthorizedUser(
  input: Omit<AuthorizedUser, 'id' | 'emailKey' | 'createdAt' | 'updatedAt' | 'updatedBy'>,
  existing?: AuthorizedUser
): Promise<string> {
  const normalizedEmail = normalizeEmail(input.email);
  const emailKey = emailToKey(normalizedEmail);
  const actorEmail = currentActorEmail();

  const data: Record<string, unknown> = {
    email: clampString(normalizedEmail, FIELD_LIMITS.emailMax),
    emailKey,
    displayName: clampString(input.displayName, FIELD_LIMITS.displayNameMax),
    role: input.role,
    status: input.status,
    allowedSections: input.allowedSections.slice(0, 12),
    updatedAt: serverTimestamp(),
    updatedBy: actorEmail,
  };
  if (input.notes?.trim() || existing) data.notes = clampString(input.notes || '', 500);

  try {
    if (existing) {
      await updateDoc(doc(db, 'authorized_users', emailKey), {
        displayName: data.displayName,
        role: data.role,
        status: data.status,
        allowedSections: data.allowedSections,
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        updatedAt: serverTimestamp(),
        updatedBy: actorEmail,
      });
      trackWrite(1);
      await logAuditEvent({
        section: 'إدارة المستخدمين',
        itemName: normalizedEmail,
        itemId: emailKey,
        actionType: 'update',
        summary: `تحديث صلاحيات أو حالة المستخدم: ${normalizedEmail}`,
        previousValue: existing,
        newValue: data,
      });
    } else {
      await setDoc(doc(db, 'authorized_users', emailKey), {
        ...data,
        createdAt: serverTimestamp(),
      });
      trackWrite(1);
      await logAuditEvent({
        section: 'إدارة المستخدمين',
        itemName: normalizedEmail,
        itemId: emailKey,
        actionType: 'create',
        summary: `إضافة مستخدم مصرح له: ${normalizedEmail} (${input.role})`,
        newValue: data,
      });
    }
    return emailKey;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `authorized_users/${emailKey}`);
  }
}

export async function deleteAuthorizedEmployee(user: AuthorizedUser): Promise<void> {
  await deleteDocWithAudit('authorized_users', user.emailKey, 'إدارة المستخدمين', user.email, user);
}

// ---------------------------------------------------------------------------
// Per-User Personal Preferences (Theme, Dark/Light, Favorites, Shortcuts)
// ---------------------------------------------------------------------------
export async function saveUserPreferences(
  prefs: {
    themeId: string;
    themeMode: 'light' | 'dark';
    favoriteProducts: string[];
    favoriteSituations: string[];
    favoritePolicies: string[];
    dashboardShortcuts: StaffSectionId[];
  }
): Promise<void> {
  const email = currentActorEmail();
  const key = emailToKey(email);
  if (!key || !auth.currentUser?.email) return;

  const payload = {
    emailKey: key,
    themeId: clampString(prefs.themeId, 120) || 'mashaer_classic',
    themeMode: prefs.themeMode === 'dark' ? 'dark' : 'light',
    favoriteProducts: prefs.favoriteProducts.slice(0, 100),
    favoriteSituations: prefs.favoriteSituations.slice(0, 100),
    favoritePolicies: prefs.favoritePolicies.slice(0, 100),
    dashboardShortcuts: prefs.dashboardShortcuts.slice(0, 12),
    updatedAt: serverTimestamp(),
    updatedBy: email,
  };

  try {
    await setDoc(doc(db, 'user_preferences', key), payload);
    trackWrite(1);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `user_preferences/${key}`);
  }
}

// ---------------------------------------------------------------------------
// Site Settings (Sensitive Admins Only — Branding, UI Config, Defaults, Enabled Sections)
// ---------------------------------------------------------------------------
function sanitizeLogoPlacements(raw?: Partial<LogoPlacementsMap>): LogoPlacementsMap | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {} as LogoPlacementsMap;
  for (const slotId of LOGO_SLOT_IDS) {
    const def = DEFAULT_UI_CONFIG.logoPlacements[slotId];
    const src = raw[slotId];
    const bounds = LOGO_SLOT_DIMENSION_BOUNDS[slotId];
    const rawW = typeof src?.widthPx === 'number' ? src.widthPx : def.widthPx ?? 44;
    const rawH = typeof src?.heightPx === 'number' ? src.heightPx : def.heightPx ?? 44;
    out[slotId] = {
      enabled: typeof src?.enabled === 'boolean' ? src.enabled : def.enabled,
      imageUrl: typeof src?.imageUrl === 'string' ? clampString(src.imageUrl, 125000) : def.imageUrl,
      size: src?.size || def.size,
      widthPx: Math.round(clampNumber(rawW, bounds.min, bounds.maxWidth, def.widthPx ?? 44)),
      heightPx: Math.round(clampNumber(rawH, bounds.min, bounds.maxHeight, def.heightPx ?? 44)),
      lockAspectRatio:
        typeof src?.lockAspectRatio === 'boolean' ? src.lockAspectRatio : (def.lockAspectRatio ?? true),
      fitMode: src?.fitMode === 'cover' || src?.fitMode === 'contain' ? src.fitMode : (def.fitMode ?? 'contain'),
      align: src?.align || def.align,
      displayStyle: src?.displayStyle || def.displayStyle,
      showLabel: typeof src?.showLabel === 'boolean' ? src.showLabel : def.showLabel,
      labelText: clampString(src?.labelText ?? def.labelText ?? '', 80),
    };
  }
  return out;
}

function redactUiConfigForAudit(cfg?: Partial<SiteUiConfig> | null) {
  if (!cfg) return undefined;
  const redactedLogos: Partial<Record<LogoSlotId, Record<string, unknown>>> = {};
  if (cfg.logoPlacements) {
    for (const slotId of LOGO_SLOT_IDS) {
      const slot = cfg.logoPlacements[slotId];
      if (slot) {
        redactedLogos[slotId] = {
          ...slot,
          imageUrl: slot.imageUrl ? '[image]' : '',
        };
      }
    }
  }
  return {
    ...cfg,
    heroCoverUrl: cfg.heroCoverUrl ? '[image]' : '',
    logoPlacements: Object.keys(redactedLogos).length > 0 ? redactedLogos : undefined,
  };
}

function sanitizeUiConfig(raw?: Partial<SiteUiConfig> | null): Partial<SiteUiConfig> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const sanitized = stripUndefinedDeep({
    ...raw,
    heroTitle: raw.heroTitle !== undefined ? clampString(raw.heroTitle, 200) : undefined,
    heroKicker: raw.heroKicker !== undefined ? clampString(raw.heroKicker, 300) : undefined,
    heroDescription: raw.heroDescription !== undefined ? clampString(raw.heroDescription, 1000) : undefined,
    heroCoverUrl: raw.heroCoverUrl !== undefined ? clampString(raw.heroCoverUrl, FIELD_LIMITS.coverDataUrlMax) : undefined,
    logoPlacements: raw.logoPlacements ? sanitizeLogoPlacements(raw.logoPlacements) : undefined,
    typography: raw.typography ? sanitizeTypographyConfig(raw.typography) : undefined,
    homeCustomLinks: Array.isArray(raw.homeCustomLinks)
      ? raw.homeCustomLinks.slice(0, 10).map((item) => ({
          id: clampString(item.id || makeSafeDocId('link'), 80),
          label: clampString(item.label, 120),
          url: clampString(item.url, 500),
          ...(item.note ? { note: clampString(item.note, 200) } : {}),
        }))
      : undefined,
  });
  return sanitized as Partial<SiteUiConfig>;
}

export async function saveSiteBranding(
  settings: Partial<SiteBrandingSettings>,
  previous?: SiteBrandingSettings | null
): Promise<{ schemaUpgradePending: boolean }> {
  const actorEmail = currentActorEmail();
  const merged = { ...(previous || {}), ...settings };
  const payload: Record<string, unknown> = {
    systemName: clampString(merged.systemName || 'مشاعر | Mashaer Customer Care Hub', 200),
    heroTitle: clampString(merged.heroTitle || DEFAULT_UI_CONFIG.heroTitle, 200),
    heroSubtitle: clampString(merged.heroSubtitle || DEFAULT_UI_CONFIG.heroKicker, 300),
    heroDescription: clampString(merged.heroDescription || DEFAULT_UI_CONFIG.heroDescription, 1000),
    textPosition: merged.textPosition || 'right',
    showHeroText: merged.showHeroText ?? true,
    desktopTextSize: merged.desktopTextSize || 'lg',
    mobileTextSize: merged.mobileTextSize || 'md',
    updatedAt: serverTimestamp(),
    updatedBy: actorEmail,
  };
  if (merged.logoDataUrl !== undefined) payload.logoDataUrl = clampString(merged.logoDataUrl, FIELD_LIMITS.logoDataUrlMax);
  if (merged.coverDataUrl !== undefined) payload.coverDataUrl = clampString(merged.coverDataUrl, FIELD_LIMITS.coverDataUrlMax);
  if (merged.themeMode) payload.themeMode = merged.themeMode;
  if (merged.accentTone) payload.accentTone = merged.accentTone;
  if (merged.activeThemeId) payload.activeThemeId = clampString(merged.activeThemeId, 120);
  if (merged.previousThemeId) payload.previousThemeId = clampString(merged.previousThemeId, 120);
  if (Array.isArray(merged.customThemes)) {
    payload.customThemes = stripUndefinedDeep(merged.customThemes.slice(0, 15));
  }
  const cleanUiConfig = sanitizeUiConfig(
    settings.uiConfig !== undefined
      ? settings.uiConfig
      : merged.uiConfig
  );
  if (cleanUiConfig) {
    payload.uiConfig = cleanUiConfig;
  }
  if (Array.isArray(merged.syncHistory)) {
    payload.syncHistory = stripUndefinedDeep(merged.syncHistory.slice(-30));
  }
  if (typeof merged.knowledgeSeedVersion === 'number') {
    payload.knowledgeSeedVersion = merged.knowledgeSeedVersion;
  }
  if (merged.lastStoreSyncAt) payload.lastStoreSyncAt = merged.lastStoreSyncAt;
  if (merged.lastStoreSyncStatus) payload.lastStoreSyncStatus = merged.lastStoreSyncStatus;
  if (Array.isArray(merged.enabledSections)) payload.enabledSections = merged.enabledSections.slice(0, 20);
  if (merged.wordImportedAt) payload.wordImportedAt = merged.wordImportedAt;
  if (typeof merged.wordImportCount === 'number') payload.wordImportCount = merged.wordImportCount;
  if (merged.pdfImportedAt) payload.pdfImportedAt = merged.pdfImportedAt;
  if (typeof merged.pdfImportCount === 'number') payload.pdfImportCount = merged.pdfImportCount;

  try {
    await setDoc(doc(db, 'site_settings', 'branding'), payload, { merge: true });
    trackWrite(1);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'site_settings/branding');
  }

  await logAuditEvent({
    section: 'إعدادات النظام',
    itemName: 'التصميم والواجهة والثيمات العامة',
    itemId: 'branding',
    actionType: 'update',
    summary: settings.activeThemeId
      ? `تحديث ثيم أو إعدادات الهوية العامة (${settings.activeThemeId})`
      : 'تحديث تصميم الواجهة والشعارات وعناصر الصفحة الرئيسية',
    previousValue: previous
      ? {
          ...previous,
          logoDataUrl: previous.logoDataUrl ? '[image]' : '',
          coverDataUrl: previous.coverDataUrl ? '[image]' : '',
          uiConfig: redactUiConfigForAudit(previous.uiConfig),
        }
      : undefined,
    newValue: {
      ...payload,
      logoDataUrl: payload.logoDataUrl ? '[image]' : '',
      coverDataUrl: payload.coverDataUrl ? '[image]' : '',
      uiConfig: redactUiConfigForAudit(cleanUiConfig),
    },
  });
  return { schemaUpgradePending: false };
}

export async function resetSiteDesignToDefaults(previous?: SiteBrandingSettings | null): Promise<void> {
  const actorEmail = currentActorEmail();
  const cleanDefaultUi = sanitizeUiConfig(DEFAULT_UI_CONFIG) || DEFAULT_UI_CONFIG;
  const payload: Record<string, unknown> = {
    systemName: 'مشاعر | Mashaer Customer Care Hub',
    coverDataUrl: '',
    heroTitle: DEFAULT_UI_CONFIG.heroTitle,
    heroSubtitle: DEFAULT_UI_CONFIG.heroKicker,
    heroDescription: DEFAULT_UI_CONFIG.heroDescription,
    textPosition: 'right',
    showHeroText: true,
    desktopTextSize: 'lg',
    mobileTextSize: 'md',
    uiConfig: cleanDefaultUi,
    updatedAt: serverTimestamp(),
    updatedBy: actorEmail,
  };

  try {
    await setDoc(doc(db, 'site_settings', 'branding'), payload, { merge: true });
    trackWrite(1);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'site_settings/branding');
  }

  await logAuditEvent({
    section: 'إعدادات النظام',
    itemName: 'استعادة الإعدادات الافتراضية للتصميم',
    itemId: 'branding',
    actionType: 'restore',
    summary: 'استعادة جميع عناصر التصميم والنصوص والأزرار والروابط إلى الإعدادات الافتراضية',
    previousValue: previous?.uiConfig,
    newValue: cleanDefaultUi,
  });
}

export async function saveCustomCategory(section: string, name: string): Promise<string> {
  const res = await createDocWithAudit('categories', 'cat', 'التصنيفات', name, {
    section: clampString(section, 100),
    name: clampString(name, 120),
  });
  return res.id;
}

export async function deleteCustomCategory(cat: CustomCategory): Promise<void> {
  await deleteDocWithAudit('categories', cat.id, 'التصنيفات', cat.name, cat);
}
