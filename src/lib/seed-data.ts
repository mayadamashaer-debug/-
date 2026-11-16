import { collection, doc, getDoc, getDocs, limit, query, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import { ALL_STAFF_SECTIONS, CORE_ADMIN_EMAILS, emailToKey } from './auth-constants';
import { logAuditEvent } from './audit';
import { hashString } from './validation';
import {
  MASHAER_STORE_CATALOG,
  PDF_FAQ_INQUIRIES,
  PDF_SITUATIONS_67,
  PHASE2_EMPLOYEE_ALERTS,
  PHASE2_POLICIES,
  PHASE2_QUICK_PHRASES,
  PHASE2_RETURN_STAGES,
  PHASE2_SYSTEM_LINKS,
} from './attached-pdfs-data';
import { stripUndefinedDeep } from './firestore-service';
import { DEFAULT_THEME_ID } from './themes';
import { DEFAULT_UI_CONFIG } from './ui-defaults';

export const KNOWLEDGE_SEED_VERSION = 4;

const INITIAL_CANNED_RESPONSES = [
  {
    id: 'resp_welcome',
    title: 'ترحيب ودي ببداية المحادثة',
    category: 'الترحيب',
    content: 'يا هلا وغلا أستاذي/أختي، حياك الله في مشاعر. حاضرين لك، بشنو نقدر نخدمك اليوم؟',
    internalNotes: 'يُستخدم في بداية المحادثة مع تعديل أستاذي أو أختي حسب العميل.',
  },
  {
    id: 'resp_order_check',
    title: 'طلب رقم الطلب للتحقق من الحالة',
    category: 'الطلبات',
    content: 'حاضرين أستاذي/أختي، ولا يهمك. ممكن تزودنا برقم الطلب أو رقم الموبايل المسجل عشان نشيك لك على حالة الطلب الحين؟',
    internalNotes: 'لا تعطِ موعد تسليم قبل التحقق من نظام الطلبات.',
  },
  {
    id: 'resp_payment_options',
    title: 'توضيح وسائل الدفع المتاحة',
    category: 'الدفع',
    content: 'أبشر أستاذي/أختي، متوفر عندنا الدفع عبر كي نت، فيزا، ماستركارد، أمريكان إكسبريس، Apple Pay، وبإمكانك بعد التقسيط عبر تابي وتمارا حسب الشروط المتاحة عند الدفع.',
    internalNotes: 'لا تذكر الدفع عند الاستلام قبل تأكيد الإدارة للدولة المطلوبة.',
  },
  {
    id: 'resp_shipping_followup',
    title: 'متابعة تأخر أو حالة الشحنة',
    category: 'الشحن والتوصيل',
    content: 'العذر والسموحة منك أستاذي/أختي على الانتظار. ممكن رقم الطلب عشان نتابع الشحنة مباشرة مع القسم المختص ونرجع لك بالتحديث الأكيد؟',
    internalNotes: 'ممنوع لوم شركة الشحن أو العميل أو تقديم تعويض غير معتمد.',
  },
  {
    id: 'resp_return_policy',
    title: 'توضيح شروط الضمان الذهبي والاسترجاع',
    category: 'الاسترجاع والاستبدال',
    content:
      'حاضرين أستاذي/أختي، جميع عطورنا مشمولة بالضمان الذهبي لمدة شهر كامل للتجربة الخفيفة فقط مع البوكس الكامل دون رسوم إضافية. وإذا كانت العبوة غير مفتوحة يمكنك الاسترجاع خلال ١٤ يوماً من الاستلام. تفضل رقم الطلب عشان نخدمك فوراً.',
    internalNotes: 'في حالات التلف أو الكسر نطلب صوراً واضحة ورقم الطلب فوراً.',
  },
  {
    id: 'resp_refund_review',
    title: 'استفسار عن الاسترداد المالي',
    category: 'الاسترداد المالي',
    content:
      'أبشر أستاذي/أختي، يتم رد المبلغ لنفس وسيلة الدفع المستخدمة في الطلب خلال 7 إلى 14 يوم عمل حسب البنك بعد استلام المرتجع وفحصه بالمخزن. ممكن تزودنا برقم الطلب لمتابعته؟',
    internalNotes: 'تنبيه: بيانات البطاقة لا تظهر لفريق خدمة العملاء نهائياً.',
  },
  {
    id: 'resp_products_help',
    title: 'مساعدة في اختيار العطر',
    category: 'المنتجات',
    content:
      'حياك الله أستاذي/أختي، حاضرين نرشح لك الأنسب لذوقك. تحب العطور الهادية واليومية (مثل تيفاني أو فايا) أو العطور الفواحة والرسمية للمناسبات (مثل الرئيس أو هيستوريك أو إمباير)؟',
    internalNotes: 'اعتمد جدول الترشيحات والنوتات الرسمية من دليل المنتجات.',
  },
  {
    id: 'resp_offers',
    title: 'الاستفسار عن العروض والأكواد',
    category: 'العروض',
    content: 'يا هلا أستاذي/أختي، العروض والخصومات المتاحة تظهر مباشرة على الموقع الرسمي mashaer.store وفي حال توفر كود فعال بنشاركه معك بكل سرور.',
    internalNotes: 'لا تخترع أكواد خصم غير معتمدة.',
  },
  {
    id: 'resp_wallet',
    title: 'استفسار عن رصيد المحفظة',
    category: 'المحافظ',
    content:
      'حاضرين أستاذي/أختي، رصيد المحفظة متاح للاستخدام على العطور فقط (ويُستثنى المعمول وAll Over Spray). ممكن رقم الطلب أو الإيميل المسجل عشان نشيك على رصيدك الحين؟',
    internalNotes: 'يرفع للإدارة في حال عدم وضوح الرصيد.',
  },
  {
    id: 'resp_warranty',
    title: 'استفسار عن الضمان الذهبي',
    category: 'الضمان',
    content:
      'أبشر أستاذي/أختي، كل عطورنا مشمولة بالضمان الذهبي لمدة شهر كامل للتجربة دون رسوم إضافية مع البوكس كامل بأغراضه. ممكن رقم الطلب ونوع العطر عشان نرفع الإجراء لك؟',
    internalNotes: 'خارج الكويت: بوليصة أرامكس على الإيميل (5 أيام عمل كحد أقصى). داخل الكويت: مندوب.',
  },
  {
    id: 'resp_complaint',
    title: 'احتواء شكوى العميل بأسلوب لبق',
    category: 'الشكاوى',
    content: 'العذر والسموحة منك أستاذي/أختي على هذا الموقف، رضاك يهمنا جداً في مشاعر. ممكن تزودنا برقم الطلب وتفاصيل الملاحظة عشان نرفعها للإدارة المختصة ونتابع معك حل الموضوع بأسرع وقت.',
    internalNotes: 'لا تلوم العميل ولا شركة الشحن ولا تعد بتعويض مالي أو هدية دون موافقة الإدارة.',
  },
  {
    id: 'resp_closing',
    title: 'إنهاء المحادثة بلباقة',
    category: 'إنهاء المحادثة',
    content: 'حاضرين لك في أي وقت أستاذي/أختي، تشرفنا بخدمتك ونتمنى لك يوم سعيد. وإذا احتجت أي شي ثاني لا تتردد تتواصل معنا.',
    internalNotes: 'يُستخدم بعد التأكد من إتمام خدمة العميل.',
  },
];

interface PendingWriteOp {
  collection: string;
  id: string;
  mode: 'set' | 'update';
  data: Record<string, unknown>;
}

async function commitBatchOpsSafely(ops: PendingWriteOp[]): Promise<{ committed: number; schemaUpgradePending: boolean }> {
  let committed = 0;
  const chunkSize = 350;

  for (let i = 0; i < ops.length; i += chunkSize) {
    const chunk = ops.slice(i, i + chunkSize);
    const batch = writeBatch(db);
    for (const op of chunk) {
      const ref = doc(db, op.collection, op.id);
      if (op.mode === 'update') {
        batch.update(ref, op.data);
      } else {
        batch.set(ref, op.data);
      }
    }
    await batch.commit();
    committed += chunk.length;
  }

  return { committed, schemaUpgradePending: false };
}

function normKey(text: string | undefined): string {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Idempotent, non-destructive knowledge seed: ensures 20 products (without bottle images),
 * 67 situations, 99 PDF FAQ inquiries, 15 policies, 11 system links (+ empty cred shells),
 * 5 return workflow stages, 7 quick phrases, 4 alerts, and 12 canned responses without
 * overwriting existing admin edits or re-creating deleted records once v3 is stamped.
 */
export async function seedMissingPhase2Data(options?: { forceCheck?: boolean }): Promise<{
  seeded: boolean;
  addedCount: number;
  schemaUpgradePending: boolean;
  message: string;
}> {
  const actorEmail = auth.currentUser?.email?.toLowerCase() || 'system@mashaer.store';

  try {
    const [
      brandingSnap,
      usersSnap,
      productsSnap,
      policiesSnap,
      situationsSnap,
      inquiriesSnap,
      systemsSnap,
      credsSnap,
      returnsSnap,
      phrasesSnap,
      alertsSnap,
      responsesSnap,
    ] = await Promise.all([
      getDoc(doc(db, 'site_settings', 'branding')),
      getDocs(collection(db, 'authorized_users')),
      getDocs(collection(db, 'products')),
      getDocs(collection(db, 'policies')),
      getDocs(collection(db, 'situations')),
      getDocs(collection(db, 'customer_inquiries')),
      getDocs(collection(db, 'system_links')),
      getDocs(collection(db, 'system_credentials')),
      getDocs(collection(db, 'return_workflow')),
      getDocs(collection(db, 'quick_phrases')),
      getDocs(collection(db, 'employee_alerts')),
      getDocs(collection(db, 'canned_responses')),
    ]);

    const currentSeedVersion = Number(brandingSnap.exists() ? brandingSnap.data()?.knowledgeSeedVersion || 0 : 0);
    if (
      !options?.forceCheck &&
      currentSeedVersion >= KNOWLEDGE_SEED_VERSION &&
      !productsSnap.empty &&
      !situationsSnap.empty &&
      !systemsSnap.empty
    ) {
      return {
        seeded: false,
        addedCount: 0,
        schemaUpgradePending: false,
        message: 'بيانات قاعدة المعرفة الموحدة محدثة بالفعل في Firestore.',
      };
    }

    const ops: PendingWriteOp[] = [];

    // 1. Ensure 7 equal core admins exist
    const existingUserIds = new Set(usersSnap.docs.map((d) => d.id));
    for (const email of CORE_ADMIN_EMAILS) {
      const key = emailToKey(email);
      if (!existingUserIds.has(key)) {
        ops.push({
          collection: 'authorized_users',
          id: key,
          mode: 'set',
          data: {
            email,
            emailKey: key,
            displayName: email.split('@')[0],
            role: 'admin',
            status: 'active',
            allowedSections: ALL_STAFF_SECTIONS,
            notes: 'مدير نظام بصلاحيات كاملة ومتساوية',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            updatedBy: actorEmail,
          },
        });
      }
    }

    // 2. Products (enrich missing catalog fields without bottle imageUrls or overwriting edits)
    const existingProductsById = new Map(productsSnap.docs.map((d) => [d.id, d.data()]));
    const existingProductNames = new Set(
      productsSnap.docs.map((d) => normKey(String(d.data().nameEn || d.data().nameAr || '')))
    );

    for (const p of MASHAER_STORE_CATALOG) {
      const existingData = existingProductsById.get(p.id);
      if (existingData) {
        const needsCompanionGift = existingData.companionGift === undefined && Boolean(p.companionGift);
        if (!existingData.countryPrices || !existingData.sku || !existingData.topNotes || needsCompanionGift) {
          const updateData = stripUndefinedDeep({
            sku: existingData.sku || p.sku,
            fragranceFamily: existingData.fragranceFamily || p.fragranceFamily,
            perfumeType: existingData.perfumeType || p.perfumeType,
            topNotes: existingData.topNotes || p.topNotes,
            heartNotes: existingData.heartNotes || p.heartNotes,
            baseNotes: existingData.baseNotes || p.baseNotes,
            notesAndIngredients: existingData.notesAndIngredients || p.notesAndIngredients,
            size: existingData.size && existingData.size !== 'تحتاج مراجعة الإدارة' ? existingData.size : p.size,
            availability: existingData.availability || p.availability,
            usageInstructions: existingData.usageInstructions || p.usageInstructions,
            extraInfo: existingData.extraInfo || p.extraInfo,
            companionGift: existingData.companionGift !== undefined ? existingData.companionGift : p.companionGift,
            countryPrices: existingData.countryPrices || p.countryPrices,
            sourceUrl: existingData.sourceUrl || p.sourceUrl,
            syncStatus: existingData.syncStatus || 'synced_seed',
            updatedAt: serverTimestamp(),
            updatedBy: actorEmail,
          });
          ops.push({
            collection: 'products',
            id: p.id,
            mode: 'update',
            data: updateData,
          });
        }
      } else if (!existingProductNames.has(normKey(p.nameEn || p.nameAr))) {
        const cleanProduct = stripUndefinedDeep({
          ...p,
          id: undefined,
          imageUrl: undefined,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          updatedBy: actorEmail,
        }) as Record<string, unknown>;
        ops.push({
          collection: 'products',
          id: p.id,
          mode: 'set',
          data: cleanProduct,
        });
      }
    }

    // 3. All 67 Situations (dedup by ID or situationNumber)
    const existingSitIds = new Set(situationsSnap.docs.map((d) => d.id));
    const existingSitNums = new Set(situationsSnap.docs.map((d) => String(d.data().situationNumber || '').trim()));
    for (const s of PDF_SITUATIONS_67) {
      if (!existingSitIds.has(s.id) && !existingSitNums.has(String(s.situationNumber).trim())) {
        ops.push({
          collection: 'situations',
          id: s.id,
          mode: 'set',
          data: {
            situationNumber: s.situationNumber,
            category: s.category,
            customerInquiry: s.customerInquiry,
            requiredData: s.requiredData,
            internalProcedure: s.internalProcedure,
            cannedReply: s.cannedReply,
            responsibleDept: s.responsibleDept,
            needsAdminReview: s.needsAdminReview,
            duplicateFlag: false,
            importHash: hashString(`sit_${s.situationNumber}_${s.customerInquiry}`),
            sortOrder: s.sortOrder,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            updatedBy: actorEmail,
          },
        });
      }
    }

    // 4. All 99 PDF FAQ Inquiries (dedup by ID or normalized question)
    const existingInqIds = new Set(inquiriesSnap.docs.map((d) => d.id));
    const existingQuestions = new Set(inquiriesSnap.docs.map((d) => normKey(String(d.data().question || ''))));
    for (const faq of PDF_FAQ_INQUIRIES) {
      if (!existingInqIds.has(faq.id) && !existingQuestions.has(normKey(faq.question))) {
        ops.push({
          collection: 'customer_inquiries',
          id: faq.id,
          mode: 'set',
          data: {
            question: faq.question,
            answer: faq.answer,
            category: faq.category,
            ...(faq.notes ? { notes: faq.notes } : {}),
            needsAdminReview: faq.needsAdminReview,
            source: 'word_import',
            sourceOrder: faq.sourceOrder,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            updatedBy: actorEmail,
          },
        });
      }
    }

    // 5. All 15 Structured Policies
    const existingPolicyById = new Map(policiesSnap.docs.map((d) => [d.id, d.data()]));
    const existingPolicyCats = new Set(policiesSnap.docs.map((d) => normKey(String(d.data().category || ''))));
    for (const pol of PHASE2_POLICIES) {
      const existingData = existingPolicyById.get(pol.id);
      if (existingData) {
        if (!existingData.applicableCases || !existingData.requiredAction) {
          const updatePol = stripUndefinedDeep({
            applicableCases: existingData.applicableCases || pol.applicableCases,
            conditions: existingData.conditions || pol.conditions,
            exceptions: existingData.exceptions || pol.exceptions,
            requiredAction: existingData.requiredAction || pol.requiredAction,
            suggestedReply: existingData.suggestedReply || pol.suggestedReply,
            source: existingData.source || pol.source,
            updatedAt: serverTimestamp(),
            updatedBy: actorEmail,
          });
          ops.push({
            collection: 'policies',
            id: pol.id,
            mode: 'update',
            data: updatePol,
          });
        }
      } else if (!existingPolicyCats.has(normKey(pol.category))) {
        const cleanPol = stripUndefinedDeep({
          ...pol,
          id: undefined,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          updatedBy: actorEmail,
        }) as Record<string, unknown>;
        ops.push({
          collection: 'policies',
          id: pol.id,
          mode: 'set',
          data: cleanPol,
        });
      }
    }

    // 6. All 11 Operational System Links (+ empty credential shells, ZERO fake passwords)
    const existingSystemById = new Map(systemsSnap.docs.map((d) => [d.id, d.data()]));
    const existingSystemNames = new Set(systemsSnap.docs.map((d) => normKey(String(d.data().systemName || ''))));
    const existingCredIds = new Set(credsSnap.docs.map((d) => d.id));
    for (const sys of PHASE2_SYSTEM_LINKS) {
      const existingData = existingSystemById.get(sys.id);
      if (existingData) {
        if (!existingData.mainCategory || !existingData.loginMethod) {
          const updateSys = stripUndefinedDeep({
            mainCategory: existingData.mainCategory || sys.mainCategory,
            subCategory: existingData.subCategory || sys.subCategory,
            loginMethod: existingData.loginMethod || sys.loginMethod,
            systemStatus: existingData.systemStatus || sys.systemStatus,
            otpNote: existingData.otpNote || sys.otpNote,
            updatedAt: serverTimestamp(),
            updatedBy: actorEmail,
          });
          ops.push({
            collection: 'system_links',
            id: sys.id,
            mode: 'update',
            data: updateSys,
          });
        }
        if (!existingCredIds.has(sys.id)) {
          ops.push({
            collection: 'system_credentials',
            id: sys.id,
            mode: 'set',
            data: {
              linkId: sys.id,
              usernameOrEmail: '',
              password: '',
              visibility: existingData.visibility || sys.visibility,
              updatedAt: serverTimestamp(),
              updatedBy: actorEmail,
            },
          });
        }
      } else if (!existingSystemNames.has(normKey(sys.systemName))) {
        const cleanSys = stripUndefinedDeep({
          ...sys,
          id: undefined,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          updatedBy: actorEmail,
        }) as Record<string, unknown>;
        ops.push({
          collection: 'system_links',
          id: sys.id,
          mode: 'set',
          data: cleanSys,
        });
        if (!existingCredIds.has(sys.id)) {
          ops.push({
            collection: 'system_credentials',
            id: sys.id,
            mode: 'set',
            data: {
              linkId: sys.id,
              usernameOrEmail: '',
              password: '',
              visibility: sys.visibility,
              updatedAt: serverTimestamp(),
              updatedBy: actorEmail,
            },
          });
        }
      }
    }

    // 7. Return Workflow Stages (5 stages)
    const existingRetIds = new Set(returnsSnap.docs.map((d) => d.id));
    if (returnsSnap.empty || options?.forceCheck) {
      for (const ret of PHASE2_RETURN_STAGES) {
        if (!existingRetIds.has(ret.id)) {
          ops.push({
            collection: 'return_workflow',
            id: ret.id,
            mode: 'set',
            data: {
              stageOrder: ret.stageOrder,
              stage: ret.stage,
              condition: ret.condition,
              procedure: ret.procedure,
              cannedReply: ret.cannedReply,
              employeeNote: ret.employeeNote,
              needsAdminReview: ret.needsAdminReview,
              duplicateFlag: false,
              importHash: hashString(`ret_${ret.stageOrder}_${ret.stage}`),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              updatedBy: actorEmail,
            },
          });
        }
      }
    }

    // 8. Quick Phrases (7 phrases)
    const existingPhrIds = new Set(phrasesSnap.docs.map((d) => d.id));
    if (phrasesSnap.empty || options?.forceCheck) {
      for (const phr of PHASE2_QUICK_PHRASES) {
        if (!existingPhrIds.has(phr.id)) {
          ops.push({
            collection: 'quick_phrases',
            id: phr.id,
            mode: 'set',
            data: {
              purpose: phr.purpose,
              phrase: phr.phrase,
              category: phr.category,
              duplicateFlag: false,
              importHash: hashString(`phr_${phr.purpose}`),
              sortOrder: phr.sortOrder,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              updatedBy: actorEmail,
            },
          });
        }
      }
    }

    // 9. Employee Alerts (4 rules)
    const existingAltIds = new Set(alertsSnap.docs.map((d) => d.id));
    if (alertsSnap.empty || options?.forceCheck) {
      for (const alt of PHASE2_EMPLOYEE_ALERTS) {
        if (!existingAltIds.has(alt.id)) {
          ops.push({
            collection: 'employee_alerts',
            id: alt.id,
            mode: 'set',
            data: {
              title: alt.title,
              ruleText: alt.ruleText,
              clarification: alt.clarification,
              severity: alt.severity,
              duplicateFlag: false,
              importHash: hashString(`alt_${alt.title}`),
              sortOrder: alt.sortOrder,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              updatedBy: actorEmail,
            },
          });
        }
      }
    }

    // 10. Canned Responses
    const existingRespIds = new Set(responsesSnap.docs.map((d) => d.id));
    if (responsesSnap.empty) {
      for (const resp of INITIAL_CANNED_RESPONSES) {
        if (!existingRespIds.has(resp.id)) {
          ops.push({
            collection: 'canned_responses',
            id: resp.id,
            mode: 'set',
            data: {
              title: resp.title,
              category: resp.category,
              content: resp.content,
              internalNotes: resp.internalNotes,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              updatedBy: actorEmail,
            },
          });
        }
      }
    }

    let committed = 0;
    let schemaUpgradePending = false;
    if (ops.length > 0) {
      const res = await commitBatchOpsSafely(ops);
      committed = res.committed;
      schemaUpgradePending = res.schemaUpgradePending;

      await logAuditEvent({
        section: 'إعدادات النظام',
        itemName: 'استكمال وتوحيد قاعدة المعرفة (3 ملفات)',
        actionType: 'import',
        summary: `تهيئة واستكمال ${committed} سجل من الملفات الثلاثة الرسمية في Cloud Firestore`,
      });
    }

    // Stamp knowledgeSeedVersion onto site_settings/branding (safe merge)
    if (currentSeedVersion < KNOWLEDGE_SEED_VERSION) {
      const existingBranding = brandingSnap.exists() ? brandingSnap.data() : {};
      const brandingSeedPatch = {
        systemName: existingBranding?.systemName || 'مشاعر | Mashaer Customer Care Hub',
        heroTitle: existingBranding?.heroTitle || DEFAULT_UI_CONFIG.heroTitle,
        heroSubtitle: existingBranding?.heroSubtitle || DEFAULT_UI_CONFIG.heroKicker,
        heroDescription: existingBranding?.heroDescription || DEFAULT_UI_CONFIG.heroDescription,
        activeThemeId: existingBranding?.activeThemeId || DEFAULT_THEME_ID,
        knowledgeSeedVersion: KNOWLEDGE_SEED_VERSION,
        pdfImportCount: PDF_FAQ_INQUIRIES.length,
        pdfImportedAt: new Date().toISOString(),
        updatedAt: serverTimestamp(),
        updatedBy: actorEmail,
      };
      await setDoc(doc(db, 'site_settings', 'branding'), brandingSeedPatch, { merge: true });
    }

    if (committed === 0) {
      return {
        seeded: false,
        addedCount: 0,
        schemaUpgradePending,
        message: `جميع السجلات الأساسية (${MASHAER_STORE_CATALOG.length} منتجاً، ${PDF_SITUATIONS_67.length} موقفاً، ${PDF_FAQ_INQUIRIES.length} سؤالاً، ${PHASE2_POLICIES.length} سياسة، و${PHASE2_SYSTEM_LINKS.length} نظاماً) مكتملة في قاعدة البيانات.`,
      };
    }

    return {
      seeded: true,
      addedCount: committed,
      schemaUpgradePending,
      message: schemaUpgradePending
        ? `تم استكمال ${committed} سجل بالبيانات الأساسية (ملاحظة: بعض الحقول الموسعة تتطلب اعتماد نشر تحديث firestore.rules).`
        : `تم استكمال وتوحيد ${committed} سجل من الملفات الثلاثة في Cloud Firestore بنجاح.`,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'phase2_seed');
  }
}

export async function seedInitialFirestoreData(): Promise<{ seeded: boolean; message: string }> {
  const actorEmail = auth.currentUser?.email?.toLowerCase() || 'system@mashaer.store';
  const existingBranding = await getDoc(doc(db, 'site_settings', 'branding'));
  if (!existingBranding.exists()) {
    const brandingData = {
      systemName: 'مشاعر | Mashaer Customer Care Hub',
      heroTitle: DEFAULT_UI_CONFIG.heroTitle,
      heroSubtitle: DEFAULT_UI_CONFIG.heroKicker,
      heroDescription: DEFAULT_UI_CONFIG.heroDescription,
      textPosition: 'right',
      showHeroText: true,
      desktopTextSize: 'lg',
      mobileTextSize: 'md',
      themeMode: 'light',
      accentTone: 'gold',
      activeThemeId: DEFAULT_THEME_ID,
      updatedAt: serverTimestamp(),
      updatedBy: actorEmail,
    };
    await commitBatchOpsSafely([
      {
        collection: 'site_settings',
        id: 'branding',
        mode: 'set',
        data: brandingData,
      },
    ]);
  }
  const res = await seedMissingPhase2Data({ forceCheck: true });
  return { seeded: res.seeded, message: res.message };
}
