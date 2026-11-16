import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CheckSquare,
  Download,
  FolderPlus,
  Gift,
  GitCompare,
  History,
  Layers,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Unlock,
  Wand2,
  X,
} from 'lucide-react';
import { useHub } from '../../context/HubContext';
import { GCC_COUNTRIES } from '../../lib/auth-constants';
import {
  ConcurrentEditConflictError,
  deleteCustomCategory,
  deleteProduct,
  getUpdatedAtMs,
  refreshProductFromServer,
  resolveProductSyncConflict,
  saveCustomCategory,
  saveProduct,
} from '../../lib/firestore-service';
import { normalizeArabicSearch, tokenizeArabicWithSynonyms } from '../../lib/assistant-engine';
import { parseFriendlyFirestoreError } from '../../lib/firebase';
import {
  loadUndoSnapshots,
  pushUndoSnapshot,
  removeUndoSnapshot,
  requestProductAiEnrichment,
  type AiFieldKey,
  type ProductUndoSnapshot,
} from '../../lib/product-ai-storage';
import {
  buildProductsCsvExport,
  calculateProductCompleteness,
  CATEGORY_LABELS,
  compareOlfactoryNotesAcrossProducts,
  composeExtendedGuidance,
  DEFAULT_ATTRIBUTE_FILTERS,
  detectCatalogAnomalies,
  extractExtendedGuidance,
  extractLinkedAlternativesFromNotes,
  extractProductProvenance,
  formatPriceNumber,
  isFilledFragranceValue,
  isSprayOrNonPerfumeProduct,
  LONGEVITY_ESTIMATE_DISCLAIMER,
  matchesProductAttributeFilters,
  mergeInternalNotesWithMetadata,
  OCCASION_OPTIONS,
  resolveProductStatusDisplay,
  SEASON_OPTIONS,
  SILLAGE_LEVEL_OPTIONS,
  sortProductsList,
  SOURCE_TYPE_META,
  stripSystemMarkers,
  TIME_OF_DAY_OPTIONS,
  USAGE_TYPE_OPTIONS,
  type LongevityFilterOption,
  type OccasionFilterOption,
  type ProductAttributeFilters,
  type ProductDataFilter,
  type ProductSortOption,
  type ProductStatusFilter,
  type SeasonFilterOption,
  type SillageFilterOption,
  type TimeOfDayFilterOption,
  type UsageFilterOption,
} from '../../lib/product-utils';
import { ConfirmModal } from '../ConfirmModal';
import { AiEnrichmentModal } from './products/AiEnrichmentModal';
import { CatalogHealthModal } from './products/CatalogHealthModal';
import { ProductCard } from './products/ProductCard';
import { ProductDetailsModal } from './products/ProductDetailsModal';
import type {
  CompanionGift,
  CountryCode,
  CountryPriceEntry,
  Product,
  ProductCategory,
  ProductReviewStatus,
} from '../../types/hub';

interface EditableCountryPrice {
  price: string;
  oldPrice: string;
  availability: 'in stock' | 'out of stock' | 'unavailable';
  storeUrl: string;
}

type EditableCountryPricesMap = Record<CountryCode, EditableCountryPrice>;

function buildEmptyCountryPricesForm(source?: Partial<Record<CountryCode, CountryPriceEntry>>): EditableCountryPricesMap {
  const out = {} as EditableCountryPricesMap;
  for (const c of GCC_COUNTRIES) {
    const entry = source?.[c.code];
    const availRaw = entry?.availability || 'unavailable';
    const availability: 'in stock' | 'out of stock' | 'unavailable' =
      availRaw === 'in stock' ? 'in stock' : availRaw === 'out of stock' ? 'out of stock' : 'unavailable';
    out[c.code] = {
      price: entry?.price !== null && entry?.price !== undefined ? String(entry.price) : '',
      oldPrice: entry?.oldPrice !== null && entry?.oldPrice !== undefined ? String(entry.oldPrice) : '',
      availability: entry?.price !== null && entry?.price !== undefined && availability === 'unavailable' ? 'in stock' : availability,
      storeUrl: entry?.storeUrl || '',
    };
  }
  return out;
}

export function ProductsView() {
  const {
    products: contextProducts,
    categories,
    auditLogs,
    isAdmin,
    isSensitiveAdmin,
    notify,
    dataLoading,
    branding,
    uiConfig,
    userPreferences,
    toggleFavorite,
    runTrackedMutation,
    syncingCatalog,
    syncLiveCatalog,
  } = useHub();

  const [selectedCountry, setSelectedCountry] = useState<CountryCode>('KW');
  const [activeTab, setActiveTab] = useState<'all' | ProductCategory>('all');
  const [customTagFilter, setCustomTagFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<ProductStatusFilter>('all');
  const [dataFilter, setDataFilter] = useState<ProductDataFilter>('all');
  const [attrFilters, setAttrFilters] = useState<ProductAttributeFilters>(DEFAULT_ATTRIBUTE_FILTERS);
  const [sortBy, setSortBy] = useState<ProductSortOption>('default');
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [onlyWithGift, setOnlyWithGift] = useState(false);
  const [search, setSearch] = useState('');

  // Per-card live server refresh state & overlay
  const [refreshingIds, setRefreshingIds] = useState<Record<string, boolean>>({});
  const [refreshedMap, setRefreshedMap] = useState<Record<string, Product>>({});

  // Batch Multi-Select & Phase 2 AI / Health Modals
  const [batchSelectMode, setBatchSelectMode] = useState(false);
  const [batchSelectedIds, setBatchSelectedIds] = useState<string[]>([]);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiInitialScope, setAiInitialScope] = useState<'single' | 'selected' | 'all_incomplete'>('all_incomplete');
  const [aiInitialProduct, setAiInitialProduct] = useState<Product | null>(null);
  const [healthModalOpen, setHealthModalOpen] = useState(false);
  const [healthInitialTab, setHealthInitialTab] = useState<'anomalies' | 'history'>('anomalies');
  const [undoVersion, setUndoVersion] = useState(0);

  // Custom sub-category / classification manager (stored safely in existing `categories` collection)
  const [catManagerOpen, setCatManagerOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [savingCategory, setSavingCategory] = useState(false);

  // Side-by-Side Perfume Comparison (up to 3)
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);

  // Full Fragrance Detail Modal
  const [detailProduct, setDetailProduct] = useState<Product | null>(null);

  // Admin Edit Modal & Optimistic Concurrency State
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [openedAtUpdatedMs, setOpenedAtUpdatedMs] = useState<number | null>(null);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [saving, setSaving] = useState(false);
  const [regenFieldKey, setRegenFieldKey] = useState<AiFieldKey | null>(null);

  const [sku, setSku] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [category, setCategory] = useState<ProductCategory>('perfumes');
  const [fragranceFamily, setFragranceFamily] = useState('');
  const [fragranceCharacter, setFragranceCharacter] = useState('');
  const [perfumeType, setPerfumeType] = useState('');
  const [concentration, setConcentration] = useState('');
  const [sillage, setSillage] = useState('');
  const [sillageReach, setSillageReach] = useState('');
  const [sillageDuration, setSillageDuration] = useState('');
  const [longevity, setLongevity] = useState('');
  const [usageType, setUsageType] = useState('');
  const [occasionUsage, setOccasionUsage] = useState('');
  const [seasons, setSeasons] = useState('');
  const [timeOfDay, setTimeOfDay] = useState('');
  const [targetAudience, setTargetAudience] = useState('');
  const [layeringSuggestions, setLayeringSuggestions] = useState('');
  const [officialDescription, setOfficialDescription] = useState('');
  const [notesAndIngredients, setNotesAndIngredients] = useState('');
  const [topNotes, setTopNotes] = useState('');
  const [heartNotes, setHeartNotes] = useState('');
  const [baseNotes, setBaseNotes] = useState('');
  const [size, setSize] = useState('');
  const [availability, setAvailability] = useState('');
  const [usageInstructions, setUsageInstructions] = useState('');
  const [extraInfo, setExtraInfo] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [linkedAltIds, setLinkedAltIds] = useState<string[]>([]);
  const [manualLocks, setManualLocks] = useState<string[]>([]);
  const [reviewStatus, setReviewStatus] = useState<ProductReviewStatus>('verified');
  const [sourceUrl, setSourceUrl] = useState('https://mashaer.store');
  const [hasCompanionGift, setHasCompanionGift] = useState(false);
  const [giftTitle, setGiftTitle] = useState('');
  const [giftSize, setGiftSize] = useState('');
  const [giftKind, setGiftKind] = useState<CompanionGift['kind']>('spray');
  const [giftNote, setGiftNote] = useState('');
  const [countryPricesForm, setCountryPricesForm] = useState<EditableCountryPricesMap>(() =>
    buildEmptyCountryPricesForm()
  );

  // Merge context products with any per-card freshly fetched server records
  const products = useMemo(
    () => contextProducts.map((p) => (refreshedMap[p.id] ? { ...p, ...refreshedMap[p.id] } : p)),
    [contextProducts, refreshedMap]
  );

  const productCustomCategories = useMemo(
    () => categories.filter((c) => c.section === 'products'),
    [categories]
  );

  const activeCountryMeta = GCC_COUNTRIES.find((c) => c.code === selectedCountry) || GCC_COUNTRIES[0];
  const favSet = useMemo(() => new Set(userPreferences?.favoriteProducts || []), [userPreferences?.favoriteProducts]);

  const catalogAnomalies = useMemo(() => detectCatalogAnomalies(products), [products]);

  const counts = useMemo(() => {
    let inStock = 0;
    let outOfStock = 0;
    let needsReview = 0;
    let incomplete = 0;
    let aiEstimated = 0;
    let officialOnly = 0;

    for (const p of products) {
      const st = resolveProductStatusDisplay(p, selectedCountry);
      if (st.isOutOfStock) outOfStock += 1;
      else inStock += 1;
      if (st.needsReview) needsReview += 1;

      const comp = calculateProductCompleteness(p);
      if (!comp.isComplete) incomplete += 1;
      if (comp.hasAiEstimates) aiEstimated += 1;
      if (comp.hasOfficialData && !comp.hasAiEstimates) officialOnly += 1;
    }
    return {
      all: products.length,
      perfumes: products.filter((p) => p.category === 'perfumes').length,
      mamoul: products.filter((p) => p.category === 'mamoul').length,
      spray: products.filter((p) => p.category === 'spray').length,
      withGift: products.filter((p) => Boolean(p.companionGift?.title)).length,
      inStock,
      outOfStock,
      needsReview,
      incomplete,
      aiEstimated,
      officialOnly,
      anomalies: catalogAnomalies.affectedProductIds.size,
    };
  }, [products, selectedCountry, catalogAnomalies]);

  const filtered = useMemo(() => {
    const qNorm = normalizeArabicSearch(search.trim());
    const qTokens = qNorm ? tokenizeArabicWithSynonyms(search) : [];
    const tagNorm = normalizeArabicSearch(customTagFilter);

    const matched = products.filter((p) => {
      if (activeTab !== 'all' && p.category !== activeTab) return false;
      if (onlyFavorites && !favSet.has(p.id)) return false;
      if (onlyWithGift && !p.companionGift?.title) return false;

      const st = resolveProductStatusDisplay(p, selectedCountry);
      if (statusFilter === 'verified_in_stock' && (st.isOutOfStock || st.needsReview)) return false;
      if (statusFilter === 'in_stock' && st.isOutOfStock) return false;
      if (statusFilter === 'out_of_stock' && !st.isOutOfStock) return false;
      if (statusFilter === 'needs_review' && !st.needsReview) return false;

      if (dataFilter !== 'all') {
        const comp = calculateProductCompleteness(p);
        if (dataFilter === 'incomplete' && comp.isComplete) return false;
        if (dataFilter === 'ai_estimated' && !comp.hasAiEstimates) return false;
        if (dataFilter === 'official_only' && (!comp.hasOfficialData || comp.hasAiEstimates)) return false;
        if (dataFilter === 'needs_review' && !st.needsReview) return false;
        if (dataFilter === 'anomalies' && !catalogAnomalies.affectedProductIds.has(p.id)) return false;
      }

      if (!matchesProductAttributeFilters(p, attrFilters)) return false;

      if (tagNorm) {
        const tagHaystack = normalizeArabicSearch(
          `${p.perfumeType || ''} ${p.fragranceFamily || ''} ${p.fragranceCharacter || ''} ${p.occasionUsage || ''}`
        );
        if (!tagHaystack.includes(tagNorm)) return false;
      }

      if (!qNorm) return true;
      const ext = extractExtendedGuidance(p);
      const haystack = normalizeArabicSearch(
        `${p.nameAr} ${p.nameEn || ''} ${p.sku || ''} ${p.officialDescription} ${p.fragranceFamily || ''} ${p.fragranceCharacter || ''} ${p.perfumeType || ''} ${p.longevity || ''} ${p.sillage || ''} ${ext.sillageReach} ${ext.sillageDuration} ${ext.usageType} ${p.occasionUsage || ''} ${p.seasons || ''} ${ext.timeOfDay} ${p.notesAndIngredients || ''} ${p.topNotes || ''} ${p.heartNotes || ''} ${p.baseNotes || ''} ${p.usageInstructions || ''} ${p.extraInfo || ''} ${p.companionGift?.title || ''} ${p.companionGift?.size || ''} ${p.companionGift?.compositionNote || ''}`
      );
      if (haystack.includes(qNorm)) return true;
      return qTokens.some((t) => haystack.includes(t));
    });

    return sortProductsList(matched, sortBy, selectedCountry);
  }, [
    products,
    activeTab,
    onlyFavorites,
    onlyWithGift,
    favSet,
    statusFilter,
    dataFilter,
    attrFilters,
    catalogAnomalies,
    customTagFilter,
    selectedCountry,
    search,
    sortBy,
  ]);

  const compareProducts = useMemo(
    () => compareIds.map((id) => products.find((p) => p.id === id)).filter((p): p is Product => Boolean(p)),
    [compareIds, products]
  );

  const noteComparison = useMemo(
    () => compareOlfactoryNotesAcrossProducts(compareProducts),
    [compareProducts]
  );

  const latestDetailUndoSnapshot = useMemo(() => {
    if (!detailProduct) return null;
    return loadUndoSnapshots(detailProduct.id)[0] || null;
  }, [detailProduct?.id, undoVersion]);

  const hasAttrFilterActive =
    attrFilters.longevity !== 'all' ||
    attrFilters.sillage !== 'all' ||
    attrFilters.usage !== 'all' ||
    attrFilters.occasion !== 'all' ||
    attrFilters.season !== 'all' ||
    attrFilters.timeOfDay !== 'all';

  const hasActiveFilters = Boolean(
    onlyWithGift ||
      onlyFavorites ||
      statusFilter !== 'all' ||
      dataFilter !== 'all' ||
      hasAttrFilterActive ||
      activeTab !== 'all' ||
      customTagFilter ||
      sortBy !== 'default' ||
      search
  );

  const resetAllFilters = () => {
    setActiveTab('all');
    setCustomTagFilter('');
    setOnlyFavorites(false);
    setOnlyWithGift(false);
    setStatusFilter('all');
    setDataFilter('all');
    setAttrFilters(DEFAULT_ATTRIBUTE_FILTERS);
    setSortBy('default');
    setSearch('');
  };

  const handleExportCsv = () => {
    try {
      const csv = buildProductsCsvExport(filtered, selectedCountry);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mashaer-products-${selectedCountry.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify('success', `تم تصدير ${filtered.length} منتجاً إلى ملف CSV مع كافة الخصائص العطرية الستة.`);
    } catch {
      notify('error', 'تعذر إنشاء ملف التصدير CSV.');
    }
  };

  const toggleCompare = (id: string) => {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 3) {
        notify('info', 'يمكن مقارنة 3 منتجات كحد أقصى في نفس الوقت.');
        return prev;
      }
      return [...prev, id];
    });
  };

  const handleQuickNotifyCopy = async (label: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      notify('success', `تم نسخ ${label} إلى الحافظة.`);
    } catch {
      notify('error', 'تعذر النسخ تلقائياً. يُرجى النسخ يدوياً.');
    }
  };

  const handleRefreshSingleProduct = async (item: Product) => {
    setRefreshingIds((prev) => ({ ...prev, [item.id]: true }));
    try {
      const fresh = await refreshProductFromServer(item.id);
      if (fresh) {
        setRefreshedMap((prev) => ({ ...prev, [item.id]: fresh }));
        if (detailProduct?.id === item.id) {
          setDetailProduct(fresh);
        }
        notify('success', `تم تحديث بيانات «${fresh.nameAr}» من السحابة.`);
      } else {
        notify('info', `بيانات «${item.nameAr}» محدثة وفق النسخة المرجعية الحالية.`);
      }
    } catch (err) {
      notify('error', parseFriendlyFirestoreError(err));
    } finally {
      setRefreshingIds((prev) => ({ ...prev, [item.id]: false }));
    }
  };

  const handleAddCustomCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newCategoryName.trim();
    if (!trimmed) return;
    if (productCustomCategories.some((c) => c.name === trimmed)) {
      notify('info', 'هذا التصنيف موجود بالفعل.');
      return;
    }
    setSavingCategory(true);
    try {
      await runTrackedMutation(() => saveCustomCategory('products', trimmed));
      setNewCategoryName('');
      notify('success', `تمت إضافة التصنيف الإضافي «${trimmed}».`);
    } catch (err) {
      notify('error', parseFriendlyFirestoreError(err));
    } finally {
      setSavingCategory(false);
    }
  };

  const handleDeleteCustomCategory = async (catId: string) => {
    const cat = productCustomCategories.find((c) => c.id === catId);
    if (!cat) return;
    setSavingCategory(true);
    try {
      await runTrackedMutation(() => deleteCustomCategory(cat));
      if (customTagFilter === cat.name) setCustomTagFilter('');
      notify('success', `تم حذف التصنيف «${cat.name}».`);
    } catch (err) {
      notify('error', parseFriendlyFirestoreError(err));
    } finally {
      setSavingCategory(false);
    }
  };

  const populateFormFromProduct = (item: Product) => {
    const ext = extractExtendedGuidance(item);
    setSku(item.sku || '');
    setNameAr(item.nameAr);
    setNameEn(item.nameEn || '');
    setCategory(item.category);
    setFragranceFamily(item.fragranceFamily || '');
    setFragranceCharacter(item.fragranceCharacter || '');
    setPerfumeType(ext.cleanPerfumeType || '');
    setConcentration(ext.concentration || '');
    setSillage(item.sillage || '');
    setSillageReach(ext.sillageReach || '');
    setSillageDuration(ext.sillageDuration || '');
    setLongevity(item.longevity || '');
    setUsageType(ext.usageType || '');
    setOccasionUsage(item.occasionUsage || '');
    setSeasons(item.seasons || '');
    setTimeOfDay(ext.timeOfDay || '');
    setTargetAudience(ext.targetAudience || '');
    setLayeringSuggestions(ext.layeringSuggestions || '');
    setOfficialDescription(item.officialDescription);
    setNotesAndIngredients(item.notesAndIngredients || '');
    setTopNotes(item.topNotes || '');
    setHeartNotes(item.heartNotes || '');
    setBaseNotes(item.baseNotes || '');
    setSize(item.size || '');
    setAvailability(item.availability || '');
    setUsageInstructions(ext.cleanUsageInstructions || '');
    setExtraInfo(ext.cleanExtraInfo || '');
    setInternalNotes(stripSystemMarkers(item.internalNotes));
    setLinkedAltIds(
      extractLinkedAlternativesFromNotes(item.internalNotes).filter((altKey) => {
        const matched = products.find((p) => p.id === altKey || p.sku?.toLowerCase() === altKey.toLowerCase());
        if (!matched) return true;
        return item.category !== 'perfumes' || !isSprayOrNonPerfumeProduct(matched);
      })
    );
    setManualLocks(item.manuallyEditedFields || []);
    setReviewStatus(item.reviewStatus);
    setSourceUrl(item.sourceUrl || 'https://mashaer.store');
    if (item.companionGift?.title) {
      setHasCompanionGift(true);
      setGiftTitle(item.companionGift.title);
      setGiftSize(item.companionGift.size || '');
      setGiftKind(item.companionGift.kind || 'spray');
      setGiftNote(item.companionGift.compositionNote || '');
    } else {
      setHasCompanionGift(false);
      setGiftTitle('');
      setGiftSize('');
      setGiftKind('spray');
      setGiftNote('');
    }
    setCountryPricesForm(buildEmptyCountryPricesForm(item.countryPrices));
  };

  const openAdd = () => {
    setEditing(null);
    setOpenedAtUpdatedMs(null);
    setConflictMsg(null);
    setSku('');
    setNameAr('');
    setNameEn('');
    setCategory(activeTab === 'all' ? 'perfumes' : activeTab);
    setFragranceFamily('');
    setFragranceCharacter('');
    setPerfumeType('');
    setConcentration('');
    setSillage('');
    setSillageReach('');
    setSillageDuration('');
    setLongevity('');
    setUsageType('');
    setOccasionUsage('');
    setSeasons('');
    setTimeOfDay('');
    setTargetAudience('');
    setLayeringSuggestions('');
    setOfficialDescription('');
    setNotesAndIngredients('');
    setTopNotes('');
    setHeartNotes('');
    setBaseNotes('');
    setSize('200 مل');
    setAvailability('متوفر');
    setUsageInstructions('');
    setExtraInfo('');
    setInternalNotes('');
    setLinkedAltIds([]);
    setManualLocks([]);
    setReviewStatus('verified');
    setSourceUrl('https://mashaer.store');
    setHasCompanionGift(false);
    setGiftTitle('');
    setGiftSize('');
    setGiftKind('spray');
    setGiftNote('');
    setCountryPricesForm(buildEmptyCountryPricesForm());
    setModalOpen(true);
  };

  const openEdit = (item: Product) => {
    setEditing(item);
    setOpenedAtUpdatedMs(getUpdatedAtMs(item.updatedAt));
    setConflictMsg(null);
    populateFormFromProduct(item);
    setModalOpen(true);
  };

  const toggleManualFieldLock = (fieldKey: string) => {
    setManualLocks((prev) =>
      prev.includes(fieldKey) ? prev.filter((x) => x !== fieldKey) : [...prev, fieldKey]
    );
  };

  const toggleTokenValue = (current: string, token: string, setter: (next: string) => void) => {
    const clean = current.trim();
    if (!clean || clean === 'غير محدد') {
      setter(token);
      return;
    }
    const parts = clean
      .split(/[،,]+/)
      .map((p) => p.trim())
      .filter((p) => Boolean(p) && p !== 'غير محدد');
    if (parts.includes(token)) {
      setter(parts.filter((p) => p !== token).join('، '));
    } else {
      setter([...parts, token].join('، '));
    }
  };

  const toggleLinkedAlt = (altId: string) => {
    setLinkedAltIds((prev) => {
      if (prev.includes(altId)) return prev.filter((x) => x !== altId);
      if (prev.length >= 3) {
        notify('info', 'يمكن ربط 3 بدائل مشابهة كحد أقصى لكل منتج.');
        return prev;
      }
      return [...prev, altId];
    });
  };

  const toggleBatchSelect = (productId: string) => {
    setBatchSelectedIds((prev) =>
      prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId]
    );
  };

  const openAiEnrichModal = (scope: 'single' | 'selected' | 'all_incomplete', target?: Product) => {
    setAiInitialScope(scope);
    setAiInitialProduct(target || null);
    setAiModalOpen(true);
  };

  const handleRegenerateFieldInline = async (fieldKey: AiFieldKey) => {
    if (!editing) {
      notify('info', 'احفظ المنتج أولاً أو أدخل اسمه لإعادة توليد الحقل.');
      return;
    }
    setRegenFieldKey(fieldKey);
    try {
      const composed = composeExtendedGuidance(
        {
          perfumeType: perfumeType.trim(),
          usageInstructions: usageInstructions.trim(),
          extraInfo: extraInfo.trim(),
        },
        {
          concentration: concentration.trim(),
          timeOfDay: timeOfDay.trim(),
          usageType: usageType.trim(),
          sillageReach: sillageReach.trim(),
          sillageDuration: sillageDuration.trim(),
          targetAudience: targetAudience.trim(),
          layeringSuggestions: layeringSuggestions.trim(),
        }
      );
      const tempProd: Product = {
        ...editing,
        nameAr: nameAr || editing.nameAr,
        nameEn: nameEn || editing.nameEn,
        category,
        officialDescription: officialDescription || editing.officialDescription,
        fragranceFamily,
        fragranceCharacter,
        perfumeType: composed.perfumeType,
        topNotes,
        heartNotes,
        baseNotes,
        notesAndIngredients,
        longevity,
        sillage,
        occasionUsage,
        seasons,
        usageInstructions: composed.usageInstructions,
        extraInfo: composed.extraInfo,
        sourceUrl,
        manuallyEditedFields: manualLocks,
      };
      const draft = await requestProductAiEnrichment({
        product: tempProd,
        allProducts: products,
        regenerateField: fieldKey,
        useOfficialFetch: true,
        useWebSearch: true,
        bypassCache: true,
      });
      const val = draft.fields[fieldKey]?.value?.trim();
      if (!val) {
        notify('info', 'لم تتوفر معطيات جديدة لهذا الحقل.');
        return;
      }
      if (fieldKey === 'officialDescription') setOfficialDescription(val);
      else if (fieldKey === 'fragranceFamily') setFragranceFamily(val);
      else if (fieldKey === 'fragranceCharacter') setFragranceCharacter(val);
      else if (fieldKey === 'perfumeType') setPerfumeType(val);
      else if (fieldKey === 'concentration') setConcentration(val);
      else if (fieldKey === 'topNotes') setTopNotes(val);
      else if (fieldKey === 'heartNotes') setHeartNotes(val);
      else if (fieldKey === 'baseNotes') setBaseNotes(val);
      else if (fieldKey === 'notesAndIngredients') setNotesAndIngredients(val);
      else if (fieldKey === 'longevity') setLongevity(val);
      else if (fieldKey === 'sillage') setSillage(val);
      else if (fieldKey === 'sillageReach') setSillageReach(val);
      else if (fieldKey === 'sillageDuration') setSillageDuration(val);
      else if (fieldKey === 'usageType') setUsageType(val);
      else if (fieldKey === 'occasionUsage') setOccasionUsage(val);
      else if (fieldKey === 'seasons') setSeasons(val);
      else if (fieldKey === 'timeOfDay') setTimeOfDay(val);
      else if (fieldKey === 'targetAudience') setTargetAudience(val);
      else if (fieldKey === 'layeringSuggestions') setLayeringSuggestions(val);
      else if (fieldKey === 'usageInstructions') setUsageInstructions(val);
      else if (fieldKey === 'extraInfo') setExtraInfo(val);

      notify('success', 'تم توليد مقترح جديد للحقل — يمكنك مراجعته أو تعديله ثم الضغط على حفظ التغييرات.');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'تعذر إعادة توليد الحقل');
    } finally {
      setRegenFieldKey(null);
    }
  };

  const submitSaveProduct = async (forceOverwrite = false) => {
    if (!nameAr.trim() || !officialDescription.trim()) {
      notify('error', 'يُرجى إدخال اسم المنتج العربي والوصف الرسمي.');
      return;
    }

    if (hasCompanionGift && !giftTitle.trim()) {
      notify('error', 'يُرجى إدخال اسم/حجم الهدية المصاحبة أو إلغاء تفعيل خيار الهدية.');
      return;
    }

    const builtCountryPrices: Partial<Record<CountryCode, CountryPriceEntry>> = {};
    for (const c of GCC_COUNTRIES) {
      const row = countryPricesForm[c.code];
      const parsedPrice = row.price.trim() !== '' && Number.isFinite(Number(row.price)) ? Number(row.price) : null;
      const parsedOld =
        row.oldPrice.trim() !== '' && Number.isFinite(Number(row.oldPrice)) ? Number(row.oldPrice) : null;
      const discountPercent =
        parsedPrice !== null && parsedOld !== null && parsedOld > parsedPrice
          ? Math.round(((parsedOld - parsedPrice) / parsedOld) * 100)
          : null;
      builtCountryPrices[c.code] = {
        countryCode: c.code,
        countryNameAr: c.nameAr,
        currency: c.currency,
        price: parsedPrice,
        oldPrice: parsedOld,
        discountPercent,
        availability: parsedPrice !== null && row.availability === 'unavailable' ? 'in stock' : row.availability,
        ...(row.storeUrl.trim() ? { storeUrl: row.storeUrl.trim() } : {}),
      };
    }

    const nextCompanionGift: CompanionGift | null =
      hasCompanionGift && giftTitle.trim()
        ? {
            title: giftTitle.trim(),
            size: giftSize.trim(),
            kind: giftKind,
            compositionNote: giftNote.trim(),
          }
        : null;

    const composed = composeExtendedGuidance(
      {
        perfumeType: perfumeType.trim(),
        usageInstructions: usageInstructions.trim(),
        extraInfo: extraInfo.trim(),
      },
      {
        concentration: concentration.trim(),
        timeOfDay: timeOfDay.trim(),
        usageType: usageType.trim(),
        sillageReach: sillageReach.trim(),
        sillageDuration: sillageDuration.trim(),
        targetAudience: targetAudience.trim(),
        layeringSuggestions: layeringSuggestions.trim(),
      }
    );

    // Filter linked alternatives strictly so perfumes never link sprays
    const safeAltIds = linkedAltIds.filter((id) => {
      const cand = products.find((p) => p.id === id);
      if (!cand || cand.id === editing?.id) return false;
      return category !== 'perfumes' || !isSprayOrNonPerfumeProduct(cand);
    });

    const existingProvenance = editing ? extractProductProvenance(editing) : {};
    const mergedInternalNotes = mergeInternalNotesWithMetadata(
      internalNotes.trim(),
      safeAltIds,
      existingProvenance
    );

    // Compute granular updated manual locks honoring any unlock actions
    const nextManualLocks = new Set(manualLocks);
    if (editing) {
      const prevExt = extractExtendedGuidance(editing);
      const changedMap: Array<[string, string, string]> = [
        ['nameAr', nameAr.trim(), editing.nameAr || ''],
        ['nameEn', nameEn.trim(), editing.nameEn || ''],
        ['officialDescription', officialDescription.trim(), editing.officialDescription || ''],
        ['fragranceFamily', fragranceFamily.trim(), editing.fragranceFamily || ''],
        ['fragranceCharacter', fragranceCharacter.trim(), editing.fragranceCharacter || ''],
        ['perfumeType', perfumeType.trim(), prevExt.cleanPerfumeType || ''],
        ['concentration', concentration.trim(), prevExt.concentration || ''],
        ['sillage', sillage.trim(), editing.sillage || ''],
        ['sillageReach', sillageReach.trim(), prevExt.sillageReach || ''],
        ['sillageDuration', sillageDuration.trim(), prevExt.sillageDuration || ''],
        ['longevity', longevity.trim(), editing.longevity || ''],
        ['usageType', usageType.trim(), prevExt.usageType || ''],
        ['occasionUsage', occasionUsage.trim(), editing.occasionUsage || ''],
        ['seasons', seasons.trim(), editing.seasons || ''],
        ['timeOfDay', timeOfDay.trim(), prevExt.timeOfDay || ''],
        ['targetAudience', targetAudience.trim(), prevExt.targetAudience || ''],
        ['layeringSuggestions', layeringSuggestions.trim(), prevExt.layeringSuggestions || ''],
        ['notesAndIngredients', notesAndIngredients.trim(), editing.notesAndIngredients || ''],
        ['topNotes', topNotes.trim(), editing.topNotes || ''],
        ['heartNotes', heartNotes.trim(), editing.heartNotes || ''],
        ['baseNotes', baseNotes.trim(), editing.baseNotes || ''],
        ['size', size.trim(), editing.size || ''],
        ['availability', availability.trim(), editing.availability || ''],
        ['usageInstructions', usageInstructions.trim(), prevExt.cleanUsageInstructions || ''],
        ['extraInfo', extraInfo.trim(), prevExt.cleanExtraInfo || ''],
        ['sourceUrl', sourceUrl.trim(), editing.sourceUrl || ''],
      ];
      for (const [k, nextV, prevV] of changedMap) {
        if (nextV !== prevV.trim()) {
          nextManualLocks.add(k);
        }
      }
    }

    setSaving(true);
    setConflictMsg(null);
    try {
      if (editing) {
        pushUndoSnapshot(editing, 'تعديل يدوي في بيانات المنتج');
        setUndoVersion((v) => v + 1);
      }
      await runTrackedMutation(() =>
        saveProduct(
          {
            sku: sku.trim(),
            nameAr: nameAr.trim(),
            nameEn: nameEn.trim(),
            category,
            fragranceFamily: fragranceFamily.trim().slice(0, 200),
            fragranceCharacter: fragranceCharacter.trim().slice(0, 200),
            perfumeType: composed.perfumeType,
            sillage: sillage.trim().slice(0, 120),
            longevity: longevity.trim().slice(0, 120),
            occasionUsage: occasionUsage.trim().slice(0, 300),
            seasons: seasons.trim().slice(0, 200),
            officialDescription: officialDescription.trim(),
            notesAndIngredients: notesAndIngredients.trim(),
            topNotes: topNotes.trim(),
            heartNotes: heartNotes.trim(),
            baseNotes: baseNotes.trim(),
            size: size.trim(),
            availability: availability.trim(),
            usageInstructions: composed.usageInstructions,
            extraInfo: composed.extraInfo,
            internalNotes: mergedInternalNotes,
            companionGift: nextCompanionGift,
            countryPrices: builtCountryPrices,
            priceHistory: editing?.priceHistory,
            manuallyEditedFields: Array.from(nextManualLocks).slice(0, 35),
            syncConflictNote: editing?.syncConflictNote,
            lastSyncedAt: editing?.lastSyncedAt,
            syncStatus: editing?.syncStatus || 'manual_saved',
            reviewStatus,
            sourceUrl: sourceUrl.trim(),
            sortOrder: editing?.sortOrder ?? products.length + 1,
          },
          editing || undefined,
          editing
            ? {
                expectedUpdatedAtMs: openedAtUpdatedMs,
                forceOverwrite,
                preserveExplicitManualFields: true,
              }
            : undefined
        )
      );
      notify('success', editing ? 'تم تحديث بيانات المنتج وحقوله في Firestore.' : 'تمت إضافة المنتج إلى Firestore بنجاح.');
      setModalOpen(false);
    } catch (err) {
      if (err instanceof ConcurrentEditConflictError) {
        setConflictMsg(err.message);
      } else {
        notify('error', parseFriendlyFirestoreError(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleUndoSnapshot = async (snap: ProductUndoSnapshot) => {
    const current = products.find((p) => p.id === snap.productId);
    if (!current) return;
    try {
      const prev = snap.previousProduct;
      await runTrackedMutation(() =>
        saveProduct(
          {
            sku: prev.sku || '',
            nameAr: prev.nameAr,
            nameEn: prev.nameEn || '',
            category: prev.category,
            officialDescription: prev.officialDescription,
            fragranceFamily: prev.fragranceFamily || '',
            fragranceCharacter: prev.fragranceCharacter || '',
            perfumeType: prev.perfumeType || '',
            sillage: prev.sillage || '',
            longevity: prev.longevity || '',
            occasionUsage: prev.occasionUsage || '',
            seasons: prev.seasons || '',
            notesAndIngredients: prev.notesAndIngredients || '',
            topNotes: prev.topNotes || '',
            heartNotes: prev.heartNotes || '',
            baseNotes: prev.baseNotes || '',
            size: prev.size || '',
            availability: prev.availability || '',
            usageInstructions: prev.usageInstructions || '',
            extraInfo: prev.extraInfo || '',
            internalNotes: prev.internalNotes || '',
            companionGift: prev.companionGift ?? null,
            countryPrices: prev.countryPrices,
            priceHistory: prev.priceHistory,
            manuallyEditedFields: prev.manuallyEditedFields || [],
            syncConflictNote: prev.syncConflictNote || '',
            lastSyncedAt: prev.lastSyncedAt,
            syncStatus: prev.syncStatus || 'restored_undo',
            reviewStatus: prev.reviewStatus,
            sourceUrl: prev.sourceUrl || '',
            sortOrder: prev.sortOrder,
          },
          current,
          { forceOverwrite: true, preserveExplicitManualFields: true }
        )
      );
      removeUndoSnapshot(snap.snapshotId);
      setUndoVersion((v) => v + 1);
      setDetailProduct(prev);
      notify('success', `تم التراجع واستعادة النسخة السابقة من «${snap.productNameAr}».`);
    } catch (err) {
      notify('error', parseFriendlyFirestoreError(err));
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    submitSaveProduct(false);
  };

  const handleReloadLatestProduct = () => {
    if (!editing) return;
    const latest = products.find((p) => p.id === editing.id);
    if (!latest) return;
    setEditing(latest);
    setOpenedAtUpdatedMs(getUpdatedAtMs(latest.updatedAt));
    populateFormFromProduct(latest);
    setConflictMsg(null);
    notify('info', 'تم تحميل أحدث نسخة محفوظة في السحابة.');
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await runTrackedMutation(() => deleteProduct(deleteTarget));
      if (detailProduct?.id === deleteTarget.id) setDetailProduct(null);
      setCompareIds((prev) => prev.filter((id) => id !== deleteTarget.id));
      notify('success', 'تم حذف المنتج.');
      setDeleteTarget(null);
    } catch (err) {
      notify('error', parseFriendlyFirestoreError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleResolveConflict = async (p: Product) => {
    try {
      await runTrackedMutation(() => resolveProductSyncConflict(p));
      setDetailProduct((prev) => (prev && prev.id === p.id ? { ...prev, syncConflictNote: '' } : prev));
      notify('success', 'تم اعتماد النسخة المحفوظة ومسح تنبيه التعارض.');
    } catch (err) {
      notify('error', parseFriendlyFirestoreError(err));
    }
  };

  return (
    <div className="space-y-6">
      {/* Atelier Header & Action Controls */}
      <div className="rounded-2xl border border-[var(--hub-border)] bg-gradient-to-l from-[var(--hub-sidebar-alt)] via-[var(--hub-sidebar)] to-[var(--hub-sidebar-alt)] text-[var(--hub-sidebar-text)] px-5 sm:px-6 py-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5 min-w-0 flex-1">
            <div className="text-xs font-semibold text-[var(--hub-sidebar-accent)] flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 shrink-0" />
              <span>دليل مشاعر للعطور والهدايا المصاحبة والأسعار الخليجية</span>
            </div>
            <h1 className="font-display text-xl sm:text-2xl font-bold text-[var(--hub-sidebar-text)] leading-snug">
              دليل المنتجات والأسعار الرسمية
            </h1>
            <p className="text-xs sm:text-sm text-[var(--hub-sidebar-text)]/80 tabular-nums leading-relaxed">
              الهرم العطري الثلاثي · الثبات والفوحان · البدائل المشابهة · أسعار متجر {activeCountryMeta.nameAr} ودول الخليج الست
              {branding?.lastStoreSyncAt
                ? ` · آخر مزامنة: ${new Date(branding.lastStoreSyncAt).toLocaleString('ar-KW')}`
                : ''}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {compareIds.length >= 2 && (
              <button
                type="button"
                onClick={() => setCompareOpen(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-[var(--hub-sidebar-accent)]/60 bg-black/20 px-3.5 py-2 text-xs sm:text-sm font-semibold text-[var(--hub-sidebar-text)] cursor-pointer whitespace-nowrap transition-colors hover:bg-black/35"
              >
                <GitCompare className="w-4 h-4 text-[var(--hub-sidebar-accent)]" />
                <span>مقارنة ({compareIds.length}) عطور</span>
              </button>
            )}

            {isAdmin && (
              <>
                <button
                  type="button"
                  onClick={() => openAiEnrichModal('all_incomplete')}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--hub-sidebar-accent)]/60 bg-black/25 px-3.5 py-2 text-xs sm:text-sm font-semibold text-[var(--hub-sidebar-accent)] hover:bg-black/40 cursor-pointer whitespace-nowrap transition-colors"
                >
                  <Wand2 className="w-4 h-4 shrink-0" />
                  <span>
                    استكمال بالذكاء الاصطناعي
                    {counts.incomplete > 0 ? ` (${counts.incomplete})` : ''}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setBatchSelectMode((v) => !v);
                    if (batchSelectMode) setBatchSelectedIds([]);
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs sm:text-sm font-semibold cursor-pointer whitespace-nowrap transition-colors ${
                    batchSelectMode
                      ? 'border-[var(--hub-sidebar-accent)] bg-white/15 text-[var(--hub-sidebar-text)]'
                      : 'border-white/20 bg-black/20 text-[var(--hub-sidebar-text)] hover:bg-white/10'
                  }`}
                >
                  <CheckSquare className="w-4 h-4 text-[var(--hub-sidebar-accent)]" />
                  <span>{batchSelectMode ? 'إنهاء التحديد' : 'تحديد مجموعة'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setHealthInitialTab('anomalies');
                    setHealthModalOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-white/20 bg-black/20 px-3 py-2 text-xs sm:text-sm font-semibold text-[var(--hub-sidebar-text)] hover:bg-white/10 cursor-pointer whitespace-nowrap transition-colors"
                >
                  <ShieldAlert className="w-4 h-4 text-[var(--hub-sidebar-accent)]" />
                  <span>فحص الدليل ({counts.anomalies})</span>
                </button>

                <button
                  type="button"
                  onClick={() => setCatManagerOpen((v) => !v)}
                  className={`inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs sm:text-sm font-semibold cursor-pointer whitespace-nowrap transition-colors ${
                    catManagerOpen
                      ? 'border-[var(--hub-sidebar-accent)] bg-white/15 text-[var(--hub-sidebar-text)]'
                      : 'border-white/20 bg-black/20 text-[var(--hub-sidebar-text)] hover:bg-white/10'
                  }`}
                >
                  <FolderPlus className="w-4 h-4 text-[var(--hub-sidebar-accent)]" />
                  <span>التصنيفات الإضافية</span>
                </button>

                <button
                  type="button"
                  onClick={syncLiveCatalog}
                  disabled={syncingCatalog}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-white/20 bg-black/20 px-3.5 py-2 text-xs sm:text-sm font-semibold text-[var(--hub-sidebar-text)] hover:bg-white/10 cursor-pointer whitespace-nowrap transition-colors disabled:opacity-55"
                >
                  <RefreshCw className={`w-4 h-4 text-[var(--hub-sidebar-accent)] ${syncingCatalog ? 'animate-spin' : ''}`} />
                  <span>{syncingCatalog ? 'جاري المزامنة...' : 'مزامنة المتجر'}</span>
                </button>

                <button
                  type="button"
                  onClick={openAdd}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--hub-sidebar-accent)] px-4 py-2 text-xs sm:text-sm font-bold text-[#2B0912] hover:opacity-95 cursor-pointer whitespace-nowrap transition-opacity shadow-xs"
                >
                  <Plus className="w-4 h-4" />
                  <span>إضافة منتج</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Summary KPI Strip */}
        <div className="mt-4 pt-3.5 border-t border-white/15 grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs tabular-nums">
          <div className="rounded-xl bg-black/15 border border-white/10 px-3 py-2 flex items-center justify-between">
            <span className="text-[var(--hub-sidebar-text)]/80">إجمالي المنتجات</span>
            <strong className="text-sm text-[var(--hub-sidebar-accent)]">{counts.all}</strong>
          </div>
          <div className="rounded-xl bg-black/15 border border-white/10 px-3 py-2 flex items-center justify-between">
            <span className="text-[var(--hub-sidebar-text)]/80">متوفر ({activeCountryMeta.code})</span>
            <strong className="text-sm text-emerald-300">{counts.inStock}</strong>
          </div>
          <div className="rounded-xl bg-black/15 border border-white/10 px-3 py-2 flex items-center justify-between">
            <span className="text-[var(--hub-sidebar-text)]/80">غير متوفر ({activeCountryMeta.code})</span>
            <strong className="text-sm text-red-300">{counts.outOfStock}</strong>
          </div>
          <div className="rounded-xl bg-black/15 border border-white/10 px-3 py-2 flex items-center justify-between">
            <span className="text-[var(--hub-sidebar-text)]/80">بهدايا مصاحبة</span>
            <strong className="text-sm text-[var(--hub-sidebar-accent)]">{counts.withGift}</strong>
          </div>
        </div>
      </div>

      {/* Collapsible Admin Custom Classifications Manager */}
      {isAdmin && catManagerOpen && (
        <section className="rounded-2xl border border-[var(--hub-accent-soft)]/60 bg-[var(--hub-surface)] p-5 space-y-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-0.5">
              <h2 className="text-sm font-bold text-[var(--hub-heading)] flex items-center gap-2">
                <Layers className="w-4 h-4 text-[var(--hub-accent)]" />
                <span>إدارة التصنيفات والوسوم الإضافية للمنتجات</span>
              </h2>
              <p className="text-xs text-[var(--hub-muted)]">
                أضف تصنيفات وصفية مساعدة (مثل: نيش فاخر، إصدار محدود، شرقي يومي) لتسهيل التصفية واختيار نوع المنتج.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCatManagerOpen(false)}
              className="p-1.5 rounded-lg text-[var(--hub-muted)] hover:bg-[var(--hub-surface-alt)] cursor-pointer"
              aria-label="إغلاق إدارة التصنيفات"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <form onSubmit={handleAddCustomCategory} className="flex flex-wrap gap-2">
            <input
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              placeholder="مثال: إصدار محدود، عطور مسائية، هدايا رسمية..."
              className="flex-1 min-w-[220px] rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3.5 py-2 text-sm text-[var(--hub-text)] focus:outline-none focus:border-[var(--hub-accent-soft)]"
            />
            <button
              type="submit"
              disabled={savingCategory || !newCategoryName.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[var(--hub-button)] text-[var(--hub-button-text)] text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              <span>{savingCategory ? 'جاري الحفظ...' : 'إضافة تصنيف'}</span>
            </button>
          </form>

          {productCustomCategories.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {productCustomCategories.map((cat) => (
                <div
                  key={cat.id}
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-1.5 text-xs font-medium text-[var(--hub-heading)]"
                >
                  <span>{cat.name}</span>
                  <button
                    type="button"
                    disabled={savingCategory}
                    onClick={() => handleDeleteCustomCategory(cat.id)}
                    className="text-red-600 dark:text-red-400 hover:opacity-80 cursor-pointer disabled:opacity-40"
                    title={`حذف ${cat.name}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-[var(--hub-muted)]">لا توجد تصنيفات إضافية محفوظة حالياً.</div>
          )}
        </section>
      )}

      {/* Control Deck: GCC Countries + Categories + Status + Sort + Search */}
      <div className="rounded-2xl border border-[var(--hub-border)] bg-[var(--hub-surface)] p-5 space-y-5 shadow-xs">
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs sm:text-sm font-semibold text-[var(--hub-heading)]">
              اختر متجر الدولة لعرض السعر الرسمي بعملة الدولة:
            </span>
            {selectedCountry === 'SA' && (
              <span className="text-xs text-amber-800 dark:text-amber-300 font-medium">
                ملاحظة السعودية: السعر المعروض يشمل ضريبة القيمة المضافة 15% المضافة عند الدفع
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            {GCC_COUNTRIES.map((c) => {
              const active = selectedCountry === c.code;
              return (
                <button
                  key={c.code}
                  type="button"
                  onClick={() => setSelectedCountry(c.code)}
                  className={`px-3 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer text-center border ${
                    active
                      ? 'bg-[var(--hub-button)] text-[var(--hub-button-text)] border-[var(--hub-button)] shadow-xs'
                      : 'bg-[var(--hub-bg)] text-[var(--hub-muted)] border-[var(--hub-border)] hover:border-[var(--hub-accent-soft)] hover:text-[var(--hub-heading)]'
                  }`}
                >
                  <div className="leading-snug">{c.nameAr}</div>
                  <div
                    className={`text-[11px] font-mono-tabular mt-0.5 ${
                      active ? 'opacity-90' : 'text-[var(--hub-accent)]'
                    }`}
                  >
                    {c.currency}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Categories + Custom Tags + Quick Toggles */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-[var(--hub-border)]">
          <div className="flex flex-wrap gap-2">
            {(['all', 'perfumes', 'mamoul', 'spray'] as const).map((tabKey) => (
              <button
                key={tabKey}
                type="button"
                onClick={() => setActiveTab(tabKey)}
                className={`px-4 py-2 text-xs sm:text-sm font-semibold rounded-xl cursor-pointer whitespace-nowrap tabular-nums transition-colors ${
                  activeTab === tabKey
                    ? 'bg-[var(--hub-button)] text-[var(--hub-button-text)]'
                    : 'bg-[var(--hub-bg)] text-[var(--hub-muted)] border border-[var(--hub-border)] hover:bg-[var(--hub-surface-alt)] hover:text-[var(--hub-heading)]'
                }`}
              >
                {tabKey === 'all' ? 'جميع المنتجات' : CATEGORY_LABELS[tabKey]} ({counts[tabKey]})
              </button>
            ))}

            {counts.withGift > 0 && (
              <button
                type="button"
                onClick={() => setOnlyWithGift((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs sm:text-sm font-semibold rounded-xl border cursor-pointer whitespace-nowrap tabular-nums transition-colors ${
                  onlyWithGift
                    ? 'border-[var(--hub-accent)] bg-[var(--hub-surface-alt)] text-[var(--hub-heading)] ring-1 ring-[var(--hub-accent-soft)]/50'
                    : 'border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-muted)] hover:border-[var(--hub-accent-soft)] hover:text-[var(--hub-heading)]'
                }`}
              >
                <Gift className="w-3.5 h-3.5 text-[var(--hub-accent)]" />
                <span>مع هدية مصاحبة ({counts.withGift})</span>
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 text-xs sm:text-sm">
            <label className="inline-flex items-center gap-2 font-medium text-[var(--hub-heading)] cursor-pointer select-none px-3 py-2 rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)]">
              <input
                type="checkbox"
                checked={onlyFavorites}
                onChange={(e) => setOnlyFavorites(e.target.checked)}
                className="accent-[var(--hub-accent)] w-4 h-4"
              />
              <span>المفضلة ({favSet.size})</span>
            </label>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as ProductStatusFilter)}
              aria-label="تصفية حسب حالة المنتج"
              className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-xs sm:text-sm text-[var(--hub-heading)]"
            >
              <option value="all">كل الحالات ({counts.all})</option>
              <option value="verified_in_stock">متوفر ومعتمد</option>
              <option value="in_stock">متوفر حالياً ({counts.inStock})</option>
              <option value="out_of_stock">غير متوفر حالياً ({counts.outOfStock})</option>
              <option value="needs_review">قيد المراجعة ({counts.needsReview})</option>
            </select>

            <select
              value={dataFilter}
              onChange={(e) => setDataFilter(e.target.value as ProductDataFilter)}
              aria-label="فلترة ذكية حسب اكتمال وموثوقية البيانات"
              className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-xs sm:text-sm text-[var(--hub-heading)]"
            >
              <option value="all">جودة البيانات: الكل</option>
              <option value="incomplete">بيانات ناقصة ({counts.incomplete})</option>
              <option value="ai_estimated">تشمل تقديرات AI ({counts.aiEstimated})</option>
              <option value="official_only">رسمية موثقة فقط ({counts.officialOnly})</option>
              <option value="needs_review">تحتاج مراجعة ({counts.needsReview})</option>
              <option value="anomalies">مكررات أو تعارضات ({counts.anomalies})</option>
            </select>

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as ProductSortOption)}
              aria-label="ترتيب المنتجات"
              className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-xs sm:text-sm text-[var(--hub-heading)]"
            >
              <option value="default">الترتيب الرسمي</option>
              <option value="completeness_asc">الاكتمال: الأقل أولاً</option>
              <option value="completeness_desc">الاكتمال: الأعلى أولاً</option>
              <option value="price_asc">السعر: الأقل أولاً</option>
              <option value="price_desc">السعر: الأعلى أولاً</option>
              <option value="name_asc">الاسم: أ - ي</option>
              <option value="updated_desc">الأحدث تحديثاً</option>
            </select>
          </div>
        </div>

        {/* Custom Classification Chips (if configured) */}
        {productCustomCategories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs pt-1">
            <span className="text-[var(--hub-muted)] font-semibold flex items-center gap-1 ml-1">
              <SlidersHorizontal className="w-3.5 h-3.5 text-[var(--hub-accent)]" />
              <span>تصنيفات إضافية:</span>
            </span>
            <button
              type="button"
              onClick={() => setCustomTagFilter('')}
              className={`px-2.5 py-1 rounded-lg border text-xs cursor-pointer transition-colors ${
                !customTagFilter
                  ? 'border-[var(--hub-accent)] bg-[var(--hub-surface-alt)] text-[var(--hub-heading)] font-semibold'
                  : 'border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-muted)]'
              }`}
            >
              الكل
            </button>
            {productCustomCategories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setCustomTagFilter(customTagFilter === cat.name ? '' : cat.name)}
                className={`px-2.5 py-1 rounded-lg border text-xs cursor-pointer transition-colors ${
                  customTagFilter === cat.name
                    ? 'border-[var(--hub-accent)] bg-[var(--hub-surface-alt)] text-[var(--hub-heading)] font-semibold'
                    : 'border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-muted)] hover:text-[var(--hub-heading)]'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>
        )}

        {/* 6 Fragrance Attribute Filters */}
        <div className="pt-3 border-t border-[var(--hub-border)] space-y-2">
          <div className="text-[11px] font-bold text-[var(--hub-muted)]">
            تصفية حسب خصائص العطر (الثبات، الفوحان، الاستخدام، المناسبات، الفصول، الأوقات):
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
            <select
              value={attrFilters.longevity}
              onChange={(e) =>
                setAttrFilters((prev) => ({ ...prev, longevity: e.target.value as LongevityFilterOption }))
              }
              aria-label="تصفية حسب الثبات"
              className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)] px-2.5 py-2 text-xs text-[var(--hub-heading)]"
            >
              <option value="all">الثبات: الكل</option>
              <option value="short">خفيف (أقل من 4 ساعات)</option>
              <option value="medium">متوسط (5 - 7 ساعات)</option>
              <option value="high">عالي (8 ساعات فأكثر)</option>
              <option value="unspecified">غير محدد</option>
            </select>

            <select
              value={attrFilters.sillage}
              onChange={(e) =>
                setAttrFilters((prev) => ({ ...prev, sillage: e.target.value as SillageFilterOption }))
              }
              aria-label="تصفية حسب الفوحان"
              className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)] px-2.5 py-2 text-xs text-[var(--hub-heading)]"
            >
              <option value="all">الفوحان: الكل</option>
              <option value="light">خفيف</option>
              <option value="medium">متوسط</option>
              <option value="strong">قوي</option>
              <option value="very_strong">قوي جداً</option>
              <option value="unspecified">غير محدد</option>
            </select>

            <select
              value={attrFilters.usage}
              onChange={(e) =>
                setAttrFilters((prev) => ({ ...prev, usage: e.target.value as UsageFilterOption }))
              }
              aria-label="تصفية حسب الاستخدام"
              className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)] px-2.5 py-2 text-xs text-[var(--hub-heading)]"
            >
              <option value="all">الاستخدام: الكل</option>
              {USAGE_TYPE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
              <option value="unspecified">غير محدد</option>
            </select>

            <select
              value={attrFilters.occasion}
              onChange={(e) =>
                setAttrFilters((prev) => ({ ...prev, occasion: e.target.value as OccasionFilterOption }))
              }
              aria-label="تصفية حسب المناسبات"
              className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)] px-2.5 py-2 text-xs text-[var(--hub-heading)]"
            >
              <option value="all">المناسبات: الكل</option>
              {OCCASION_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
              <option value="unspecified">غير محدد</option>
            </select>

            <select
              value={attrFilters.season}
              onChange={(e) =>
                setAttrFilters((prev) => ({ ...prev, season: e.target.value as SeasonFilterOption }))
              }
              aria-label="تصفية حسب الفصول"
              className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)] px-2.5 py-2 text-xs text-[var(--hub-heading)]"
            >
              <option value="all">الفصول: الكل</option>
              {SEASON_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
              <option value="unspecified">غير محدد</option>
            </select>

            <select
              value={attrFilters.timeOfDay}
              onChange={(e) =>
                setAttrFilters((prev) => ({ ...prev, timeOfDay: e.target.value as TimeOfDayFilterOption }))
              }
              aria-label="تصفية حسب الأوقات"
              className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)] px-2.5 py-2 text-xs text-[var(--hub-heading)]"
            >
              <option value="all">الأوقات: الكل</option>
              {TIME_OF_DAY_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
              <option value="unspecified">غير محدد</option>
            </select>
          </div>
        </div>

        {/* Search Input + Export & Active Filter Summary */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-[var(--hub-accent)] absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث بالاسم أو SKU أو الثبات أو الفوحان أو الاستخدام أو المناسبات أو الفصول أو الأوقات أو النوتات..."
              className="w-full rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)] pr-10 pl-9 py-2.5 text-sm text-[var(--hub-text)] focus:outline-none focus:border-[var(--hub-accent-soft)] focus:bg-[var(--hub-surface)]"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-[var(--hub-muted)] hover:text-[var(--hub-heading)] cursor-pointer"
                aria-label="مسح البحث"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 text-xs tabular-nums">
            <span className="text-[var(--hub-muted)]">
              النتائج المعروضة:{' '}
              <strong className="text-[var(--hub-heading)]">{filtered.length}</strong> من {products.length}
            </span>
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={filtered.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] text-xs font-semibold text-[var(--hub-heading)] hover:border-[var(--hub-accent)] hover:bg-[var(--hub-surface-alt)] cursor-pointer transition-colors disabled:opacity-45"
              title="تصدير المنتجات المعروضة بصيغة CSV شاملة للخصائص العطرية الستة"
            >
              <Download className="w-3.5 h-3.5 text-[var(--hub-accent)]" />
              <span>تصدير CSV</span>
            </button>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetAllFilters}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] text-xs font-semibold text-[var(--hub-accent)] hover:bg-[var(--hub-surface-alt)] cursor-pointer transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>إعادة ضبط</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Admin Batch Selection Action Bar */}
      {isAdmin && batchSelectMode && (
        <div className="rounded-xl border border-[var(--hub-accent-soft)] bg-[var(--hub-surface-alt)] px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="font-bold text-[var(--hub-heading)] tabular-nums">
            تم تحديد <strong className="text-[var(--hub-accent)]">{batchSelectedIds.length}</strong> منتج للمعالجة بالذكاء الاصطناعي
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setBatchSelectedIds(filtered.map((p) => p.id))}
              className="px-3 py-1.5 rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] font-semibold text-[var(--hub-heading)] cursor-pointer"
            >
              تحديد كل المعروض ({filtered.length})
            </button>
            <button
              type="button"
              onClick={() => setBatchSelectedIds([])}
              className="px-3 py-1.5 rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] text-[var(--hub-muted)] cursor-pointer"
            >
              إلغاء التحديد
            </button>
            <button
              type="button"
              disabled={batchSelectedIds.length === 0}
              onClick={() => openAiEnrichModal('selected')}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[var(--hub-button)] text-[var(--hub-button-text)] font-bold cursor-pointer disabled:opacity-50"
            >
              <Wand2 className="w-3.5 h-3.5" />
              <span>استكمال المجموعة المحددة</span>
            </button>
          </div>
        </div>
      )}

      {/* Products Grid */}
      {dataLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[1, 2, 3, 4].map((n) => (
            <div
              key={n}
              className="rounded-2xl border border-[var(--hub-border)] bg-[var(--hub-surface)] overflow-hidden animate-pulse"
            >
              <div className="h-20 bg-[var(--hub-sidebar)]/80" />
              <div className="p-5 space-y-4">
                <div className="h-5 w-1/3 rounded bg-[var(--hub-surface-alt)]" />
                <div className="h-16 rounded-xl bg-[var(--hub-bg)]" />
                <div className="grid grid-cols-3 gap-2.5">
                  <div className="h-16 rounded-xl bg-[var(--hub-surface-alt)]/70" />
                  <div className="h-16 rounded-xl bg-[var(--hub-surface-alt)]/70" />
                  <div className="h-16 rounded-xl bg-[var(--hub-surface-alt)]/70" />
                </div>
                <div className="h-24 rounded-xl bg-[var(--hub-surface-alt)]/70" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-[var(--hub-border)] bg-[var(--hub-surface)] p-12 text-center text-sm text-[var(--hub-muted)] space-y-3">
          <div className="font-semibold text-[var(--hub-heading)]">
            لا توجد منتجات مطابقة لخيارات البحث والتصفية الحالية.
          </div>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={resetAllFilters}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[var(--hub-button)] text-[var(--hub-button-text)] text-xs font-semibold cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>إعادة ضبط كافة الفلاتر</span>
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {filtered.map((item) => (
            <ProductCard
              key={item.id}
              product={item}
              allProducts={products}
              selectedCountry={selectedCountry}
              onSelectCountry={setSelectedCountry}
              isFavorite={favSet.has(item.id)}
              onToggleFavorite={(id) => toggleFavorite('products', id)}
              isCompared={compareIds.includes(item.id)}
              onToggleCompare={toggleCompare}
              isBatchSelectable={isAdmin && batchSelectMode}
              isBatchSelected={batchSelectedIds.includes(item.id)}
              onToggleBatchSelect={toggleBatchSelect}
              isAdmin={isAdmin}
              uiConfig={uiConfig}
              isRefreshing={Boolean(refreshingIds[item.id])}
              onRefreshProduct={handleRefreshSingleProduct}
              onOpenDetails={(p) => setDetailProduct(p)}
              onSelectAlternative={(alt) => setDetailProduct(alt)}
              onEdit={openEdit}
              onDelete={(p) => setDeleteTarget(p)}
              onAiEnrich={isAdmin ? (p) => openAiEnrichModal('single', p) : undefined}
              onQuickNotifyCopy={handleQuickNotifyCopy}
            />
          ))}
        </div>
      )}

      {/* Floating Comparison Bar */}
      {compareIds.length > 0 && (
        <div className="fixed bottom-4 right-4 z-40 max-w-[calc(100vw-2rem)] rounded-2xl border border-[var(--hub-accent-soft)] bg-[var(--hub-surface)] shadow-xl px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="text-xs font-bold text-[var(--hub-heading)]">
            مقارنة العطور ({compareIds.length}/3):{' '}
            <span className="font-normal text-[var(--hub-muted)]">
              {compareProducts.map((p) => p.nameAr).join(' · ')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {compareIds.length >= 2 && (
              <button
                type="button"
                onClick={() => setCompareOpen(true)}
                className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-[var(--hub-button)] text-[var(--hub-button-text)] cursor-pointer"
              >
                عرض المقارنة
              </button>
            )}
            <button
              type="button"
              onClick={() => setCompareIds([])}
              className="px-3 py-1.5 text-xs rounded-lg border border-[var(--hub-border)] text-[var(--hub-muted)] hover:text-[var(--hub-heading)] cursor-pointer"
            >
              مسح
            </button>
          </div>
        </div>
      )}

      {/* Side-by-Side Perfume Comparison Modal */}
      {compareOpen && compareProducts.length >= 2 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded-2xl border border-[var(--hub-border)] bg-[var(--hub-surface)] shadow-2xl">
            <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 bg-gradient-to-l from-[var(--hub-sidebar-alt)] via-[var(--hub-sidebar)] to-[var(--hub-sidebar-alt)] text-[var(--hub-sidebar-text)] border-b border-[var(--hub-sidebar-accent)]/40">
              <div className="flex items-center gap-2">
                <GitCompare className="w-5 h-5 text-[var(--hub-sidebar-accent)]" />
                <h2 className="text-base font-bold">
                  مقارنة العطور جنباً إلى جنب ({activeCountryMeta.nameAr})
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setCompareOpen(false)}
                className="p-1.5 rounded-lg text-[var(--hub-sidebar-text)]/80 hover:bg-white/10 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 overflow-x-auto">
              <table className="w-full text-xs sm:text-sm text-right border-collapse">
                <thead>
                  <tr className="bg-[var(--hub-surface-alt)] border-b border-[var(--hub-border)]">
                    <th className="p-3.5 font-bold text-[var(--hub-heading)] w-40">المواصفة</th>
                    {compareProducts.map((p) => (
                      <th key={p.id} className="p-3.5 font-bold text-[var(--hub-heading)]">
                        <div>{p.nameAr}</div>
                        {p.nameEn && (
                          <div className="text-xs font-normal text-[var(--hub-muted)] mt-0.5" dir="ltr">
                            {p.nameEn}
                          </div>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--hub-border)]">
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">السعر ({activeCountryMeta.nameAr})</td>
                    {compareProducts.map((p) => {
                      const entry = p.countryPrices?.[selectedCountry];
                      return (
                        <td key={p.id} className="p-3.5 font-bold text-[var(--hub-accent)] tabular-nums">
                          {formatPriceNumber(entry?.price, entry?.currency || activeCountryMeta.currency)}
                        </td>
                      );
                    })}
                  </tr>
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">الحالة والتوفر</td>
                    {compareProducts.map((p) => {
                      const st = resolveProductStatusDisplay(p, selectedCountry);
                      return (
                        <td key={p.id} className="p-3.5 text-[var(--hub-text)] font-medium">
                          {st.label}
                        </td>
                      );
                    })}
                  </tr>
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">الحجم والنوع</td>
                    {compareProducts.map((p) => (
                      <td key={p.id} className="p-3.5 text-[var(--hub-text)]">
                        {p.size || '—'} · {p.perfumeType || CATEGORY_LABELS[p.category]}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">الهدية المصاحبة</td>
                    {compareProducts.map((p) => (
                      <td key={p.id} className="p-3.5 text-[var(--hub-text)]">
                        {p.companionGift?.title ? (
                          <div className="space-y-0.5">
                            <div className="font-bold text-[var(--hub-accent)]">{p.companionGift.title}</div>
                            {p.companionGift.compositionNote && (
                              <div className="text-xs text-[var(--hub-muted)]">{p.companionGift.compositionNote}</div>
                            )}
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">العائلة والطابع العطري</td>
                    {compareProducts.map((p) => (
                      <td key={p.id} className="p-3.5 text-[var(--hub-text)]">
                        {[p.fragranceFamily, p.fragranceCharacter].filter(Boolean).join(' · ') || '—'}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">
                      <div>الثبات (الساعات المتوقعة)</div>
                      <div className="text-[10.5px] font-normal text-[var(--hub-muted)] mt-0.5">
                        تقديري ويختلف حسب البشرة والجو
                      </div>
                    </td>
                    {compareProducts.map((p) => (
                      <td key={p.id} className="p-3.5 text-[var(--hub-text)]">
                        {isFilledFragranceValue(p.longevity) ? p.longevity : 'غير محدد'}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">الفوحان والانتشار ومدة البقاء</td>
                    {compareProducts.map((p) => {
                      const ext = extractExtendedGuidance(p);
                      return (
                        <td key={p.id} className="p-3.5 text-[var(--hub-text)] space-y-0.5 text-xs">
                          <div>
                            <span className="text-[var(--hub-muted)]">المستوى: </span>
                            <strong>{isFilledFragranceValue(p.sillage) ? p.sillage : 'غير محدد'}</strong>
                          </div>
                          <div>
                            <span className="text-[var(--hub-muted)]">الانتشار: </span>
                            {isFilledFragranceValue(ext.sillageReach) ? ext.sillageReach : 'غير محدد'}
                          </div>
                          <div>
                            <span className="text-[var(--hub-muted)]">مدة البقاء: </span>
                            {isFilledFragranceValue(ext.sillageDuration) ? ext.sillageDuration : 'غير محدد'}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">الاستخدام</td>
                    {compareProducts.map((p) => {
                      const ext = extractExtendedGuidance(p);
                      return (
                        <td key={p.id} className="p-3.5 text-[var(--hub-text)]">
                          {isFilledFragranceValue(ext.usageType) ? ext.usageType : 'غير محدد'}
                        </td>
                      );
                    })}
                  </tr>
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">المناسبات</td>
                    {compareProducts.map((p) => (
                      <td key={p.id} className="p-3.5 text-[var(--hub-text)]">
                        {isFilledFragranceValue(p.occasionUsage) ? p.occasionUsage : 'غير محدد'}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">الفصول</td>
                    {compareProducts.map((p) => (
                      <td key={p.id} className="p-3.5 text-[var(--hub-text)]">
                        {isFilledFragranceValue(p.seasons) ? p.seasons : 'غير محدد'}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">الأوقات</td>
                    {compareProducts.map((p) => {
                      const ext = extractExtendedGuidance(p);
                      return (
                        <td key={p.id} className="p-3.5 text-[var(--hub-text)]">
                          {isFilledFragranceValue(ext.timeOfDay) ? ext.timeOfDay : 'غير محدد'}
                        </td>
                      );
                    })}
                  </tr>
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">الافتتاحية (Top)</td>
                    {compareProducts.map((p) => (
                      <td key={p.id} className="p-3.5 text-[var(--hub-text)] leading-relaxed">{p.topNotes || '—'}</td>
                    ))}
                  </tr>
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">القلب (Heart)</td>
                    {compareProducts.map((p) => (
                      <td key={p.id} className="p-3.5 text-[var(--hub-text)] leading-relaxed">{p.heartNotes || '—'}</td>
                    ))}
                  </tr>
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">القاعدة (Base)</td>
                    {compareProducts.map((p) => (
                      <td key={p.id} className="p-3.5 text-[var(--hub-text)] leading-relaxed">{p.baseNotes || '—'}</td>
                    ))}
                  </tr>
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">التركيز والفئة المناسبة</td>
                    {compareProducts.map((p) => {
                      const ext = extractExtendedGuidance(p);
                      return (
                        <td key={p.id} className="p-3.5 text-[var(--hub-text)] text-xs leading-relaxed">
                          {[ext.concentration && `التركيز: ${ext.concentration}`, ext.targetAudience]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </td>
                      );
                    })}
                  </tr>
                  <tr>
                    <td className="p-3.5 font-semibold text-[var(--hub-heading)]">النوتات المميزة لكل عطر</td>
                    {compareProducts.map((p) => {
                      const uniq = noteComparison.perProductUnique[p.id] || [];
                      return (
                        <td key={p.id} className="p-3.5 text-xs text-[var(--hub-heading)] leading-relaxed">
                          {uniq.length > 0 ? uniq.join(' · ') : '—'}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>

              {noteComparison.sharedNotes.length > 0 && (
                <div className="mt-4 rounded-xl border border-[var(--hub-accent-soft)]/60 bg-[var(--hub-surface-alt)]/55 p-3.5 text-xs space-y-1">
                  <div className="font-bold text-[var(--hub-heading)]">
                    نقاط التشابه العطرية المشتركة بين المنتجات المختارة:
                  </div>
                  <div className="text-[var(--hub-accent)] font-semibold">
                    {noteComparison.sharedNotes.join(' · ')}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Full Fragrance Intelligence Modal */}
      <ProductDetailsModal
        product={detailProduct}
        allProducts={products}
        selectedCountry={selectedCountry}
        isFavorite={detailProduct ? favSet.has(detailProduct.id) : false}
        isAdmin={isAdmin}
        latestUndoSnapshot={latestDetailUndoSnapshot}
        onClose={() => setDetailProduct(null)}
        onSelectProduct={(next) => setDetailProduct(next)}
        onToggleFavorite={(id) => toggleFavorite('products', id)}
        onEdit={openEdit}
        onAiEnrich={isAdmin ? (p) => openAiEnrichModal('single', p) : undefined}
        onUndoLastEdit={isAdmin ? handleUndoSnapshot : undefined}
        onResolveConflict={handleResolveConflict}
      />

      {/* Admin Add / Edit Product Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-xs">
          <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border border-[var(--hub-border)] bg-[var(--hub-surface)] shadow-xl">
            <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 px-6 py-4 bg-gradient-to-l from-[var(--hub-sidebar-alt)] via-[var(--hub-sidebar)] to-[var(--hub-sidebar-alt)] text-[var(--hub-sidebar-text)] border-b border-[var(--hub-sidebar-accent)]/40">
              <h3 className="text-base font-bold">
                {editing ? `تعديل بيانات المنتج: ${editing.nameAr}` : 'إضافة منتج جديد لدليل الأسعار'}
              </h3>
              <div className="flex items-center gap-2">
                {editing && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setModalOpen(false);
                        openAiEnrichModal('single', editing);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--hub-sidebar-accent)]/60 bg-black/25 px-3 py-1.5 text-xs font-semibold text-[var(--hub-sidebar-accent)] hover:bg-black/40 cursor-pointer"
                    >
                      <Wand2 className="w-3.5 h-3.5" />
                      <span>استكمال ذكي شامل</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setModalOpen(false);
                        setHealthInitialTab('history');
                        setHealthModalOpen(true);
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-white/20 bg-black/20 px-2.5 py-1.5 text-xs text-[var(--hub-sidebar-text)] hover:bg-white/10 cursor-pointer"
                      title="عرض لقطات التراجع والسجل"
                    >
                      <History className="w-3.5 h-3.5" />
                      <span>السجل</span>
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="p-1.5 rounded-lg text-[var(--hub-sidebar-text)]/80 hover:bg-white/10 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="p-6 space-y-5">
              {conflictMsg && (
                <div className="rounded-xl border border-orange-300 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/50 p-4 space-y-2.5 text-xs text-orange-950 dark:text-orange-200">
                  <div className="font-bold flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>{conflictMsg}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleReloadLatestProduct}
                      className="px-3 py-1.5 rounded-lg bg-[var(--hub-surface)] border border-[var(--hub-border)] font-semibold text-[var(--hub-heading)] cursor-pointer"
                    >
                      إعادة تحميل أحدث نسخة من السحابة
                    </button>
                    <button
                      type="button"
                      onClick={() => submitSaveProduct(true)}
                      disabled={saving}
                      className="px-3 py-1.5 rounded-lg bg-orange-700 text-white font-semibold cursor-pointer"
                    >
                      تجاوز وحفظ تعديلاتي بالقوة
                    </button>
                  </div>
                </div>
              )}

              <form onSubmit={handleSave} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[var(--hub-heading)] mb-1">الاسم العربي</label>
                    <input
                      required
                      value={nameAr}
                      onChange={(e) => setNameAr(e.target.value)}
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[var(--hub-heading)] mb-1">الاسم الإنجليزي</label>
                    <input
                      dir="ltr"
                      value={nameEn}
                      onChange={(e) => setNameEn(e.target.value)}
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[var(--hub-heading)] mb-1">SKU</label>
                    <input
                      dir="ltr"
                      value={sku}
                      onChange={(e) => setSku(e.target.value)}
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[var(--hub-heading)] mb-1">التصنيف الأساسي</label>
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value as ProductCategory)}
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    >
                      <option value="perfumes">العطور</option>
                      <option value="mamoul">المعمول</option>
                      <option value="spray">السبراي</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[var(--hub-heading)] mb-1">الحجم الرسمي</label>
                    <input
                      value={size}
                      onChange={(e) => setSize(e.target.value)}
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[var(--hub-heading)] mb-1">حالة المراجعة والاعتماد</label>
                    <select
                      value={reviewStatus}
                      onChange={(e) => setReviewStatus(e.target.value as ProductReviewStatus)}
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    >
                      <option value="verified">معتمد ومطابق</option>
                      <option value="needs_review">قيد المراجعة</option>
                    </select>
                  </div>
                </div>

                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                    <label className="text-xs font-semibold text-[var(--hub-heading)]">الوصف الرسمي</label>
                    {editing && (
                      <div className="flex items-center gap-2 text-[11px]">
                        {extractProductProvenance(editing).officialDescription && (
                          <span className="text-[var(--hub-muted)]">
                            ({SOURCE_TYPE_META[extractProductProvenance(editing).officialDescription.sourceType].shortLabel})
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setManualLocks((prev) =>
                              prev.includes('officialDescription')
                                ? prev.filter((x) => x !== 'officialDescription')
                                : [...prev, 'officialDescription']
                            )
                          }
                          className="inline-flex items-center gap-1 text-purple-700 dark:text-purple-300 cursor-pointer"
                          title="قفل أو فتح حماية التعديل اليدوي"
                        >
                          {manualLocks.includes('officialDescription') ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                          <span>{manualLocks.includes('officialDescription') ? 'محمي يدوياً' : 'غير مقفل'}</span>
                        </button>
                        <button
                          type="button"
                          disabled={regenFieldKey !== null}
                          onClick={() => handleRegenerateFieldInline('officialDescription')}
                          className="inline-flex items-center gap-1 text-[var(--hub-accent)] hover:underline cursor-pointer disabled:opacity-45"
                        >
                          <Wand2 className="w-3 h-3" />
                          <span>{regenFieldKey === 'officialDescription' ? 'جاري...' : 'توليد بالذكاء الاصطناعي'}</span>
                        </button>
                      </div>
                    )}
                  </div>
                  <textarea
                    rows={3}
                    required
                    value={officialDescription}
                    onChange={(e) => setOfficialDescription(e.target.value)}
                    className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)] leading-relaxed"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-semibold text-[var(--hub-heading)]">مقدمة العطر (Top)</label>
                      {editing && (
                        <button
                          type="button"
                          disabled={regenFieldKey !== null}
                          onClick={() => handleRegenerateFieldInline('topNotes')}
                          className="text-[11px] text-[var(--hub-accent)] hover:underline cursor-pointer disabled:opacity-45"
                        >
                          {regenFieldKey === 'topNotes' ? '...' : '✨ توليد'}
                        </button>
                      )}
                    </div>
                    <input
                      value={topNotes}
                      onChange={(e) => setTopNotes(e.target.value)}
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-semibold text-[var(--hub-heading)]">قلب العطر (Heart)</label>
                      {editing && (
                        <button
                          type="button"
                          disabled={regenFieldKey !== null}
                          onClick={() => handleRegenerateFieldInline('heartNotes')}
                          className="text-[11px] text-[var(--hub-accent)] hover:underline cursor-pointer disabled:opacity-45"
                        >
                          {regenFieldKey === 'heartNotes' ? '...' : '✨ توليد'}
                        </button>
                      )}
                    </div>
                    <input
                      value={heartNotes}
                      onChange={(e) => setHeartNotes(e.target.value)}
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-semibold text-[var(--hub-heading)]">قاعدة العطر (Base)</label>
                      {editing && (
                        <button
                          type="button"
                          disabled={regenFieldKey !== null}
                          onClick={() => handleRegenerateFieldInline('baseNotes')}
                          className="text-[11px] text-[var(--hub-accent)] hover:underline cursor-pointer disabled:opacity-45"
                        >
                          {regenFieldKey === 'baseNotes' ? '...' : '✨ توليد'}
                        </button>
                      )}
                    </div>
                    <input
                      value={baseNotes}
                      onChange={(e) => setBaseNotes(e.target.value)}
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label className="text-xs font-semibold text-[var(--hub-heading)]">ملخص المكونات والنوتات</label>
                    {editing && (
                      <button
                        type="button"
                        disabled={regenFieldKey !== null}
                        onClick={() => handleRegenerateFieldInline('notesAndIngredients')}
                        className="text-[11px] text-[var(--hub-accent)] hover:underline cursor-pointer disabled:opacity-45"
                      >
                        {regenFieldKey === 'notesAndIngredients' ? 'جاري...' : '✨ توليد الملخص'}
                      </button>
                    )}
                  </div>
                  <textarea
                    rows={2}
                    value={notesAndIngredients}
                    onChange={(e) => setNotesAndIngredients(e.target.value)}
                    className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)] leading-relaxed"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-semibold text-[var(--hub-heading)]">العائلة العطرية</label>
                      {editing && (
                        <button
                          type="button"
                          disabled={regenFieldKey !== null}
                          onClick={() => handleRegenerateFieldInline('fragranceFamily')}
                          className="text-[11px] text-[var(--hub-accent)] hover:underline cursor-pointer"
                        >
                          ✨
                        </button>
                      )}
                    </div>
                    <input
                      value={fragranceFamily}
                      onChange={(e) => setFragranceFamily(e.target.value)}
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-semibold text-[var(--hub-heading)]">الطابع العطري</label>
                      {editing && (
                        <button
                          type="button"
                          disabled={regenFieldKey !== null}
                          onClick={() => handleRegenerateFieldInline('fragranceCharacter')}
                          className="text-[11px] text-[var(--hub-accent)] hover:underline cursor-pointer"
                        >
                          ✨
                        </button>
                      )}
                    </div>
                    <input
                      value={fragranceCharacter}
                      onChange={(e) => setFragranceCharacter(e.target.value)}
                      placeholder="مثال: دافئ، شرقي، خشبي"
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-semibold text-[var(--hub-heading)]">فئة العطر / النوع</label>
                      {editing && (
                        <button
                          type="button"
                          disabled={regenFieldKey !== null}
                          onClick={() => handleRegenerateFieldInline('perfumeType')}
                          className="text-[11px] text-[var(--hub-accent)] hover:underline cursor-pointer"
                        >
                          ✨
                        </button>
                      )}
                    </div>
                    <input
                      value={perfumeType}
                      onChange={(e) => setPerfumeType(e.target.value)}
                      placeholder="للجنسين / رجالي / نسائي"
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-semibold text-[var(--hub-heading)]">التركيز</label>
                      {editing && (
                        <button
                          type="button"
                          disabled={regenFieldKey !== null}
                          onClick={() => handleRegenerateFieldInline('concentration')}
                          className="text-[11px] text-[var(--hub-accent)] hover:underline cursor-pointer"
                        >
                          ✨
                        </button>
                      )}
                    </div>
                    <input
                      value={concentration}
                      onChange={(e) => setConcentration(e.target.value)}
                      placeholder="مثال: Eau de Parfum"
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                </div>

                {productCustomCategories.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-[var(--hub-muted)]">إدراج سريع في نوع العطر:</span>
                    {productCustomCategories.map((cat) => (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() =>
                          setPerfumeType((prev) =>
                            prev.includes(cat.name) ? prev : prev ? `${prev} · ${cat.name}` : cat.name
                          )
                        }
                        className="px-2.5 py-1 rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-heading)] hover:border-[var(--hub-accent)] cursor-pointer"
                      >
                        + {cat.name}
                      </button>
                    ))}
                  </div>
                )}

                {/* 6 Fragrance Performance & Usage Attributes Editor */}
                <div className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-surface-alt)]/35 p-4 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-bold text-[var(--hub-heading)]">
                      الخصائص العطرية الستة (الثبات، الفوحان والانتشار، الاستخدام، المناسبات، الفصول، الأوقات)
                    </span>
                    <span className="text-[11px] text-[var(--hub-muted)]">
                      إذا لم تتوفر معلومات موثوقة، اتركها فارغة أو اختر «غير محدد»
                    </span>
                  </div>

                  {/* 1. Longevity */}
                  <div className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] p-3 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="text-xs font-bold text-[var(--hub-heading)]">
                        1. الثبات (المدة المتوقعة بالساعات)
                      </label>
                      <div className="flex items-center gap-2 text-[11px]">
                        {editing && (
                          <>
                            <button
                              type="button"
                              onClick={() => toggleManualFieldLock('longevity')}
                              className="inline-flex items-center gap-1 text-purple-700 dark:text-purple-300 cursor-pointer"
                            >
                              {manualLocks.includes('longevity') ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                              <span>{manualLocks.includes('longevity') ? 'محمي' : 'فتح'}</span>
                            </button>
                            <button
                              type="button"
                              disabled={regenFieldKey !== null}
                              onClick={() => handleRegenerateFieldInline('longevity')}
                              className="text-[var(--hub-accent)] hover:underline cursor-pointer disabled:opacity-45"
                            >
                              {regenFieldKey === 'longevity' ? '...' : '✨ توليد'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <input
                      value={longevity}
                      maxLength={120}
                      onChange={(e) => setLongevity(e.target.value)}
                      placeholder="مثال: تقديري: 6 إلى 8 ساعات (أو غير محدد)"
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      {[
                        'تقديري: 3 إلى 5 ساعات',
                        'تقديري: 6 إلى 8 ساعات',
                        'تقديري: 8 إلى 10 ساعات',
                        'تقديري: 10 إلى 12 ساعة+',
                        'غير محدد',
                      ].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setLongevity(preset)}
                          className={`px-2 py-0.5 rounded-md border cursor-pointer transition-colors ${
                            longevity === preset
                              ? 'border-[var(--hub-accent)] bg-[var(--hub-button)] text-[var(--hub-button-text)] font-semibold'
                              : 'border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-muted)] hover:text-[var(--hub-heading)]'
                          }`}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                    <div className="text-[11px] text-amber-800 dark:text-amber-300">{LONGEVITY_ESTIMATE_DISCLAIMER}</div>
                  </div>

                  {/* 2. Sillage Level + Reach + Duration */}
                  <div className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] p-3 space-y-2.5">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <div className="flex items-center justify-between gap-1 mb-1">
                          <label className="text-xs font-bold text-[var(--hub-heading)]">2. مستوى الفوحان</label>
                          {editing && (
                            <div className="flex items-center gap-1.5 text-[11px]">
                              <button
                                type="button"
                                onClick={() => toggleManualFieldLock('sillage')}
                                className="text-purple-700 dark:text-purple-300 cursor-pointer"
                                title="قفل/فتح حماية الفوحان"
                              >
                                {manualLocks.includes('sillage') ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                              </button>
                              <button
                                type="button"
                                disabled={regenFieldKey !== null}
                                onClick={() => handleRegenerateFieldInline('sillage')}
                                className="text-[var(--hub-accent)] hover:underline cursor-pointer"
                              >
                                ✨
                              </button>
                            </div>
                          )}
                        </div>
                        <input
                          value={sillage}
                          maxLength={120}
                          onChange={(e) => setSillage(e.target.value)}
                          placeholder="خفيف / متوسط / قوي / قوي جداً"
                          className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                        />
                        <div className="flex flex-wrap gap-1 mt-1.5 text-[11px]">
                          {SILLAGE_LEVEL_OPTIONS.map((lvl) => (
                            <button
                              key={lvl}
                              type="button"
                              onClick={() => setSillage(lvl)}
                              className={`px-2 py-0.5 rounded-md border cursor-pointer ${
                                sillage === lvl
                                  ? 'border-[var(--hub-accent)] bg-[var(--hub-button)] text-[var(--hub-button-text)] font-semibold'
                                  : 'border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-muted)] hover:text-[var(--hub-heading)]'
                              }`}
                            >
                              {lvl}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-1 mb-1">
                          <label className="text-xs font-semibold text-[var(--hub-heading)]">مدى انتشار الرائحة</label>
                          {editing && (
                            <div className="flex items-center gap-1.5 text-[11px]">
                              <button
                                type="button"
                                onClick={() => toggleManualFieldLock('sillageReach')}
                                className="text-purple-700 dark:text-purple-300 cursor-pointer"
                              >
                                {manualLocks.includes('sillageReach') ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                              </button>
                              <button
                                type="button"
                                disabled={regenFieldKey !== null}
                                onClick={() => handleRegenerateFieldInline('sillageReach')}
                                className="text-[var(--hub-accent)] hover:underline cursor-pointer"
                              >
                                ✨
                              </button>
                            </div>
                          )}
                        </div>
                        <input
                          value={sillageReach}
                          onChange={(e) => setSillageReach(e.target.value)}
                          placeholder="قريب / معتدل / ينتشر بالمكان"
                          className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                        />
                        <div className="flex flex-wrap gap-1 mt-1.5 text-[11px]">
                          {['قريب (محيط شخصي)', 'معتدل (نطاق الذراع)', 'واسع في المكان'].map((opt) => (
                            <button
                              key={opt}
                              type="button"
                              onClick={() => setSillageReach(opt)}
                              className={`px-2 py-0.5 rounded-md border cursor-pointer ${
                                sillageReach === opt
                                  ? 'border-[var(--hub-accent)] bg-[var(--hub-button)] text-[var(--hub-button-text)] font-semibold'
                                  : 'border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-muted)] hover:text-[var(--hub-heading)]'
                              }`}
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-1 mb-1">
                          <label className="text-xs font-semibold text-[var(--hub-heading)]">مدة بقاء الفوحان</label>
                          {editing && (
                            <div className="flex items-center gap-1.5 text-[11px]">
                              <button
                                type="button"
                                onClick={() => toggleManualFieldLock('sillageDuration')}
                                className="text-purple-700 dark:text-purple-300 cursor-pointer"
                              >
                                {manualLocks.includes('sillageDuration') ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                              </button>
                              <button
                                type="button"
                                disabled={regenFieldKey !== null}
                                onClick={() => handleRegenerateFieldInline('sillageDuration')}
                                className="text-[var(--hub-accent)] hover:underline cursor-pointer"
                              >
                                ✨
                              </button>
                            </div>
                          )}
                        </div>
                        <input
                          value={sillageDuration}
                          onChange={(e) => setSillageDuration(e.target.value)}
                          placeholder="تقديري: أول ساعتين / غير محدد"
                          className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                        />
                      </div>
                    </div>
                  </div>

                  {/* 3. Usage Type & 4. Occasions */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] p-3 space-y-2">
                      <div className="flex items-center justify-between gap-1">
                        <label className="text-xs font-bold text-[var(--hub-heading)]">3. الاستخدام</label>
                        {editing && (
                          <div className="flex items-center gap-1.5 text-[11px]">
                            <button
                              type="button"
                              onClick={() => toggleManualFieldLock('usageType')}
                              className="text-purple-700 dark:text-purple-300 cursor-pointer"
                            >
                              {manualLocks.includes('usageType') ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                            </button>
                            <button
                              type="button"
                              disabled={regenFieldKey !== null}
                              onClick={() => handleRegenerateFieldInline('usageType')}
                              className="text-[var(--hub-accent)] hover:underline cursor-pointer"
                            >
                              ✨
                            </button>
                          </div>
                        )}
                      </div>
                      <input
                        value={usageType}
                        onChange={(e) => setUsageType(e.target.value)}
                        placeholder="يومي / رسمي / عملي / مناسبات / سهرات"
                        className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                      />
                      <div className="flex flex-wrap gap-1 text-[11px]">
                        {USAGE_TYPE_OPTIONS.map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => toggleTokenValue(usageType, opt, setUsageType)}
                            className={`px-2 py-0.5 rounded-md border cursor-pointer ${
                              usageType.includes(opt)
                                ? 'border-[var(--hub-accent)] bg-[var(--hub-button)] text-[var(--hub-button-text)] font-semibold'
                                : 'border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-muted)] hover:text-[var(--hub-heading)]'
                            }`}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] p-3 space-y-2">
                      <div className="flex items-center justify-between gap-1">
                        <label className="text-xs font-bold text-[var(--hub-heading)]">4. المناسبات</label>
                        {editing && (
                          <div className="flex items-center gap-1.5 text-[11px]">
                            <button
                              type="button"
                              onClick={() => toggleManualFieldLock('occasionUsage')}
                              className="text-purple-700 dark:text-purple-300 cursor-pointer"
                            >
                              {manualLocks.includes('occasionUsage') ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                            </button>
                            <button
                              type="button"
                              disabled={regenFieldKey !== null}
                              onClick={() => handleRegenerateFieldInline('occasionUsage')}
                              className="text-[var(--hub-accent)] hover:underline cursor-pointer"
                            >
                              ✨
                            </button>
                          </div>
                        )}
                      </div>
                      <input
                        value={occasionUsage}
                        maxLength={300}
                        onChange={(e) => setOccasionUsage(e.target.value)}
                        placeholder="العمل، الاجتماعات، الزيارات، الأعراس..."
                        className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                      />
                      <div className="flex flex-wrap gap-1 text-[11px]">
                        {OCCASION_OPTIONS.map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => toggleTokenValue(occasionUsage, opt, setOccasionUsage)}
                            className={`px-2 py-0.5 rounded-md border cursor-pointer ${
                              occasionUsage.includes(opt)
                                ? 'border-[var(--hub-accent)] bg-[var(--hub-button)] text-[var(--hub-button-text)] font-semibold'
                                : 'border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-muted)] hover:text-[var(--hub-heading)]'
                            }`}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* 5. Seasons & 6. Time Of Day */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] p-3 space-y-2">
                      <div className="flex items-center justify-between gap-1">
                        <label className="text-xs font-bold text-[var(--hub-heading)]">5. الفصول</label>
                        {editing && (
                          <div className="flex items-center gap-1.5 text-[11px]">
                            <button
                              type="button"
                              onClick={() => toggleManualFieldLock('seasons')}
                              className="text-purple-700 dark:text-purple-300 cursor-pointer"
                            >
                              {manualLocks.includes('seasons') ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                            </button>
                            <button
                              type="button"
                              disabled={regenFieldKey !== null}
                              onClick={() => handleRegenerateFieldInline('seasons')}
                              className="text-[var(--hub-accent)] hover:underline cursor-pointer"
                            >
                              ✨
                            </button>
                          </div>
                        )}
                      </div>
                      <input
                        value={seasons}
                        maxLength={200}
                        onChange={(e) => setSeasons(e.target.value)}
                        placeholder="الصيف، الشتاء، الربيع، الخريف، مناسب لكل الفصول"
                        className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                      />
                      <div className="flex flex-wrap gap-1 text-[11px]">
                        {SEASON_OPTIONS.map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => toggleTokenValue(seasons, opt, setSeasons)}
                            className={`px-2 py-0.5 rounded-md border cursor-pointer ${
                              seasons.includes(opt)
                                ? 'border-[var(--hub-accent)] bg-[var(--hub-button)] text-[var(--hub-button-text)] font-semibold'
                                : 'border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-muted)] hover:text-[var(--hub-heading)]'
                            }`}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] p-3 space-y-2">
                      <div className="flex items-center justify-between gap-1">
                        <label className="text-xs font-bold text-[var(--hub-heading)]">6. الأوقات</label>
                        {editing && (
                          <div className="flex items-center gap-1.5 text-[11px]">
                            <button
                              type="button"
                              onClick={() => toggleManualFieldLock('timeOfDay')}
                              className="text-purple-700 dark:text-purple-300 cursor-pointer"
                            >
                              {manualLocks.includes('timeOfDay') ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                            </button>
                            <button
                              type="button"
                              disabled={regenFieldKey !== null}
                              onClick={() => handleRegenerateFieldInline('timeOfDay')}
                              className="text-[var(--hub-accent)] hover:underline cursor-pointer"
                            >
                              ✨
                            </button>
                          </div>
                        )}
                      </div>
                      <input
                        value={timeOfDay}
                        onChange={(e) => setTimeOfDay(e.target.value)}
                        placeholder="صباحي، نهاري، مسائي، ليلي، مناسب طوال اليوم"
                        className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                      />
                      <div className="flex flex-wrap gap-1 text-[11px]">
                        {TIME_OF_DAY_OPTIONS.map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => toggleTokenValue(timeOfDay, opt, setTimeOfDay)}
                            className={`px-2 py-0.5 rounded-md border cursor-pointer ${
                              timeOfDay.includes(opt)
                                ? 'border-[var(--hub-accent)] bg-[var(--hub-button)] text-[var(--hub-button-text)] font-semibold'
                                : 'border-[var(--hub-border)] bg-[var(--hub-bg)] text-[var(--hub-muted)] hover:text-[var(--hub-heading)]'
                            }`}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Target Audience & Layering Suggestions */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-semibold text-[var(--hub-heading)]">الفئة المناسبة وطبيعة العطر</label>
                      {editing && (
                        <button
                          type="button"
                          disabled={regenFieldKey !== null}
                          onClick={() => handleRegenerateFieldInline('targetAudience')}
                          className="text-[11px] text-[var(--hub-accent)] hover:underline cursor-pointer"
                        >
                          ✨
                        </button>
                      )}
                    </div>
                    <input
                      value={targetAudience}
                      onChange={(e) => setTargetAudience(e.target.value)}
                      placeholder="مثال: للجنسين / كلاسيكي فخم"
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-semibold text-[var(--hub-heading)]">تنسيق العطر (Layering)</label>
                      {editing && (
                        <button
                          type="button"
                          disabled={regenFieldKey !== null}
                          onClick={() => handleRegenerateFieldInline('layeringSuggestions')}
                          className="text-[11px] text-[var(--hub-accent)] hover:underline cursor-pointer"
                        >
                          ✨
                        </button>
                      )}
                    </div>
                    <input
                      value={layeringSuggestions}
                      onChange={(e) => setLayeringSuggestions(e.target.value)}
                      placeholder="مثال: يتناغم مع دهن العود أو المسك"
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                </div>

                {/* Companion Gift Cloud Editor */}
                <div className="rounded-xl border border-[var(--hub-accent-soft)]/60 bg-[var(--hub-surface-alt)]/50 p-4 space-y-3">
                  <label className="flex items-center justify-between gap-3 cursor-pointer">
                    <div className="flex items-center gap-2 text-xs font-bold text-[var(--hub-heading)]">
                      <Gift className="w-4 h-4 text-[var(--hub-accent)]" />
                      <span>إدارة الهدية المصاحبة المشمولة مع العطر (تُحفظ في Firestore)</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={hasCompanionGift}
                      onChange={(e) => setHasCompanionGift(e.target.checked)}
                      className="accent-[var(--hub-accent)] w-4 h-4"
                    />
                  </label>

                  {hasCompanionGift && (
                    <div className="space-y-3 pt-2 border-t border-[var(--hub-border)]">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs font-semibold text-[var(--hub-heading)] mb-1">عنوان الهدية المصاحبة</label>
                          <input
                            required={hasCompanionGift}
                            value={giftTitle}
                            onChange={(e) => setGiftTitle(e.target.value)}
                            placeholder="سبراي 100 مل أو مسك 12 مل"
                            className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] px-3 py-2 text-xs text-[var(--hub-text)]"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-[var(--hub-heading)] mb-1">حجم الهدية</label>
                          <input
                            value={giftSize}
                            onChange={(e) => setGiftSize(e.target.value)}
                            placeholder="100 مل أو 12 مل"
                            className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] px-3 py-2 text-xs text-[var(--hub-text)]"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-[var(--hub-heading)] mb-1">نوع الهدية</label>
                          <select
                            value={giftKind}
                            onChange={(e) => setGiftKind(e.target.value as CompanionGift['kind'])}
                            className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] px-3 py-2 text-xs text-[var(--hub-text)]"
                          >
                            <option value="spray">سبراي مطابق</option>
                            <option value="musk">مسك مطابق</option>
                            <option value="other">هدية أخرى</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-[var(--hub-heading)] mb-1">وصف مطابقة التركيبة والمكونات</label>
                        <input
                          value={giftNote}
                          onChange={(e) => setGiftNote(e.target.value)}
                          placeholder="بنفس مكونات وتركيبة العطر الأساسي..."
                          className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] px-3 py-2 text-xs text-[var(--hub-text)]"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Linked Similar Alternatives Picker (Strict Perfume-Only for Perfumes) */}
                <div className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)] p-4 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-bold text-[var(--hub-heading)] flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-[var(--hub-accent)]" />
                      <span>
                        {category === 'perfumes'
                          ? 'ربط عطور مشابهة يدوياً (عطور فقط · مستبعد السبراي والمعطرات · حتى 3)'
                          : 'ربط بدائل مشابهة مفضلة يدوياً (اختياري · حتى 3 منتجات)'}
                      </span>
                    </span>
                    <span className="text-[11px] text-[var(--hub-muted)] tabular-nums">
                      المختار: {linkedAltIds.length}/3
                    </span>
                  </div>
                  <div className="max-h-32 overflow-y-auto flex flex-wrap gap-1.5">
                    {products
                      .filter((p) => {
                        if (p.id === editing?.id) return false;
                        if (category === 'perfumes') {
                          return p.category === 'perfumes' && !isSprayOrNonPerfumeProduct(p);
                        }
                        return p.category === category;
                      })
                      .map((candidate) => {
                        const selected = linkedAltIds.includes(candidate.id);
                        return (
                          <button
                            key={candidate.id}
                            type="button"
                            onClick={() => toggleLinkedAlt(candidate.id)}
                            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs cursor-pointer transition-colors ${
                              selected
                                ? 'border-[var(--hub-accent)] bg-[var(--hub-button)] text-[var(--hub-button-text)] font-semibold'
                                : 'border-[var(--hub-border)] bg-[var(--hub-surface)] text-[var(--hub-text)] hover:border-[var(--hub-accent-soft)]'
                            }`}
                          >
                            {selected && <CheckCircle2 className="w-3 h-3 shrink-0" />}
                            <span>{candidate.nameAr}</span>
                          </button>
                        );
                      })}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[var(--hub-heading)] mb-1">حالة التوفر العامة</label>
                    <input
                      value={availability}
                      onChange={(e) => setAvailability(e.target.value)}
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[var(--hub-heading)] mb-1">رابط الصفحة الرسمية</label>
                    <input
                      dir="ltr"
                      type="url"
                      value={sourceUrl}
                      onChange={(e) => setSourceUrl(e.target.value)}
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-semibold text-[var(--hub-heading)]">تعليمات الاستخدام</label>
                      {editing && (
                        <button
                          type="button"
                          disabled={regenFieldKey !== null}
                          onClick={() => handleRegenerateFieldInline('usageInstructions')}
                          className="text-[11px] text-[var(--hub-accent)] hover:underline cursor-pointer"
                        >
                          {regenFieldKey === 'usageInstructions' ? '...' : '✨ توليد'}
                        </button>
                      )}
                    </div>
                    <input
                      value={usageInstructions}
                      onChange={(e) => setUsageInstructions(e.target.value)}
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <label className="text-xs font-semibold text-[var(--hub-heading)]">معلومات إضافية</label>
                      {editing && (
                        <button
                          type="button"
                          disabled={regenFieldKey !== null}
                          onClick={() => handleRegenerateFieldInline('extraInfo')}
                          className="text-[11px] text-[var(--hub-accent)] hover:underline cursor-pointer"
                        >
                          {regenFieldKey === 'extraInfo' ? '...' : '✨ توليد'}
                        </button>
                      )}
                    </div>
                    <input
                      value={extraInfo}
                      onChange={(e) => setExtraInfo(e.target.value)}
                      className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[var(--hub-heading)] mb-1">ملاحظات داخلية</label>
                  <input
                    value={internalNotes}
                    onChange={(e) => setInternalNotes(e.target.value)}
                    className="w-full rounded-lg border border-[var(--hub-border)] bg-[var(--hub-bg)] px-3 py-2 text-sm text-[var(--hub-text)]"
                  />
                </div>

                {editing && manualLocks.length > 0 && (
                  <div className="rounded-xl border border-purple-200 dark:border-purple-800 bg-purple-50/60 dark:bg-purple-950/30 p-3 text-xs space-y-2">
                    <div className="font-bold text-purple-900 dark:text-purple-200 flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5" />
                      <span>الحقول المحمية بالتعديل اليدوي (تستطيع فك قفل أي حقل ليسمح باستكماله بالذكاء الاصطناعي):</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {manualLocks.map((lockedKey) => (
                        <button
                          key={lockedKey}
                          type="button"
                          onClick={() => setManualLocks((prev) => prev.filter((k) => k !== lockedKey))}
                          className="inline-flex items-center gap-1 rounded-lg border border-purple-300 dark:border-purple-700 bg-[var(--hub-surface)] px-2.5 py-1 text-[11px] text-purple-900 dark:text-purple-200 hover:bg-red-50 cursor-pointer"
                          title="انقر لفك القفل اليدوي عن هذا الحقل"
                        >
                          <span>{lockedKey}</span>
                          <X className="w-3 h-3" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* 6 GCC Country Prices Editor */}
                <div className="rounded-xl border border-[var(--hub-border)] bg-[var(--hub-bg)] p-4 space-y-3">
                  <div className="text-xs font-bold text-[var(--hub-heading)]">
                    الأسعار الرسمية لدول الخليج الست (تُحفظ مباشرة في Firestore)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {GCC_COUNTRIES.map((c) => {
                      const row = countryPricesForm[c.code];
                      return (
                        <div key={c.code} className="rounded-lg border border-[var(--hub-border)] bg-[var(--hub-surface)] p-3 space-y-2 text-xs">
                          <div className="flex items-center justify-between font-semibold text-[var(--hub-heading)]">
                            <span>{c.nameAr}</span>
                            <span className="font-mono-tabular text-[11px] text-[var(--hub-accent)]">{c.currency}</span>
                          </div>
                          <div className="grid grid-cols-3 gap-1.5">
                            <input
                              type="number"
                              step="any"
                              dir="ltr"
                              placeholder="السعر"
                              value={row.price}
                              onChange={(e) =>
                                setCountryPricesForm((prev) => ({
                                  ...prev,
                                  [c.code]: { ...prev[c.code], price: e.target.value },
                                }))
                              }
                              className="rounded border border-[var(--hub-border)] bg-[var(--hub-bg)] px-2 py-1.5 text-xs text-[var(--hub-text)]"
                            />
                            <input
                              type="number"
                              step="any"
                              dir="ltr"
                              placeholder="قبل الخصم"
                              value={row.oldPrice}
                              onChange={(e) =>
                                setCountryPricesForm((prev) => ({
                                  ...prev,
                                  [c.code]: { ...prev[c.code], oldPrice: e.target.value },
                                }))
                              }
                              className="rounded border border-[var(--hub-border)] bg-[var(--hub-bg)] px-2 py-1.5 text-xs text-[var(--hub-text)]"
                            />
                            <select
                              value={row.availability}
                              onChange={(e) =>
                                setCountryPricesForm((prev) => ({
                                  ...prev,
                                  [c.code]: {
                                    ...prev[c.code],
                                    availability: e.target.value as EditableCountryPrice['availability'],
                                  },
                                }))
                              }
                              className="rounded border border-[var(--hub-border)] bg-[var(--hub-bg)] px-1.5 py-1.5 text-[11px] text-[var(--hub-text)]"
                            >
                              <option value="in stock">متوفر</option>
                              <option value="out of stock">نفذ</option>
                              <option value="unavailable">غير مدرج</option>
                            </select>
                          </div>
                          <input
                            type="url"
                            dir="ltr"
                            placeholder="رابط المنتج في متجر الدولة (اختياري)"
                            value={row.storeUrl}
                            onChange={(e) =>
                              setCountryPricesForm((prev) => ({
                                ...prev,
                                [c.code]: { ...prev[c.code], storeUrl: e.target.value },
                              }))
                            }
                            className="w-full rounded border border-[var(--hub-border)] bg-[var(--hub-bg)] px-2 py-1 text-[11px] text-[var(--hub-text)]"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="flex justify-end gap-2.5 pt-2">
                  <button
                    type="button"
                    onClick={() => setModalOpen(false)}
                    className="px-4 py-2 text-sm rounded-lg border border-[var(--hub-border)] text-[var(--hub-text)] cursor-pointer"
                  >
                    إلغاء
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-5 py-2 text-sm font-semibold rounded-lg bg-[var(--hub-button)] text-[var(--hub-button-text)] hover:bg-[var(--hub-button-hover)] cursor-pointer disabled:opacity-55"
                  >
                    {saving ? 'جاري الحفظ...' : 'حفظ التغييرات'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="حذف منتج"
        description={`هل أنت متأكد من حذف «${deleteTarget?.nameAr}» من دليل المنتجات؟`}
        confirmLabel="نعم، حذف"
        loading={saving}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {isAdmin && (
        <>
          <AiEnrichmentModal
            open={aiModalOpen}
            products={products}
            initialScope={aiInitialScope}
            initialProduct={aiInitialProduct}
            selectedProductIds={batchSelectedIds}
            onClose={() => setAiModalOpen(false)}
            onNotify={notify}
            onRunTrackedMutation={runTrackedMutation}
            onSavedProduct={() => {
              setUndoVersion((v) => v + 1);
            }}
          />

          <CatalogHealthModal
            open={healthModalOpen}
            initialTab={healthInitialTab}
            products={products}
            auditLogs={auditLogs}
            isSensitiveAdmin={isSensitiveAdmin}
            onClose={() => setHealthModalOpen(false)}
            onOpenDetails={(p) => setDetailProduct(p)}
            onEdit={openEdit}
            onNotify={notify}
            onRunTrackedMutation={runTrackedMutation}
          />
        </>
      )}
    </div>
  );
}
