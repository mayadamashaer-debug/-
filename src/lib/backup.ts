import { collection, doc, getDocs, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import { logAuditEvent } from './audit';
import { trackRead, trackWrite } from './quota-monitor';
import { makeSafeDocId } from './validation';
import { CORE_ADMIN_EMAILS, emailToKey } from './auth-constants';

export const BACKUP_COLLECTIONS = [
  'customer_inquiries',
  'canned_responses',
  'policies',
  'situations',
  'return_workflow',
  'quick_phrases',
  'employee_alerts',
  'products',
  'system_links',
  'system_credentials',
  'categories',
  'site_settings',
  'authorized_users',
  'user_preferences',
  'audit_logs',
] as const;

export type BackupCollectionName = (typeof BACKUP_COLLECTIONS)[number];

export const BACKUP_COLLECTION_LABELS: Record<BackupCollectionName, string> = {
  customer_inquiries: 'استفسارات العملاء',
  canned_responses: 'مكتبة الردود الجاهزة',
  policies: 'السياسات والإجراءات',
  situations: 'دليل المواقف',
  return_workflow: 'مسار المرتجع والاسترداد',
  quick_phrases: 'العبارات السريعة',
  employee_alerts: 'تنبيهات الموظفين',
  products: 'دليل المنتجات والأسعار',
  system_links: 'روابط الأنظمة',
  system_credentials: 'بيانات دخول الأنظمة (سري)',
  categories: 'التصنيفات المخصصة',
  site_settings: 'إعدادات النظام والمظهر',
  authorized_users: 'المستخدمون المصرح لهم',
  user_preferences: 'تفضيلات المظهر والمفضلة الشخصية',
  audit_logs: 'سجل التعديلات',
};

export interface HubBackupPayload {
  schemaVersion: string;
  systemName: string;
  exportedAt: string;
  exportedBy: string;
  includesAuthPasswords: false;
  selectedCollections?: BackupCollectionName[];
  note: string;
  collections: Partial<Record<BackupCollectionName, Array<{ id: string; data: Record<string, unknown> }>>>;
}

export interface BackupPreviewSummary {
  valid: boolean;
  errors: string[];
  exportedAt?: string;
  exportedBy?: string;
  payloadSizeBytes?: number;
  counts: Record<string, number>;
  conflicts: Record<string, number>;
  totalRecords: number;
  totalConflicts: number;
  payload?: HubBackupPayload;
}

export function formatBytesAr(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ك.ب`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} م.ب`;
}

export function computePayloadSizeBytes(payload: unknown): number {
  const json = JSON.stringify(payload);
  return new TextEncoder().encode(json).length;
}

function serializeFirestoreDoc(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === 'object' && 'toDate' in v && typeof (v as { toDate: () => Date }).toDate === 'function') {
      out[k] = (v as { toDate: () => Date }).toDate().toISOString();
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function downloadBackupJson(payload: HubBackupPayload, prefix = 'mashaer-hub-backup'): number {
  const jsonStr = JSON.stringify(payload, null, 2);
  const bytes = new TextEncoder().encode(jsonStr).length;
  const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${prefix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return bytes;
}

export async function exportFullBackupFromFirestore(
  selectedCollections?: BackupCollectionName[],
  options?: { isPreRestoreSnapshot?: boolean }
): Promise<{ payload: HubBackupPayload; payloadSizeBytes: number }> {
  const user = auth.currentUser;
  const actorEmail = user?.email?.toLowerCase() || 'unknown';
  const actorName = user?.displayName || actorEmail;

  const targetCollections: BackupCollectionName[] =
    selectedCollections && selectedCollections.length > 0
      ? selectedCollections
      : [...BACKUP_COLLECTIONS];

  const collectionsData: HubBackupPayload['collections'] = {};
  let totalRecords = 0;

  for (const colName of targetCollections) {
    try {
      const snap = await getDocs(collection(db, colName));
      trackRead(Math.max(1, snap.docs.length));
      collectionsData[colName] = snap.docs.map((d) => ({
        id: d.id,
        data: serializeFirestoreDoc(d.data() as Record<string, unknown>),
      }));
      totalRecords += snap.docs.length;
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, colName);
    }
  }

  const payload: HubBackupPayload = {
    schemaVersion: '3.0',
    systemName: 'مشاعر | Mashaer Customer Care Hub',
    exportedAt: new Date().toISOString(),
    exportedBy: actorEmail,
    includesAuthPasswords: false,
    selectedCollections: targetCollections,
    note: 'تشمل هذه النسخة بيانات Firestore المحددة فقط ولا تشمل كلمات مرور حسابات Firebase Authentication أو رموز الجلسات.',
    collections: collectionsData,
  };

  const payloadSizeBytes = computePayloadSizeBytes(payload);

  const backupId = makeSafeDocId('bkp');
  try {
    await setDoc(doc(db, 'backups', backupId), {
      name: options?.isPreRestoreSnapshot
        ? `نسخة أمان تلقائية قبل الاستعادة ${new Date().toLocaleDateString('ar-KW')}`
        : `نسخة احتياطية (${targetCollections.length} مجموعة) ${new Date().toLocaleDateString('ar-KW')}`,
      action: 'export',
      createdByEmail: actorEmail,
      createdByName: actorName,
      totalRecords,
      payloadSizeBytes,
      createdAt: serverTimestamp(),
    });
    trackWrite(1);
    await logAuditEvent({
      section: 'النسخ الاحتياطي والاستعادة',
      itemName: options?.isPreRestoreSnapshot ? 'نسخة أمان تلقائية قبل الاستعادة' : 'تصدير نسخة احتياطية JSON',
      itemId: backupId,
      actionType: 'create',
      summary: `تصدير ${totalRecords} سجل (${formatBytesAr(payloadSizeBytes)}) من ${targetCollections.length} مجموعة في Firestore`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `backups/${backupId}`);
  }

  return { payload, payloadSizeBytes };
}

export async function validateAndPreviewBackupFile(file: File): Promise<BackupPreviewSummary> {
  const errors: string[] = [];
  let parsed: unknown;
  let text = '';
  try {
    text = await file.text();
    parsed = JSON.parse(text);
  } catch {
    return {
      valid: false,
      errors: ['ملف JSON غير صالح أو تالف ولا يمكن قراءته.'],
      counts: {},
      conflicts: {},
      totalRecords: 0,
      totalConflicts: 0,
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      valid: false,
      errors: ['بنية الملف غير متوافقة مع صيغة النسخة الاحتياطية.'],
      counts: {},
      conflicts: {},
      totalRecords: 0,
      totalConflicts: 0,
    };
  }

  const obj = parsed as Partial<HubBackupPayload>;
  if (!obj.collections || typeof obj.collections !== 'object') {
    errors.push('حقل collections غير موجود في ملف النسخة الاحتياطية.');
  }
  if (!obj.schemaVersion) {
    errors.push('رقم إصدار النسخة schemaVersion مفقود.');
  }

  if (errors.length > 0 || !obj.collections) {
    return {
      valid: false,
      errors,
      counts: {},
      conflicts: {},
      totalRecords: 0,
      totalConflicts: 0,
    };
  }

  const counts: Record<string, number> = {};
  const conflicts: Record<string, number> = {};
  let totalRecords = 0;
  let totalConflicts = 0;

  for (const colName of BACKUP_COLLECTIONS) {
    const arr = obj.collections[colName];
    if (!Array.isArray(arr)) {
      counts[colName] = 0;
      conflicts[colName] = 0;
      continue;
    }
    counts[colName] = arr.length;
    totalRecords += arr.length;

    if (colName === 'user_preferences') {
      conflicts[colName] = 0;
      continue;
    }

    try {
      const existingSnap = await getDocs(collection(db, colName));
      trackRead(Math.max(1, existingSnap.docs.length));
      const existingIds = new Set(existingSnap.docs.map((d) => d.id));
      const conflictCount = arr.filter((entry) => entry && existingIds.has(entry.id)).length;
      conflicts[colName] = conflictCount;
      totalConflicts += conflictCount;
    } catch {
      conflicts[colName] = 0;
    }
  }

  return {
    valid: true,
    errors: [],
    exportedAt: obj.exportedAt,
    exportedBy: obj.exportedBy,
    payloadSizeBytes: file.size || new TextEncoder().encode(text).length,
    counts,
    conflicts,
    totalRecords,
    totalConflicts,
    payload: obj as HubBackupPayload,
  };
}

export async function restoreBackupToFirestore(
  payload: HubBackupPayload,
  mode: 'merge_skip_conflicts' | 'overwrite_conflicts',
  selectedCollections?: BackupCollectionName[]
): Promise<{ restoredCount: number; skippedCount: number }> {
  const user = auth.currentUser;
  const actorEmail = user?.email?.toLowerCase() || 'unknown';
  const actorName = user?.displayName || actorEmail;

  // Never restore audit_logs or user_preferences (rules lock user_preferences per-user and audit_logs immutable)
  const allowedFilter = selectedCollections && selectedCollections.length > 0 ? new Set(selectedCollections) : null;
  const restorableCollections: BackupCollectionName[] = BACKUP_COLLECTIONS.filter(
    (c) => c !== 'audit_logs' && c !== 'user_preferences' && (!allowedFilter || allowedFilter.has(c))
  );

  const coreAdminKeys = new Set(CORE_ADMIN_EMAILS.map((e) => emailToKey(e)));

  let restoredCount = 0;
  let skippedCount = 0;

  for (const colName of restorableCollections) {
    const items = payload.collections[colName];
    if (!Array.isArray(items) || items.length === 0) continue;

    const existingSnap = await getDocs(collection(db, colName));
    trackRead(Math.max(1, existingSnap.docs.length));
    const existingIds = new Set(existingSnap.docs.map((d) => d.id));

    const chunkSize = 400;
    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      let chunkWrites = 0;

      for (const entry of chunk) {
        if (!entry || !entry.id || !entry.data || !/^[a-zA-Z0-9_-]+$/.test(entry.id)) {
          skippedCount += 1;
          continue;
        }
        if (mode === 'merge_skip_conflicts' && existingIds.has(entry.id)) {
          skippedCount += 1;
          continue;
        }

        const cleanData: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(entry.data)) {
          if (v !== undefined && v !== null && k !== 'id') {
            cleanData[k] = v;
          }
        }

        if (colName === 'authorized_users' && coreAdminKeys.has(entry.id)) {
          cleanData.role = 'admin';
          cleanData.status = 'active';
        }
        if (colName === 'system_credentials') {
          cleanData.linkId = entry.id;
        }

        if (colName === 'site_settings' || colName === 'system_credentials') {
          cleanData.updatedAt = serverTimestamp();
        } else {
          if (!existingIds.has(entry.id)) {
            cleanData.createdAt = serverTimestamp();
          } else {
            delete cleanData.createdAt;
            if (colName === 'authorized_users') {
              delete cleanData.email;
              delete cleanData.emailKey;
            }
          }
          cleanData.updatedAt = serverTimestamp();
        }
        cleanData.updatedBy = actorEmail;

        if (existingIds.has(entry.id) && colName !== 'site_settings' && colName !== 'system_credentials') {
          batch.update(doc(db, colName, entry.id), cleanData);
        } else {
          if (!cleanData.createdAt && colName !== 'site_settings' && colName !== 'system_credentials') {
            cleanData.createdAt = serverTimestamp();
          }
          batch.set(doc(db, colName, entry.id), cleanData);
        }

        chunkWrites += 1;
        restoredCount += 1;
      }

      if (chunkWrites > 0) {
        try {
          await batch.commit();
          trackWrite(chunkWrites);
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `${colName}/restore`);
        }
      }
    }
  }

  const backupId = makeSafeDocId('rst');
  try {
    await setDoc(doc(db, 'backups', backupId), {
      name: `استعادة نسخة احتياطية (${mode === 'overwrite_conflicts' ? 'تحديث المتعارض' : 'تخطي المتعارض'})`,
      action: 'restore',
      createdByEmail: actorEmail,
      createdByName: actorName,
      totalRecords: restoredCount,
      payloadSizeBytes: computePayloadSizeBytes(payload),
      createdAt: serverTimestamp(),
    });
    trackWrite(1);
    await logAuditEvent({
      section: 'النسخ الاحتياطي والاستعادة',
      itemName: 'استعادة نسخة احتياطية JSON',
      itemId: backupId,
      actionType: 'restore',
      summary: `استعادة ${restoredCount} سجل وتخطي ${skippedCount} سجل بوضع (${mode})`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `backups/${backupId}`);
  }

  return { restoredCount, skippedCount };
}
