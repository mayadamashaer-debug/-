import { GoogleGenAI, Type } from '@google/genai';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CORE_ADMIN_EMAILS = new Set([
  'rawi@mashaer.store',
  'a.ayman@mashaer.store',
  'abdoun@mashaer.store',
  'a.ashry@mashaer.store',
  's.refaat@mashaer.store',
  'sararefaat79@gmail.com',
  'mayadamashaer@gmail.com',
]);

function readFirebaseApiKey(): string {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'firebase-applet-config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { apiKey?: string };
    return (parsed.apiKey || '').trim();
  } catch {
    return '';
  }
}

async function verifyAdminBearerToken(
  authHeader: string | undefined
): Promise<{ ok: true; email: string } | { ok: false; status: number; error: string }> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'مطلوب مصادقة مدير النظام (Firebase ID Token).' };
  }
  const idToken = authHeader.slice('Bearer '.length).trim();
  if (!idToken) {
    return { ok: false, status: 401, error: 'رمز التحقق غير صالح.' };
  }

  const apiKey = readFirebaseApiKey();
  if (!apiKey) {
    return { ok: false, status: 500, error: 'تعذر قراءة إعدادات مصادقة Firebase على الخادم.' };
  }

  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) {
      return { ok: false, status: 401, error: 'انتهت صلاحية الجلسة أو الرمز غير صالح. يُرجى إعادة المحاولة.' };
    }
    const payload = (await res.json()) as {
      users?: Array<{ email?: string; emailVerified?: boolean }>;
    };
    const user = payload.users?.[0];
    const email = (user?.email || '').trim().toLowerCase();
    if (!email || !user?.emailVerified) {
      return { ok: false, status: 401, error: 'الحساب غير موثق بالبريد الإلكتروني.' };
    }
    if (!CORE_ADMIN_EMAILS.has(email)) {
      return { ok: false, status: 403, error: 'مزامنة المتجر مخصصة للمديرين السبعة المعتمدين فقط.' };
    }
    return { ok: true, email };
  } catch {
    return { ok: false, status: 502, error: 'تعذر التحقق من صلاحية الجلسة عبر خادم الهوية.' };
  }
}

const STORE_COUNTRIES = [
  { code: 'KW', prefix: 'ar-kw', nameAr: 'الكويت', currency: 'KWD' },
  { code: 'SA', prefix: 'ar-sa', nameAr: 'السعودية', currency: 'SAR' },
  { code: 'AE', prefix: 'ar-ae', nameAr: 'الإمارات', currency: 'AED' },
  { code: 'QA', prefix: 'ar-qa', nameAr: 'قطر', currency: 'QAR' },
  { code: 'BH', prefix: 'ar-bh', nameAr: 'البحرين', currency: 'BHD' },
  { code: 'OM', prefix: 'ar-om', nameAr: 'عمان', currency: 'OMR' },
] as const;

interface LiveCountryPrice {
  countryCode: string;
  countryNameAr: string;
  currency: string;
  price: number | null;
  oldPrice: number | null;
  discountPercent: number | null;
  availability: string;
  storeUrl: string;
}

interface LiveScrapedProduct {
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
  countryPrices: Record<string, LiveCountryPrice>;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function extractMeta(html: string, key: string): string {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? decodeHtmlEntities(m[1]) : '';
}

function extractProductObj(html: string): Record<string, unknown> | null {
  const match = html.match(/window\.productObj\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function detectCategory(slug: string, nameAr: string, nameEn: string): 'perfumes' | 'mamoul' | 'spray' {
  const combined = `${slug} ${nameAr} ${nameEn}`.toLowerCase();
  if (combined.includes('mamoul') || combined.includes('معمول')) return 'mamoul';
  if (combined.includes('spray') || combined.includes('سبراي')) return 'spray';
  return 'perfumes';
}

function inferSize(descAr: string, descEn: string, category: 'perfumes' | 'mamoul' | 'spray'): string {
  const text = `${descAr} ${descEn}`;
  const mlMatch = text.match(/(\d+)\s*(?:مل|ml)/i);
  if (mlMatch) return `${mlMatch[1]} مل`;
  const gmMatch = text.match(/(\d+)\s*(?:جم|غرام|g\b)/i);
  if (gmMatch) return `${gmMatch[1]} جم`;
  if (category === 'mamoul') return '30 جم';
  if (category === 'spray') return '100 مل';
  return '200 مل';
}

async function fetchWithTimeout(url: string, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MashaerCareHubSync/2.0 (+https://mashaer.store)',
        Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeCountryPage(slug: string, prefix: string) {
  const url = `https://mashaer.store/${prefix}/products/${slug}`;
  const res = await fetchWithTimeout(url, 12000);
  if (!res.ok) {
    return null;
  }
  const html = await res.text();
  if (!html || html.length < 500) return null;

  const obj = extractProductObj(html);
  const ogTitle = extractMeta(html, 'og:title');
  const ogDesc = extractMeta(html, 'og:description') || extractMeta(html, 'description');
  const ogPrice = extractMeta(html, 'product:price:amount');
  const ogCurrency = extractMeta(html, 'product:price:currency');
  const ogAvail = extractMeta(html, 'product:availability');
  const ogImage = extractMeta(html, 'og:image');

  let objImages = '';
  let sku = '';
  let priceNum: number | null = ogPrice ? Number(ogPrice) : null;
  let oldPriceNum: number | null = null;
  let avail = ogAvail || '';

  if (obj) {
    sku = typeof obj.sku === 'string' ? obj.sku : '';
    const images = Array.isArray(obj.images) ? obj.images : [];
    const firstImg = images[0] as { image?: { large?: string; medium?: string; full_size?: string } } | undefined;
    objImages = firstImg?.image?.large || firstImg?.image?.medium || firstImg?.image?.full_size || '';

    const rawPrice = typeof obj.price === 'number' ? obj.price : Number(obj.price);
    const rawSale = typeof obj.sale_price === 'number' ? obj.sale_price : obj.sale_price ? Number(obj.sale_price) : null;
    if (Number.isFinite(rawSale) && rawSale !== null && rawSale > 0 && Number.isFinite(rawPrice) && rawPrice > rawSale) {
      priceNum = rawSale;
      oldPriceNum = rawPrice;
    } else if (Number.isFinite(rawPrice) && rawPrice > 0) {
      priceNum = rawPrice;
    }

    if (!avail) {
      const qty = typeof obj.quantity === 'number' ? obj.quantity : 0;
      const isInf = Boolean(obj.is_infinite);
      avail = isInf || qty > 0 ? 'in stock' : 'out of stock';
    }
  }

  return {
    url,
    sku,
    title: ogTitle.replace(/\s*[-|]\s*(?:مشاعر|Mashaer).*$/i, '').trim(),
    description: ogDesc.trim(),
    price: Number.isFinite(priceNum) ? priceNum : null,
    oldPrice: Number.isFinite(oldPriceNum) ? oldPriceNum : null,
    currency: ogCurrency,
    availability: avail || 'out of stock',
    imageUrl: objImages || ogImage,
  };
}

async function scrapeFullMashaerCatalog(): Promise<{
  syncedAt: string;
  totalCount: number;
  products: LiveScrapedProduct[];
}> {
  const sitemapRes = await fetchWithTimeout('https://mashaer.store/sitemap_products.xml', 15000);
  if (!sitemapRes.ok) {
    throw new Error(`فشل الاتصال بخريطة منتجات المتجر (${sitemapRes.status})`);
  }
  const xml = await sitemapRes.text();
  const slugMatches = Array.from(xml.matchAll(/<loc>https:\/\/mashaer\.store\/(?:ar(?:-[a-z]{2})?\/)?products\/([^<]+)<\/loc>/gi));
  const uniqueSlugs = Array.from(new Set(slugMatches.map((m) => m[1].trim()).filter(Boolean)));

  if (uniqueSlugs.length === 0) {
    throw new Error('لم يتم العثور على روابط منتجات صالحة داخل sitemap_products.xml');
  }

  const results: LiveScrapedProduct[] = [];
  const batchSize = 4;

  for (let i = 0; i < uniqueSlugs.length; i += batchSize) {
    const chunk = uniqueSlugs.slice(i, i + batchSize);
    const chunkProducts = await Promise.all(
      chunk.map(async (slug): Promise<LiveScrapedProduct | null> => {
        const [kwData, enData, ...otherCountries] = await Promise.all([
          scrapeCountryPage(slug, 'ar-kw').catch(() => null),
          scrapeCountryPage(slug, 'en').catch(() => null),
          ...STORE_COUNTRIES.slice(1).map((c) => scrapeCountryPage(slug, c.prefix).catch(() => null)),
        ]);

        if (!kwData) return null;

        const nameAr = kwData.title || decodeURIComponent(slug);
        const nameEn = enData?.title || '';
        const category = detectCategory(slug, nameAr, nameEn);
        const descAr = kwData.description || enData?.description || nameAr;
        const size = inferSize(descAr, enData?.description || '', category);

        const countryPrices: Record<string, LiveCountryPrice> = {};
        const allPages = [kwData, ...otherCountries];

        STORE_COUNTRIES.forEach((country, idx) => {
          const pageData = allPages[idx];
          if (pageData && pageData.price !== null) {
            const discountPercent =
              pageData.oldPrice && pageData.oldPrice > pageData.price
                ? Math.round(((pageData.oldPrice - pageData.price) / pageData.oldPrice) * 100)
                : null;
            countryPrices[country.code] = {
              countryCode: country.code,
              countryNameAr: country.nameAr,
              currency: pageData.currency || country.currency,
              price: pageData.price,
              oldPrice: pageData.oldPrice,
              discountPercent,
              availability: pageData.availability,
              storeUrl: pageData.url,
            };
          } else {
            countryPrices[country.code] = {
              countryCode: country.code,
              countryNameAr: country.nameAr,
              currency: country.currency,
              price: null,
              oldPrice: null,
              discountPercent: null,
              availability: 'unavailable',
              storeUrl: `https://mashaer.store/${country.prefix}/products/${slug}`,
            };
          }
        });

        return {
          slug,
          sku: kwData.sku || enData?.sku || '',
          nameAr,
          nameEn,
          category,
          officialDescription: descAr,
          imageUrl: kwData.imageUrl || enData?.imageUrl || '',
          availability: kwData.availability === 'in stock' ? 'متوفر' : 'غير متوفر حالياً',
          size,
          sourceUrl: `https://mashaer.store/ar-kw/products/${slug}`,
          countryPrices,
        };
      })
    );

    for (const prod of chunkProducts) {
      if (prod) results.push(prod);
    }
  }

  if (results.length < 5) {
    throw new Error('البيانات المستلمة من المتجر غير مكتملة، تم إيقاف التحديث لحماية البيانات الحالية.');
  }

  return {
    syncedAt: new Date().toISOString(),
    totalCount: results.length,
    products: results,
  };
}

interface EnrichCatalogCandidate {
  id: string;
  sku?: string;
  nameAr: string;
  nameEn?: string;
  category: 'perfumes' | 'mamoul' | 'spray';
  fragranceFamily?: string;
  notesAndIngredients?: string;
}

interface EnrichRequestBody {
  product?: {
    id: string;
    sku?: string;
    nameAr: string;
    nameEn?: string;
    category: 'perfumes' | 'mamoul' | 'spray';
    officialDescription?: string;
    fragranceFamily?: string;
    fragranceCharacter?: string;
    perfumeType?: string;
    concentration?: string;
    sillage?: string;
    sillageReach?: string;
    sillageDuration?: string;
    longevity?: string;
    usageType?: string;
    occasionUsage?: string;
    seasons?: string;
    timeOfDay?: string;
    notesAndIngredients?: string;
    topNotes?: string;
    heartNotes?: string;
    baseNotes?: string;
    size?: string;
    availability?: string;
    usageInstructions?: string;
    extraInfo?: string;
    sourceUrl?: string;
    manuallyEditedFields?: string[];
  };
  catalogSummary?: EnrichCatalogCandidate[];
  targetFields?: string[];
  regenerateField?: string;
  useOfficialFetch?: boolean;
  useWebSearch?: boolean;
}

function isFilledEnrichValue(val?: string | null): boolean {
  const cleaned = (val || '').trim();
  if (!cleaned) return false;
  const low = cleaned.toLowerCase();
  return (
    cleaned !== '—' &&
    cleaned !== '-' &&
    low !== 'غير مسجل' &&
    low !== 'غير محدد' &&
    low !== 'غير معروف' &&
    !low.includes('لم تتوفر معلومات')
  );
}

function isProtectedEnrichKey(key: string, protectedFields: Set<string>): boolean {
  if (protectedFields.has(key)) return true;
  if (key === 'concentration' && protectedFields.has('perfumeType')) return true;
  if ((key === 'timeOfDay' || key === 'layeringSuggestions') && protectedFields.has('usageInstructions')) {
    return true;
  }
  if (
    (key === 'usageType' || key === 'sillageReach' || key === 'sillageDuration' || key === 'targetAudience') &&
    protectedFields.has('extraInfo')
  ) {
    return true;
  }
  return false;
}

function stripHtmlToReadableText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  ).slice(0, 6000);
}

function isSprayOrNonPerfumeCandidate(c: { category: string; nameAr?: string; nameEn?: string }): boolean {
  if (c.category !== 'perfumes') return true;
  const txt = `${c.nameAr || ''} ${c.nameEn || ''}`.toLowerCase();
  return (
    txt.includes('سبراي') ||
    txt.includes('spray') ||
    txt.includes('mist') ||
    txt.includes('معطر') ||
    txt.includes('بخاخ') ||
    txt.includes('معمول') ||
    txt.includes('mamoul')
  );
}

async function fetchOfficialProductDetails(sourceUrl: string) {
  if (!sourceUrl || !sourceUrl.startsWith('http')) return null;
  try {
    const res = await fetchWithTimeout(sourceUrl, 10000);
    if (!res.ok) return null;
    const html = await res.text();
    if (!html || html.length < 300) return null;
    const obj = extractProductObj(html);
    const ogTitle = extractMeta(html, 'og:title');
    const ogDesc = extractMeta(html, 'og:description') || extractMeta(html, 'description');
    const readableText = stripHtmlToReadableText(html);
    const objDesc =
      obj && typeof obj.description === 'string'
        ? stripHtmlToReadableText(obj.description)
        : '';
    return {
      url: sourceUrl,
      title: ogTitle,
      metaDescription: ogDesc,
      productDescription: objDesc,
      pageExcerpt: readableText.slice(0, 3500),
      sku: obj && typeof obj.sku === 'string' ? obj.sku : '',
    };
  } catch {
    return null;
  }
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function runProductEnrichment(body: EnrichRequestBody) {
  const product = body.product;
  if (!product?.nameAr) {
    throw new Error('بيانات المنتج المطلوبة غير مكتملة.');
  }

  const protectedFields = new Set(product.manuallyEditedFields || []);
  const currentFieldValues: Record<string, string | undefined> = {
    officialDescription: product.officialDescription,
    fragranceFamily: product.fragranceFamily,
    fragranceCharacter: product.fragranceCharacter,
    perfumeType: product.perfumeType,
    concentration: product.concentration,
    topNotes: product.topNotes,
    heartNotes: product.heartNotes,
    baseNotes: product.baseNotes,
    notesAndIngredients: product.notesAndIngredients,
    longevity: product.longevity,
    sillage: product.sillage,
    sillageReach: product.sillageReach,
    sillageDuration: product.sillageDuration,
    usageType: product.usageType,
    occasionUsage: product.occasionUsage,
    seasons: product.seasons,
    timeOfDay: product.timeOfDay,
    targetAudience: undefined,
    usageInstructions: product.usageInstructions,
    layeringSuggestions: undefined,
    extraInfo: product.extraInfo,
  };

  const candidateKeys = Object.keys(currentFieldValues);
  const requestedSet =
    body.targetFields && body.targetFields.length > 0 && !body.targetFields.includes('all')
      ? new Set(body.targetFields)
      : null;

  const missingFieldKeys = body.regenerateField
    ? [body.regenerateField]
    : candidateKeys.filter((key) => {
        if (requestedSet && !requestedSet.has(key)) return false;
        if (isProtectedEnrichKey(key, protectedFields)) return false;
        return !isFilledEnrichValue(currentFieldValues[key]);
      });

  if (!body.regenerateField && missingFieldKeys.length === 0) {
    return {
      productId: product.id,
      enrichedAt: new Date().toISOString(),
      fields: {},
      suggestedAlternativeIds: [],
      sourcesUsed: [],
      summaryNote: 'جميع الحقول الحالية مكتملة أو محمية بالتعديل اليدوي، ولا توجد خانات ناقصة تتطلب استكمالاً.',
    };
  }

  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('مفتاح Gemini API غير مهيأ على الخادم. يُرجى التحقق من Settings > Secrets.');
  }

  const officialInfo =
    body.useOfficialFetch !== false && product.sourceUrl
      ? await fetchOfficialProductDetails(product.sourceUrl)
      : null;

  const allowedCandidates = (body.catalogSummary || []).filter((c) => {
    if (c.id === product.id) return false;
    if (product.category === 'perfumes') {
      return !isSprayOrNonPerfumeCandidate(c);
    }
    return c.category === product.category;
  });

  // Step 2: Optional Google Search grounding for missing external official/trusted fragrance specs
  let webFindings = '';
  let groundingUrls: Array<{ title: string; uri: string }> = [];

  if (body.useWebSearch !== false) {
    try {
      const searchPrompt = `ابحث عن المعلومات الرسمية والمكونات والنوتات العطرية والثبات والفوحان ومدى الانتشار ومدة الفوحان والاستخدام والمناسبات والفصول والأوقات المناسبة لمنتج مشاعر: "${product.nameAr}" ${product.nameEn ? `(${product.nameEn})` : ''} ${product.size || ''}. ركز على موقع mashaer.store أولاً ثم المصادر العطرية الموثوقة (مثل Fragrantica أو المتاجر الرسمية). أعد ملخصاً دقيقاً بالحقائق المتوفرة فقط دون تخمين غير مسند، ولا تخلط مع منتجات أخرى مشابهة في الاسم.`;
      const searchRes = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: searchPrompt,
        config: {
          tools: [{ googleSearch: {} }],
        },
      });
      webFindings = (searchRes.text || '').slice(0, 3000);
      const chunks = searchRes.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      groundingUrls = chunks
        .map((ch) => ({
          title: ch.web?.title || 'مصدر خارجي',
          uri: ch.web?.uri || '',
        }))
        .filter((item) => item.uri.startsWith('http'))
        .slice(0, 5);
    } catch {
      // Non-fatal: proceed seamlessly using official page context + AI fragrance knowledge
    }
  }

  const missingSet = new Set(missingFieldKeys);
  const requestedFocus = body.regenerateField
    ? `ركّز حصرياً على إعادة توليد الحقل التالي فقط: "${body.regenerateField}".`
    : `استكمل الحقول الناقصة التالية فقط (يُمنع اقتراح تعديل على الحقول الممتلئة مسبقاً أو المحمية): ${missingFieldKeys.join('، ')}.`;

  const synthesisPrompt = `أنت خبير عطور ومحلل بيانات منتجات في متجر مشاعر (Mashaer). مهمتك استكمال الحقول الناقصة فقط باللغة العربية الفصحى الواضحة والاحترافية، مع التمييز الصارم بين الحقائق الرسمية والتقديرات الذكية ومنع الاختلاق.

بيانات المنتج الحالية:
${JSON.stringify(
  {
    id: product.id,
    sku: product.sku,
    nameAr: product.nameAr,
    nameEn: product.nameEn,
    category: product.category,
    size: product.size,
    officialDescription: product.officialDescription,
    fragranceFamily: product.fragranceFamily,
    fragranceCharacter: product.fragranceCharacter,
    perfumeType: product.perfumeType,
    concentration: product.concentration,
    topNotes: product.topNotes,
    heartNotes: product.heartNotes,
    baseNotes: product.baseNotes,
    notesAndIngredients: product.notesAndIngredients,
    longevity: product.longevity,
    sillage: product.sillage,
    sillageReach: product.sillageReach,
    sillageDuration: product.sillageDuration,
    usageType: product.usageType,
    occasionUsage: product.occasionUsage,
    seasons: product.seasons,
    timeOfDay: product.timeOfDay,
    usageInstructions: product.usageInstructions,
    extraInfo: product.extraInfo,
    sourceUrl: product.sourceUrl,
    manuallyEditedFields: Array.from(protectedFields),
  },
  null,
  2
)}

بيانات الصفحة الرسمية المجلوبة مباشرة من المتجر:
${officialInfo ? JSON.stringify(officialInfo, null, 2) : 'لم تتوفر استجابة مباشرة من رابط المتجر.'}

نتائج البحث الخارجي الموثوق:
${webFindings || 'لا توجد نتائج بحث خارجي إضافية.'}
روابط المصادر المستخرجة: ${JSON.stringify(groundingUrls)}

المنتجات المسموح باقتراحها كبدائل مشابهة حقيقية (يُمنع تماماً اقتراح أي منتج غير موجود في هذه القائمة، وتم استبعاد السبراي والمعطرات تلقائياً للعطور):
${JSON.stringify(allowedCandidates.slice(0, 25))}

التعليمات الحاسمة:
1. ${requestedFocus}
2. ترتيب الموثوقية الإلزامي:
   - أولاً: الموقع الرسمي لمتجر مشاعر -> sourceType = "official"
   - ثانياً: مصدر خارجي موثوق من نتائج البحث -> sourceType = "external" مع sourceUrl
   - ثالثاً: تقدير منطقي بالذكاء الاصطناعي مبني على التركيز والمكونات والنوتات وتصنيف المنتج -> sourceType = "ai_estimated"
3. يُمنع منعاً باتاً اختلاق معلومات غير مستندة لمعطيات المنتج أو نقل بيانات من منتج آخر لمجرد تشابه الاسم. إذا لم تتوفر معلومات أو مكونات كافية للاستنتاج المنطقي، ضع القيمة "غير محدد" بالضبط واجعل confidence = "low".
4. ضوابط التنسيق الإلزامية للحقول الستة الخاصة بالأداء والاستخدام (عندما تكون ضمن الحقول الناقصة):
   - longevity (الثبات بالساعات): اذكر المدة المتوقعة بالساعات مثل "تقديري: 6 إلى 8 ساعات" (أو الرقم الرسمي إن وجد)، دون مبالغة أو وعود قطعية، بحد أقصى 100 حرف.
   - sillage (مستوى الفوحان): استخدم أحد المستويات القياسية الأربعة بوضوح: "خفيف" أو "متوسط" أو "قوي" أو "قوي جداً" (مثال تقديري: "تقديري: متوسط" أو "تقديري: قوي").
   - sillageReach (مدى انتشار الرائحة): مثل "قريب (محيط شخصي)" أو "معتدل (نطاق الذراع)" أو "واسع ينتشر في المكان" أو "غير محدد".
   - sillageDuration (مدة بقاء الفوحان): اذكر مدة بقاء الفوحان الواضح إن وجدت معطيات مثل "تقديري: أول ساعتين" أو "غير محدد" إذا لم تتوفر بيانات موثوقة.
   - usageType (الاستخدام): اختر من: "يومي، رسمي، عملي، مناسبات، سهرات، استخدام متعدد" (يمكن دمج الأنسب مثل "يومي، عملي" أو "مناسبات، سهرات") أو "غير محدد".
   - occasionUsage (المناسبات): اختر الأنسب من: "العمل، الاجتماعات، الزيارات، المناسبات الرسمية، الأعراس، السهرات، الخروجات" أو "غير محدد".
   - seasons (الفصول): اختر الأنسب من: "الصيف، الشتاء، الربيع، الخريف، مناسب لكل الفصول" أو "غير محدد".
   - timeOfDay (الأوقات): اختر الأنسب من: "صباحي، نهاري، مسائي، ليلي، مناسب طوال اليوم" أو "غير محدد".
5. suggestedAlternativeIds: اختر حتى 3 معرفات (id) فقط من قائمة المنتجات المسموح بها أعلاه تكون أقرب في العائلة العطرية والنوتات والطابع. لا تضف أي سبراي لبدائل العطور!`;

  const fieldSuggestionSchema = {
    type: Type.OBJECT,
    properties: {
      value: { type: Type.STRING },
      sourceType: { type: Type.STRING, enum: ['official', 'external', 'ai_estimated'] },
      sourceLabel: { type: Type.STRING },
      sourceUrl: { type: Type.STRING },
      confidence: { type: Type.STRING, enum: ['high', 'medium', 'low'] },
      reason: { type: Type.STRING },
    },
    required: ['value', 'sourceType', 'sourceLabel', 'confidence'],
  };

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: synthesisPrompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          fields: {
            type: Type.OBJECT,
            properties: {
              officialDescription: fieldSuggestionSchema,
              fragranceFamily: fieldSuggestionSchema,
              fragranceCharacter: fieldSuggestionSchema,
              perfumeType: fieldSuggestionSchema,
              concentration: fieldSuggestionSchema,
              topNotes: fieldSuggestionSchema,
              heartNotes: fieldSuggestionSchema,
              baseNotes: fieldSuggestionSchema,
              notesAndIngredients: fieldSuggestionSchema,
              longevity: fieldSuggestionSchema,
              sillage: fieldSuggestionSchema,
              sillageReach: fieldSuggestionSchema,
              sillageDuration: fieldSuggestionSchema,
              usageType: fieldSuggestionSchema,
              occasionUsage: fieldSuggestionSchema,
              seasons: fieldSuggestionSchema,
              timeOfDay: fieldSuggestionSchema,
              targetAudience: fieldSuggestionSchema,
              usageInstructions: fieldSuggestionSchema,
              layeringSuggestions: fieldSuggestionSchema,
              extraInfo: fieldSuggestionSchema,
            },
          },
          suggestedAlternativeIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          summaryNote: { type: Type.STRING },
        },
        required: ['fields', 'suggestedAlternativeIds'],
      },
    },
  });

  const rawText = (response.text ?? '{}').trim();
  const parsed = JSON.parse(rawText) as {
    fields?: Record<string, {
      value?: string;
      sourceType?: 'official' | 'external' | 'ai_estimated';
      sourceLabel?: string;
      sourceUrl?: string;
      confidence?: 'high' | 'medium' | 'low';
      reason?: string;
    }>;
    suggestedAlternativeIds?: string[];
    summaryNote?: string;
  };

  const allowedIds = new Set(allowedCandidates.map((c) => c.id));
  const safeAlternatives = (parsed.suggestedAlternativeIds || [])
    .filter((id) => allowedIds.has(id))
    .slice(0, 3);

  const sanitizedFields: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(parsed.fields || {})) {
    if (!entry || !entry.value?.trim()) continue;
    // Server-side guards: ONLY propose missing fields (unless explicitly regenerating one field), never overwrite manual locks
    if (!body.regenerateField && !missingSet.has(key)) continue;
    if (isProtectedEnrichKey(key, protectedFields) && body.regenerateField !== key) continue;

    let safeValue = entry.value.trim();
    const lowVal = safeValue.toLowerCase();
    if (lowVal.includes('لم تتوفر معلومات') || lowVal === 'غير معروف' || lowVal === 'غير مسجل') {
      safeValue = 'غير محدد';
    }

    const srcType = entry.sourceType || 'ai_estimated';
    if (
      srcType === 'ai_estimated' &&
      (key === 'longevity' || key === 'sillage' || key === 'sillageDuration') &&
      safeValue !== 'غير محدد' &&
      !safeValue.includes('تقدير')
    ) {
      safeValue = `تقديري: ${safeValue}`;
    }

    if (key === 'longevity' || key === 'sillage') {
      safeValue = safeValue.slice(0, 120);
    } else if (key === 'occasionUsage') {
      safeValue = safeValue.slice(0, 300);
    } else if (key === 'seasons' || key === 'fragranceFamily' || key === 'fragranceCharacter' || key === 'perfumeType') {
      safeValue = safeValue.slice(0, 200);
    }

    sanitizedFields[key] = {
      value: safeValue,
      sourceType: srcType,
      sourceLabel:
        entry.sourceLabel?.trim() ||
        (srcType === 'official'
          ? 'الموقع الرسمي لمشاعر'
          : srcType === 'external'
            ? 'مصدر عطري خارجي موثوق'
            : 'تحليل وتقدير بالذكاء الاصطناعي'),
      sourceUrl:
        entry.sourceUrl?.trim() ||
        (srcType === 'official' ? product.sourceUrl || '' : groundingUrls[0]?.uri || ''),
      confidence: safeValue === 'غير محدد' ? 'low' : entry.confidence || (srcType === 'official' ? 'high' : 'medium'),
      reason: entry.reason?.trim() || '',
    };
  }

  return {
    productId: product.id,
    enrichedAt: new Date().toISOString(),
    fields: sanitizedFields,
    suggestedAlternativeIds: safeAlternatives,
    sourcesUsed: [
      ...(officialInfo ? [{ title: officialInfo.title || 'صفحة المنتج الرسمية في مشاعر', uri: officialInfo.url }] : []),
      ...groundingUrls,
    ],
    summaryNote: parsed.summaryNote || '',
  };
}

async function startServer() {
  const app = express();
  const PORT = process.env.DEFAULT_APP_PORT
    ? Number(process.env.DEFAULT_APP_PORT)
    : process.env.NODE_ENV === 'production'
      ? Number(process.env.PORT || 3000)
      : 3000;

  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'mashaer-customer-care-hub', timestamp: new Date().toISOString() });
  });

  app.post('/api/mashaer/sync', async (req, res) => {
    const authCheck = await verifyAdminBearerToken(req.headers.authorization);
    if (!authCheck.ok) {
      res.status(authCheck.status).json({ ok: false, error: authCheck.error });
      return;
    }
    try {
      const data = await scrapeFullMashaerCatalog();
      res.json({ ok: true, triggeredBy: authCheck.email, ...data });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'تعذر الاتصال بمتجر mashaer.store حالياً';
      res.status(502).json({ ok: false, error: msg });
    }
  });

  app.post('/api/products/enrich', async (req, res) => {
    const authCheck = await verifyAdminBearerToken(req.headers.authorization);
    if (!authCheck.ok) {
      res.status(authCheck.status).json({ ok: false, error: authCheck.error });
      return;
    }
    try {
      const result = await runProductEnrichment(req.body as EnrichRequestBody);
      res.json({ ok: true, triggeredBy: authCheck.email, ...result });
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : String(error);
      let userMsg = rawMsg || 'تعذر تشغيل استكمال البيانات بالذكاء الاصطناعي.';
      let status = 500;
      if (rawMsg.includes('403') || rawMsg.includes('PERMISSION_DENIED') || rawMsg.includes('API_KEY')) {
        status = 403;
        userMsg = 'تعذر التحقق من مفتاح Gemini API. يُرجى مراجعة Settings > Secrets.';
      } else if (rawMsg.includes('429') || rawMsg.includes('RESOURCE_EXHAUSTED')) {
        status = 429;
        userMsg = 'تم بلوغ حد الطلبات المؤقت لواجهة الذكاء الاصطناعي. تم حفظ تقدمك ويمكنك الاستكمال لاحقاً.';
      }
      res.status(status).json({ ok: false, error: userMsg });
    }
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: !hmrDisabled,
        ws: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Mashaer Customer Care Hub server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Mashaer server:', err);
  process.exit(1);
});
