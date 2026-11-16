import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { resolveRoleTier } from './auth-constants';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import { trackWrite } from './quota-monitor';
import { clampString, FIELD_LIMITS, makeSafeDocId } from './validation';
import type { AuditActionType } from '../types/hub';

export interface AuditInput {
  section: string;
  itemName: string;
  itemId?: string;
  actionType: AuditActionType;
  result?: 'success' | 'blocked' | 'failed';
  summary: string;
  previousValue?: unknown;
  newValue?: unknown;
}

function serializeAuditValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return clampString(raw, FIELD_LIMITS.auditTextMax);
  } catch {
    return undefined;
  }
}

export async function logAuditEvent(input: AuditInput): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.email) return;

  const logId = makeSafeDocId('audit');
  const prevStr = serializeAuditValue(input.previousValue);
  const newStr = serializeAuditValue(input.newValue);
  const tier = resolveRoleTier(user.email);

  const payload: Record<string, unknown> = {
    actorUid: user.uid,
    actorName: clampString(user.displayName || user.email, 200),
    actorEmail: clampString(user.email.toLowerCase(), 200),
    actorRole: tier,
    section: clampString(input.section, 120),
    itemName: clampString(input.itemName, 300),
    actionType: input.actionType,
    result: input.result || 'success',
    summary: clampString(input.summary, 1000),
    createdAt: serverTimestamp(),
  };

  if (input.itemId) payload.itemId = clampString(input.itemId, 128);
  if (prevStr !== undefined) payload.previousValue = prevStr;
  if (newStr !== undefined) payload.newValue = newStr;

  try {
    await setDoc(doc(db, 'audit_logs', logId), payload);
    trackWrite(1);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `audit_logs/${logId}`);
  }
}
